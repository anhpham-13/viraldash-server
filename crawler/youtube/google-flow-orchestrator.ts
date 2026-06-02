import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readJsonLines, appendJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { calcViralScore } from "../src/core/viral.calc.js";
import { env } from "../src/config/env.js";

const RAW_FILE = resolve(process.cwd(), "data/youtube/raw_google_output_yt.jsonl");
const ID_FILTER_FILE = resolve(process.cwd(), "data/youtube/id_filter_yt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const LEGACY_TOTAL_FILE = resolve(process.cwd(), "data/total_video.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/youtube/viral_vids_yt.jsonl");

function extractVideoId(row: any): string {
  return String(row?.id ?? row?.videoId ?? row?.video_id ?? "").trim();
}

function chunk<T>(array: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function runScout() {
  console.log("Starting Google scout (Playwright + noCaptcha extension). Browser windows will open.");
  const proc = spawnSync("npx", ["tsx", "scratch/google-shorts-scout.ts"], { stdio: "inherit", shell: true });
  if (proc.status !== 0) {
    throw new Error(`Scout failed with exit code ${proc.status}`);
  }
}

async function loadExistingIds(): Promise<Set<string>> {
  const set = new Set<string>();
  if (existsSync(TOTAL_FILE)) {
    const rows = await readJsonLines<any>(TOTAL_FILE);
    for (const r of rows) {
      const id = extractVideoId(r);
      if (id) set.add(id);
    }
  }
  if (existsSync(LEGACY_TOTAL_FILE)) {
    const rows = await readJsonLines<any>(LEGACY_TOTAL_FILE);
    for (const r of rows) {
      const id = extractVideoId(r);
      if (id) set.add(id);
    }
  }
  console.log(`Loaded ${set.size} existing ids from total files.`);
  return set;
}

async function buildFilteredIdFile(existingIds: Set<string>) {
  if (!existsSync(RAW_FILE)) {
    throw new Error(`Raw file not found: ${RAW_FILE}`);
  }

  const raw = await readJsonLines<any>(RAW_FILE);
  const existingQueuedIds = new Set<string>();
  if (existsSync(ID_FILTER_FILE)) {
    const queuedRows = await readJsonLines<any>(ID_FILTER_FILE);
    for (const row of queuedRows) {
      const id = extractVideoId(row);
      if (id) existingQueuedIds.add(id);
    }
  }

  const unique = new Map<string, string>();
  for (const r of raw) {
    const id = extractVideoId(r);
    if (existingIds.has(id)) continue; // skip already known
    if (existingQueuedIds.has(id)) continue;
    if (!unique.has(id)) unique.set(id, r.url || `https://www.youtube.com/shorts/${id}`);
  }

  const items = Array.from(unique.entries()).map(([id, url]) => ({ id, url }));
  if (items.length > 0) {
    await appendJsonLines(ID_FILTER_FILE, items);
  }
  console.log(`Wrote ${items.length} unique new ids to ${ID_FILTER_FILE}`);
  return items.map((it) => it.id);
}

async function callYouTubeApiForIds(ids: string[]) {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY || process.env.YT_DATA_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY not set in env");

  const idBatches = chunk(ids, 50);

  for (let i = 0; i < idBatches.length; i++) {
    const batch = idBatches[i]!;
    console.log(`Calling YouTube API for batch ${i + 1}/${idBatches.length} (${batch.length} ids)`);

    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        console.error(`YouTube API error: ${res.status} ${res.statusText}`);
        await sleep(1500);
        continue;
      }

      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];

      function filterSnippet(snippet: any) {
        if (!snippet || typeof snippet !== "object") return {};
        const s = { ...snippet };
        delete s.thumbnails;
        delete s.localized;
        delete s.liveBroadcastContent;
        delete s.title;
        delete s.description;
        delete s.channelTitle;
        delete s.categoryId;
        delete s.defaultLanguage;
        delete s.defaultAudioLanguage;
        return s;
      }

      function filterContentDetails(cd: any) {
        if (!cd || typeof cd !== "object") return {};
        const c = { ...cd };
        delete c.contentRating;
        delete c.projection;
        delete c.dimension;
        delete c.definition;
        return c;
      }

      const outRecords = items.map((item: any) => ({
        id: String(item.id || "").trim(),
        url: `https://www.youtube.com/shorts/${String(item.id || "").trim()}`,
        snippet: filterSnippet(item.snippet || {}),
        statistics: item.statistics || {},
      }));

      if (outRecords.length > 0) {
        await appendJsonLines(TOTAL_FILE, outRecords);
      }

      // Remove requested ids (the whole batch) from id_filter so they are not retried
      const original = await readJsonLines<any>(ID_FILTER_FILE);
      const batchSet = new Set<string>(batch.map((id) => String(id).trim()));
      const remaining = original.filter((r: any) => !batchSet.has(String(r.id).trim()));
      await writeJsonLines(ID_FILTER_FILE, remaining);

      console.log(`Batch ${i + 1} appended ${outRecords.length} items to ${TOTAL_FILE} (requested ${batchSet.size} ids)`);
    } catch (err: any) {
      console.error(`Batch ${i + 1} failed: ${err.message}`);
    }

    await sleep(1200);
  }
}

async function filterViral() {
  const totalExists = existsSync(TOTAL_FILE);
  if (!totalExists) {
    console.log(`No ${TOTAL_FILE} found, skipping viral filter.`);
    return;
  }

  const records = await readJsonLines<any>(TOTAL_FILE);
  const nowMs = Date.now();
  const maxAgeHours = env.maxVideoAgeDays * 24;

  const viral = records
    .filter((r) => {
      const postMs = new Date(r.postDate || r.fetchedAt || Date.now()).getTime();
      if (!Number.isFinite(postMs)) return false;
      const ageH = (nowMs - postMs) / 3_600_000;
      return ageH <= maxAgeHours;
    })
    .map((r) => ({ ...r, viralScore: calcViralScore(r) }))
    .filter((r) => r.viralScore >= env.viralScoreThreshold)
    .sort((a, b) => b.viralScore - a.viralScore);

  await writeJsonLines(VIRAL_FILE, viral);
  console.log(`Wrote ${viral.length} viral videos to ${VIRAL_FILE}`);
}

async function main() {
  try {
    await runScout();
    const existing = await loadExistingIds();
    const newIds = await buildFilteredIdFile(existing);
    if (newIds.length === 0) {
      console.log("No new ids to call API for.");
      return;
    }

    await callYouTubeApiForIds(newIds);
    await filterViral();
    console.log("Flow complete.");
  } catch (err: any) {
    console.error("Orchestrator failed:", err);
    process.exitCode = 1;
  }
}

if (import.meta.url === (process.argv[1] ? new URL(process.argv[1], `file://${process.cwd()}/`) .href : undefined)) {
  main().catch(console.error);
}
