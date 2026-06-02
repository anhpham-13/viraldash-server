import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral.calc.js";
import { env } from "../src/config/env.js";

const ID_FILTER_FILE = resolve(process.cwd(), "data/youtube/id_filter_yt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const LEGACY_TOTAL_FILE = resolve(process.cwd(), "data/total_video.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/youtube/viral_vids_yt.jsonl");

function chunk<T>(array: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

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

async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const filePath of [TOTAL_FILE, LEGACY_TOTAL_FILE]) {
    if (!existsSync(filePath)) continue;

    const rows = await readJsonLines<any>(filePath);
    for (const row of rows) {
      if (row && row.id) ids.add(String(row.id).trim());
    }
  }

  return ids;
}

export async function runProcessIdFilterToTotal(): Promise<void> {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY || process.env.YT_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY in env");
  }

  if (!existsSync(ID_FILTER_FILE)) {
    throw new Error(`Input file not found: ${ID_FILTER_FILE}`);
  }

  const rows = await readJsonLines<any>(ID_FILTER_FILE);
  const idsToCall: string[] = [];
  const urlById = new Map<string, string>();

  console.log(`Loaded ${rows.length} queued ids from id_filter.`);

  for (const row of rows) {
    const id = String(row?.id ?? row?.videoId ?? row?.video_id ?? "").trim();
    if (!id) continue;
    if (urlById.has(id)) continue;

    urlById.set(id, row?.url || `https://www.youtube.com/shorts/${id}`);
    idsToCall.push(id);
  }

  if (idsToCall.length === 0) {
    console.log("No ids found to call API for.");
    return;
  }

  console.log(`Calling YouTube API for ${idsToCall.length} ids in batches of 50.`);

  const batches = chunk(idsToCall, 50);
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!;
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`YouTube API error: ${response.status} ${response.statusText}`);
        if (body) {
          console.error(body);
        }
        await sleep(1500);
        continue;
      }

      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];

      const batchSet = new Set<string>(batch.map((id) => String(id).trim()));

      const batchReturned = new Set<string>();
      for (const item of items) {
        const id = String(item?.id ?? "").trim();
        if (!id) continue;

        batchReturned.add(id);
        const published_at = item.snippet?.publishedAt || new Date().toISOString();
        const tags = Array.isArray(item.snippet?.tags) ? item.snippet.tags : [];
        const view_count = Number(item.statistics?.viewCount) || 0;
        const likes = Number(item.statistics?.likeCount) || 0;
        const comments = Number(item.statistics?.commentCount) || 0;
        const favorites = Number(item.statistics?.favoriteCount) || 0;

        // Structured strictly to match docs/request.md PRD Schema
        const record = {
          video_id: id,
          platform: "YouTube_Shorts",
          published_at,
          tags,
          view_count,
          // Store raw stats so withViralMetrics can compute engagement_score
          likes,
          comments,
          favorites,
          url: urlById.get(id) || `https://www.youtube.com/shorts/${id}`,
          fetchedAt: new Date().toISOString(),
          // Include partial raw dumps for debugging if needed, but primary fields are flattened above
          snippet: filterSnippet(item.snippet) || {},
          statistics: item.statistics || {},
        };

        appendFileSync(TOTAL_FILE, `${JSON.stringify(record)}\n`, "utf8");
      }

      // Remove requested ids (the whole batch) from id_filter once API succeeds
      const currentRows = await readJsonLines<any>(ID_FILTER_FILE);
      const remaining = currentRows.filter((row) => !batchSet.has(String(row?.id ?? "").trim()));
      await writeJsonLines(ID_FILTER_FILE, remaining);

      console.log(`Batch ${index + 1}/${batches.length} wrote ${batchReturned.size} records to ${TOTAL_FILE} (requested ${batchSet.size} ids)`);
    } catch (error: any) {
      console.error(`Batch ${index + 1} failed: ${error.message}`);
    }

    await sleep(1200);
  }

  const totalRows = existsSync(TOTAL_FILE) ? await readJsonLines<any>(TOTAL_FILE) : [];
  const nowMs = Date.now();
  const viralRows = totalRows
    .filter((row) => {
      const postMs = new Date(row.published_at || row.postDate || row.fetchedAt || Date.now()).getTime();
      if (!Number.isFinite(postMs)) return false;
      return (nowMs - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24;
    })
    .map((row) => withViralMetrics(row))
    .filter((row) => row.viral_score >= env.viralScoreThreshold)
    .sort((a, b) => b.viral_score - a.viral_score);

  await writeJsonLines(VIRAL_FILE, viralRows);
  console.log(`Wrote ${viralRows.length} viral records to ${VIRAL_FILE}`);
  console.log("Done.");
}

// ─── Entrypoint guard (standalone CLI) ───────────────────────────────────────
runProcessIdFilterToTotal().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
