import { pushSnapshot } from "../../../shared/db/index.js";
import type { Platform, RawCrawlerRecord } from "../../../shared/types/index.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RefreshSeed {
  video_id: string;
  platform: Platform;
  url:      string;
  author:   string;
}

export interface MetaRefreshOpts {
  /** Parallel fetch workers. Default 1 (safe for browser-based fetchers). */
  concurrency?: number;
  /**
   * Base delay between requests in ms (actual delay = delayMs + random 0–50%).
   * Defaults to 1 200 ms.
   */
  delayMs?: number;
  /** Retry a failed fetch once before giving up. Default true. */
  retryOnce?: boolean;
}

export interface MetaRefreshResult {
  total:     number;
  refreshed: number;
  failed:    number;
}

// ─── runMetaRefresh ───────────────────────────────────────────────────────────
//
// Core of Loop 2 (metadata refresh). Accepts a pre-fetched seed list and a
// platform-specific fetchFresh() callback, then:
//   1. Calls fetchFresh(seed) with optional retry.
//   2. Calls pushSnapshot() to persist the fresh data to MongoDB.
//
// Callers are responsible for:
//   • Building seeds via findViralSeeds() with the appropriate minStaleHours.
//   • Implementing fetchFresh() to return a RawCrawlerRecord or null.
//
// Concurrency is handled via a shared index pool, so workers never race.

export async function runMetaRefresh(
  seeds:      RefreshSeed[],
  fetchFresh: (seed: RefreshSeed) => Promise<RawCrawlerRecord | null>,
  opts:       MetaRefreshOpts = {},
): Promise<MetaRefreshResult> {
  const {
    concurrency = 1,
    delayMs     = 1_200,
    retryOnce   = true,
  } = opts;

  const total = seeds.length;
  let refreshed = 0;
  let failed    = 0;
  let idx       = 0;

  const worker = async (): Promise<void> => {
    while (idx < seeds.length) {
      const seed = seeds[idx++]!;

      let fresh: RawCrawlerRecord | null = null;
      try {
        fresh = await fetchFresh(seed);
        if (!fresh && retryOnce) {
          await delay(delayMs);
          fresh = await fetchFresh(seed);
        }
      } catch (err: any) {
        console.warn(`[MetaRefresh] fetchFresh error ${seed.video_id}: ${(err as Error).message}`);
      }

      if (!fresh) {
        failed++;
        console.warn(`[MetaRefresh] No data for ${seed.platform}/${seed.video_id} — skipping`);
        continue;
      }

      try {
        await pushSnapshot(seed.video_id, seed.platform, fresh);
        refreshed++;
        console.log(`[MetaRefresh] ✓ ${seed.platform}/${seed.video_id}`);
      } catch (err: any) {
        failed++;
        console.warn(`[MetaRefresh] pushSnapshot error ${seed.video_id}: ${(err as Error).message}`);
      }

      // Human-like delay between requests
      if (idx < seeds.length) {
        await delay(delayMs + Math.random() * delayMs * 0.5);
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, seeds.length || 1) }, worker);
  await Promise.all(pool);

  console.log(`[MetaRefresh] Done — total=${total} refreshed=${refreshed} failed=${failed}`);
  return { total, refreshed, failed };
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
