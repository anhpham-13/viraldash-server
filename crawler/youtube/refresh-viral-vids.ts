import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";
import { env } from "../src/config/env.js";

const VIRAL_FILE = resolve(process.cwd(), "data/youtube/viral_vids_yt.jsonl");
const SEED_FILE = resolve(process.cwd(), "data/youtube/seed_id_viral.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");

function chunk<T>(array: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

// ─── Step 1: Extract video_ids from viral file → seed_id_viral.jsonl ──────────
async function buildSeedFile(): Promise<string[]> {
  if (!existsSync(VIRAL_FILE)) {
    throw new Error(`Viral file not found: ${VIRAL_FILE}`);
  }

  const viralRows = await readJsonLines<any>(VIRAL_FILE);
  const seen = new Set<string>();
  const seeds: { video_id: string; url: string }[] = [];

  for (const row of viralRows) {
    const id = String(row?.video_id ?? row?.id ?? row?.videoId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seeds.push({
      video_id: id,
      url: row?.url || `https://www.youtube.com/shorts/${id}`,
    });
  }

  await writeJsonLines(SEED_FILE, seeds);
  console.log(`Step 1: Wrote ${seeds.length} seed ids to ${SEED_FILE}`);

  return seeds.map((s) => s.video_id);
}

// ─── Step 2: Fetch fresh details from YouTube API ─────────────────────────────
async function fetchFreshDetails(ids: string[], apiKey: string): Promise<Map<string, any>> {
  const urlById = new Map<string, string>();
  const seedRows = await readJsonLines<any>(SEED_FILE);
  for (const row of seedRows) {
    if (row?.video_id) urlById.set(row.video_id, row.url || `https://www.youtube.com/shorts/${row.video_id}`);
  }

  const freshById = new Map<string, any>();
  const batches = chunk(ids, 50);

  console.log(`Step 2: Fetching fresh details for ${ids.length} ids in ${batches.length} batches…`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics,contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`YouTube API error batch ${i + 1}: ${response.status} ${response.statusText}`);
        if (body) console.error(body);
        await sleep(1500);
        continue;
      }

      const data = await response.json();
      const items: any[] = Array.isArray(data.items) ? data.items : [];

      for (const item of items) {
        const id = String(item?.id ?? "").trim();
        if (!id) continue;

        const published_at = item.snippet?.publishedAt || new Date().toISOString();
        const tags = Array.isArray(item.snippet?.tags) ? item.snippet.tags : [];
        const view_count = Number(item.statistics?.viewCount) || 0;
        const likes = Number(item.statistics?.likeCount) || 0;
        const comments = Number(item.statistics?.commentCount) || 0;
        const favorites = Number(item.statistics?.favoriteCount) || 0;

        freshById.set(id, {
          video_id: id,
          platform: "YouTube_Shorts",
          published_at,
          tags,
          view_count,
          likes,
          comments,
          favorites,
          url: urlById.get(id) || `https://www.youtube.com/shorts/${id}`,
          fetchedAt: new Date().toISOString(),
          snippet: filterSnippet(item.snippet) || {},
          statistics: item.statistics || {},
        });
      }

      console.log(`  Batch ${i + 1}/${batches.length}: received ${items.length} records`);
    } catch (err: any) {
      console.error(`  Batch ${i + 1} failed: ${err.message}`);
    }

    if (i < batches.length - 1) await sleep(1200);
  }

  return freshById;
}

// ─── Step 3: Update matching rows in total_vids_yt.jsonl ──────────────────────
async function updateTotalFile(freshById: Map<string, any>): Promise<void> {
  if (!existsSync(TOTAL_FILE)) {
    // No total file yet — write fresh records directly
    const records = Array.from(freshById.values());
    await writeJsonLines(TOTAL_FILE, records);
    console.log(`Step 3: Total file did not exist — wrote ${records.length} records to ${TOTAL_FILE}`);
    return;
  }

  const totalRows = await readJsonLines<any>(TOTAL_FILE);
  let updatedCount = 0;

  const updatedRows = totalRows.map((row) => {
    const id = String(row?.video_id ?? row?.id ?? "").trim();
    if (id && freshById.has(id)) {
      updatedCount++;
      return freshById.get(id);
    }
    return row;
  });

  // Append any ids that were in the seed but not yet in total
  const existingIds = new Set(totalRows.map((r: any) => String(r?.video_id ?? r?.id ?? "").trim()));
  let appendedCount = 0;
  for (const [id, record] of freshById) {
    if (!existingIds.has(id)) {
      updatedRows.push(record);
      appendedCount++;
    }
  }

  await writeJsonLines(TOTAL_FILE, updatedRows);
  console.log(`Step 3: Updated ${updatedCount} existing rows, appended ${appendedCount} new rows in ${TOTAL_FILE}`);
}

// ─── Step 4: Recalculate viral score → overwrite viral_vids_yt.jsonl ──────────
async function recalculateViral(): Promise<void> {
  const totalRows = existsSync(TOTAL_FILE) ? await readJsonLines<any>(TOTAL_FILE) : [];
  const nowMs = Date.now();

  const viralRows = totalRows
    .filter((row) => {
      const postMs = new Date(row.published_at || row.postDate || row.fetchedAt || Date.now()).getTime();
      if (!Number.isFinite(postMs)) return false;
      return (nowMs - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24;
    })
    .map((row) => withViralMetrics(row, "youtube"))
    .filter((row) => row.video_phase !== "rejected")
    .sort((a, b) => b.viral_score - a.viral_score);

  await writeJsonLines(VIRAL_FILE, viralRows);
  console.log(`Step 4: Wrote ${viralRows.length} viral records to ${VIRAL_FILE}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY || process.env.YT_DATA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY in env");
  }

  const ids = await buildSeedFile();

  if (ids.length === 0) {
    console.log("No viral video ids found — nothing to refresh.");
    return;
  }

  const freshById = await fetchFreshDetails(ids, apiKey);

  if (freshById.size === 0) {
    console.log("API returned no records — skipping update.");
    return;
  }

  await updateTotalFile(freshById);
  await recalculateViral();

  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
