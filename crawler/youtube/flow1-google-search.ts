/**
 * Flow 1 — Google Search Discovery
 *
 * Pipeline:
 *   google-shorts-scout  →  filter-google-ids  →  process-id-filter-to-total
 *
 * Usage:
 *   npm run flow:google-search
 */

import "dotenv/config";
import { runSearchPipeline } from "./google-shorts-scout.js";
import { runFilterGoogleIds } from "./filter-google-ids.js";
import { runProcessIdFilterToTotal } from "./process-id-filter-to-total.js";

const FLOW_NAME = "Flow 1 — Google Search Discovery";

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

  // ── Step 1: Google Stealth Scraper ───────────────────────────────────────
  step(1, 3, "Google Shorts Scout  (Playwright + noCaptcha extension)");
  await runSearchPipeline();

  // ── Step 2: De-duplicate & Queue ─────────────────────────────────────────
  step(2, 3, "Filter Google IDs  →  data/youtube/id_filter_yt.jsonl");
  await runFilterGoogleIds();

  // ── Step 3: YouTube Data API enrichment + viral scoring ──────────────────
  step(3, 3, "Process ID Filter  →  data/youtube/total_vids_yt.jsonl + youtube/viral_vids_yt.jsonl");
  await runProcessIdFilterToTotal();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  banner(`✅ ${FLOW_NAME} complete  (${elapsed}s)`);
}

main().catch((err: unknown) => {
  console.error("\n❌ Flow 1 failed:", err);
  process.exitCode = 1;
});
