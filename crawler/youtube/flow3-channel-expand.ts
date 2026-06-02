/**
 * Flow 3 — Channel ID Expansion
 *
 * Pipeline:
 *   process_ssr  →  filter-google-ids  →  process-id-filter-to-total
 *
 * Usage:
 *   npm run flow:channel-expand
 *
 * What it does:
 *   1. Reads all channel IDs already discovered in data/youtube/total_vids_yt.jsonl.
 *   2. Fetches each channel's YouTube RSS feed to find new shorts published in
 *      the last 24 hours.
 *   3. Queues new IDs through the standard filter → API enrichment → viral
 *      scoring pipeline.
 *
 * This is the fastest & cheapest flow — no API quota cost for step 1.
 */

import "dotenv/config";
import { runProcessSsr } from "./process_ssr.js";
import { runFilterGoogleIds } from "./filter-google-ids.js";
import { runProcessIdFilterToTotal } from "./process-id-filter-to-total.js";

const FLOW_NAME = "Flow 3 — Channel ID Expansion";

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

  // ── Step 1: RSS-feed scraper across all known channel IDs ─────────────────
  step(1, 3, "Process SSR (Channel RSS feeds)  →  data/youtube/raw_google_output_yt.jsonl");
  await runProcessSsr();

  // ── Step 2: De-duplicate & Queue ──────────────────────────────────────────
  step(2, 3, "Filter Google IDs  →  data/youtube/id_filter_yt.jsonl");
  await runFilterGoogleIds();

  // ── Step 3: YouTube Data API enrichment + viral scoring ───────────────────
  step(3, 3, "Process ID Filter  →  data/youtube/total_vids_yt.jsonl + youtube/viral_vids_yt.jsonl");
  await runProcessIdFilterToTotal();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  banner(`✅ ${FLOW_NAME} complete  (${elapsed}s)`);
}

main().catch((err: unknown) => {
  console.error("\n❌ Flow 3 failed:", err);
  process.exitCode = 1;
});
