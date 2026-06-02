/**
 * Flow 2 — Hashtag Expansion
 *
 * Pipeline:
 *   extract_hashtags  →  crawl_api_v3_shorts  →  filter-google-ids  →  process-id-filter-to-total
 *
 * Usage:
 *   npm run flow:hashtag-expand
 *
 * Prerequisites:
 *   data/youtube/viral_vids_yt.jsonl must exist (run Flow 1 or Flow 3 first, or have data from a prior run).
 *   API_V3_1 (and optionally API_V3_2) must be set in .env.
 */

import "dotenv/config";
import { runExtractHashtags } from "./extract_hashtags.js";
import { runCrawlApiV3Shorts } from "./crawl_api_v3_shorts.js";
import { runFilterGoogleIds } from "./filter-google-ids.js";
import { runProcessIdFilterToTotal } from "./process-id-filter-to-total.js";

const FLOW_NAME = "Flow 2 — Hashtag Expansion";

function banner(title: string) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(`${line}\n`);
}

function step(index: number, total: number, label: string) {
  console.log(`\n[${index}/${total}] ▶  ${label}`);
  console.log("─".repeat(50));
}

async function main(): Promise<void> {
  banner(`🚀 ${FLOW_NAME}`);
  const startMs = Date.now();

  // ── Step 1: Mine top hashtags from existing viral videos ─────────────────
  step(1, 4, "Extract Hashtags  →  data/youtube/hashtag_yt.json");
  runExtractHashtags(); // sync — reads data/youtube/viral_vids_yt.jsonl

  // ── Step 2: YouTube Search API v3 — query-based discovery ────────────────
  step(2, 4, "Crawl API v3 Shorts  →  data/youtube/raw_google_output_yt.jsonl");
  await runCrawlApiV3Shorts();

  // ── Step 3: De-duplicate & Queue ─────────────────────────────────────────
  step(3, 4, "Filter Google IDs  →  data/youtube/id_filter_yt.jsonl");
  await runFilterGoogleIds();

  // ── Step 4: YouTube Data API enrichment + viral scoring ──────────────────
  step(4, 4, "Process ID Filter  →  data/youtube/total_vids_yt.jsonl + youtube/viral_vids_yt.jsonl");
  await runProcessIdFilterToTotal();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  banner(`✅ ${FLOW_NAME} complete  (${elapsed}s)`);
}

main().catch((err: unknown) => {
  console.error("\n❌ Flow 2 failed:", err);
  process.exitCode = 1;
});
