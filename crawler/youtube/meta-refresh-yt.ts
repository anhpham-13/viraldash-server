import { getDb, ensureIndexes, findViralSeeds, pushSnapshot } from "../../shared/db/index.js";
import { env } from "../src/config/env.js";
import type { RawCrawlerRecord } from "../../shared/types/index.js";
import type { RefreshSeed } from "../src/core/meta-refresh-base.js";

// ─── YouTube batch fetcher ────────────────────────────────────────────────────
//
// YouTube Data API supports up to 50 ids per request.
// We pre-fetch ALL seeds in batches first, then push snapshots individually.
// This is more efficient than the per-video fetch pattern used by TikTok/IG.

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function batchFetchYt(
  ids: string[],
  apiKey: string,
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const batches = chunk(ids, 50);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        console.warn(`[YtRefresh] API error batch ${i + 1}: ${res.status} ${res.statusText}`);
        await sleep(1_500);
        continue;
      }

      const data = await res.json() as { items?: any[] };
      for (const item of data.items ?? []) {
        const id = String(item?.id ?? "").trim();
        if (id) result.set(id, item);
      }

      console.log(`[YtRefresh] Batch ${i + 1}/${batches.length}: received ${data.items?.length ?? 0} items`);
    } catch (err: any) {
      console.warn(`[YtRefresh] Batch ${i + 1} fetch failed: ${(err as Error).message}`);
    }

    if (i < batches.length - 1) await sleep(env.batchDelayMs);
  }

  return result;
}

function toRawRecord(seed: RefreshSeed, item: any): RawCrawlerRecord {
  const now = new Date();
  const title = item.snippet?.title ? String(item.snippet.title).trim() : "";
  return {
    video_id:     seed.video_id,
    platform:     "YouTube_Shorts",
    url:          seed.url,
    published_at: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : now,
    author:       String(item.snippet?.channelTitle || seed.author || "YouTube").trim(),
    ...(title && { title }),
    hashtags:     Array.isArray(item.snippet?.tags) ? (item.snippet.tags as string[]) : [],
    view_count:   Number(item.statistics?.viewCount) || 0,
    likes:        Number(item.statistics?.likeCount)  || 0,
    comments:     Number(item.statistics?.commentCount) || 0,
    shares:       0,
    saves:        Number(item.statistics?.favoriteCount) || 0,
    fetched_at:   now,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY ?? process.env.YT_DATA_API_KEY ?? "";
  if (!apiKey) throw new Error("Missing YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY");

  // MongoDB init
  const db = await getDb();
  await ensureIndexes(db);

  // Find seeds not refreshed within the last refreshIntervalHours
  const seeds = await findViralSeeds(
    "YouTube_Shorts",
    env.refreshMaxAgeHours,
    env.refreshIntervalHours,
  );

  if (seeds.length === 0) {
    console.log("[YtRefresh] No stale seeds to refresh.");
    return;
  }

  console.log(`[YtRefresh] Refreshing ${seeds.length} YouTube Shorts…`);

  // Pre-fetch all in batches (one round-trip per 50 videos)
  const freshById = await batchFetchYt(seeds.map(s => s.video_id), apiKey);

  let refreshed = 0;
  let failed    = 0;

  for (const seed of seeds) {
    const item = freshById.get(seed.video_id);
    if (!item) {
      console.warn(`[YtRefresh] No API data for ${seed.video_id} — skipping`);
      failed++;
      continue;
    }

    const fresh = toRawRecord(seed, item);
    try {
      await pushSnapshot(seed.video_id, seed.platform, fresh);
      refreshed++;
      console.log(`[YtRefresh] ✓ ${seed.video_id}  views=${fresh.view_count}`);
    } catch (err: any) {
      console.warn(`[YtRefresh] pushSnapshot failed ${seed.video_id}: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`[YtRefresh] Done — refreshed=${refreshed} failed=${failed}`);
}

run().catch(err => { console.error(err); process.exitCode = 1; });
