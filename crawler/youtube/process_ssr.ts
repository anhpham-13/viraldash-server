/// <reference types="node" />

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendJsonLines, readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { createFileBackedSeenIndex, type SeenIndex } from "../src/core/seenIndex.js";

const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const ID_CHANNELS_FILE = resolve(process.cwd(), "data/youtube/idChannels_yt.jsonl");
const RAW_OUTPUT_FILE = resolve(process.cwd(), "data/youtube/raw_google_output_yt.jsonl");
const SEEN_INDEX_DIR = resolve(process.cwd(), "data/seen_index_ssr");

const WORKER_COUNT = 5;
const MAX_AGE_HOURS = 24;
const MIN_VIEWS = 2000;

type TotalVideoRow = {
  id?: string;
  url?: string;
  snippet?: {
    channelId?: string;
    publishedAt?: string;
  };
  channelId?: string;
};

type ChannelRow = {
  id?: string;
  channelId?: string;
};

type FeedEntry = {
  id: string;
  url: string;
  publishedAt: string;
  views: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

function extractVideoId(value: string | undefined | null): string {
  return String(value ?? "").trim();
}

function extractChannelId(row: TotalVideoRow): string {
  return extractVideoId(row?.snippet?.channelId ?? row?.channelId ?? row?.snippet?.channelId);
}

function extractTagValue(xml: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = pattern.exec(xml);
  return match?.[1]?.trim() ?? "";
}

function extractAttributeValue(xml: string, tagName: string, attributeName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*${attributeName}="([^"]+)"[^>]*/?>`, "i");
  const match = pattern.exec(xml);
  return match?.[1]?.trim() ?? "";
}

function extractEntryBlocks(feedXml: string): string[] {
  const entries: string[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(feedXml)) !== null) {
    if (match[1]) {
      entries.push(match[1]);
    }
  }

  return entries;
}

function parseFeedEntries(feedXml: string): FeedEntry[] {
  const nowMs = Date.now();
  const minAgeMs = MAX_AGE_HOURS * 3_600_000;
  const entries = extractEntryBlocks(feedXml);
  const parsed: FeedEntry[] = [];

  for (const entryXml of entries) {
    const videoId = extractVideoId(
      extractTagValue(entryXml, "yt:videoId") || extractTagValue(entryXml, "id").replace(/^yt:video:/i, "")
    );

    if (!videoId) {
      continue;
    }

    const publishedAt = extractTagValue(entryXml, "published");
    const publishedMs = new Date(publishedAt).getTime();

    if (!Number.isFinite(publishedMs)) {
      continue;
    }

    if (nowMs - publishedMs > minAgeMs) {
      continue;
    }

    const viewsRaw = extractAttributeValue(entryXml, "media:statistics", "views");
    const views = Number.parseInt(viewsRaw, 10);

    if (!Number.isFinite(views) || views < MIN_VIEWS) {
      continue;
    }

    const alternateUrl = extractAttributeValue(entryXml, "link", "href");
    parsed.push({
      id: videoId,
      url: alternateUrl || `https://www.youtube.com/shorts/${videoId}`,
      publishedAt: new Date(publishedMs).toISOString(),
      views,
    });
  }

  return parsed;
}

async function buildChannelIdFile(): Promise<string[]> {
  if (!existsSync(TOTAL_FILE)) {
    throw new Error(`Total file not found: ${TOTAL_FILE}`);
  }

  const rows = await readJsonLines<TotalVideoRow>(TOTAL_FILE);
  const uniqueIds = new Set<string>();

  for (const row of rows) {
    const channelId = extractChannelId(row);
    if (channelId) {
      uniqueIds.add(channelId);
    }
  }

  const channelRows = Array.from(uniqueIds)
    .sort()
    .map((channelId) => ({ id: channelId, channelId }));

  await writeJsonLines(ID_CHANNELS_FILE, channelRows);
  console.log(`[process_ssr] Wrote ${channelRows.length} unique channel ids to ${ID_CHANNELS_FILE}`);
  return channelRows.map((row) => row.id as string);
}

async function loadSeenVideoIds(): Promise<SeenIndex> {
  const index = createFileBackedSeenIndex(SEEN_INDEX_DIR, 16);
  if (existsSync(RAW_OUTPUT_FILE)) {
    await index.buildFromExistingFiles([RAW_OUTPUT_FILE]);
  }
  return index;
}

let rawWriteMutex: Promise<void> = Promise.resolve();

async function appendRawRecords(records: Array<{ id: string; url: string; fetchedAt: string }>): Promise<void> {
  if (records.length === 0) {
    return;
  }

  let release: (() => void) | undefined;
  const previous = rawWriteMutex;
  rawWriteMutex = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    await appendJsonLines(RAW_OUTPUT_FILE, records);
  } finally {
    release?.();
  }
}

async function fetchFeed(channelId: string): Promise<string> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "accept-language": "vi,en-US;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "sec-ch-ua": '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    // Log chi tiết trạng thái để dễ debug tầng hệ thống
    throw new Error(`RSS fetch failed for ${channelId}: Status ${response.status} (${response.statusText})`);
  }

  return response.text();
}

async function processChannel(workerId: number, channelId: string, seenIds: SeenIndex): Promise<void> {
  const attemptCount = 3;

  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    try {
      const feedXml = await fetchFeed(channelId);
      const entries = parseFeedEntries(feedXml);
      const freshRecords = [] as Array<{ id: string; url: string; fetchedAt: string }>;
      const fetchedAt = new Date().toISOString();

      for (const entry of entries) {
        if (await seenIds.has(entry.id)) {
          continue;
        }

        await seenIds.register(entry.id);
        freshRecords.push({
          id: entry.id,
          url: entry.url,
          fetchedAt,
        });
      }

      if (freshRecords.length > 0) {
        await appendRawRecords(freshRecords);
        console.log(`[process_ssr][worker ${workerId}] ${channelId}: appended ${freshRecords.length} records`);
      } else {
        console.log(`[process_ssr][worker ${workerId}] ${channelId}: no fresh records matched`);
      }

      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[process_ssr][worker ${workerId}] ${channelId}: attempt ${attempt}/${attemptCount} failed: ${message}`);

      if (attempt === attemptCount) {
        return;
      }

      await sleep(1_500 * attempt);
    }
  }
}

async function main(): Promise<void> {
  const channelIds = await buildChannelIdFile();
  const seenIds = await loadSeenVideoIds();

  // Clear the file to overwrite it for this run
  writeFileSync(RAW_OUTPUT_FILE, "", "utf8");

  if (channelIds.length === 0) {
    console.log("[process_ssr] No channel ids found. Nothing to do.");
    return;
  }

  let nextChannelIndex = 0;
  const workerCount = WORKER_COUNT;
  console.log(`[process_ssr] Dispatching ${channelIds.length} channels across ${workerCount} workers.`);

  const workers = Array.from({ length: workerCount }, (_, workerIndex) => {
    const workerId = workerIndex + 1;

    return (async () => {
      console.log(`[process_ssr][worker ${workerId}] started`);

      while (true) {
        const channelIndex = nextChannelIndex;
        nextChannelIndex += 1;

        if (channelIndex >= channelIds.length) {
          break;
        }

        const channelId = channelIds[channelIndex]!;
        await processChannel(workerId, channelId, seenIds);
        await sleep(400);
      }

      console.log(`[process_ssr][worker ${workerId}] completed`);
    })();
  });

  await Promise.all(workers);

  console.log(`[process_ssr] Done. New eligible videos are appended to ${RAW_OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});