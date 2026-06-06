import { runGoogleWorker } from "./google.worker.js";
import { runFilterGoogleIds } from "./filter-google-ids-tt.js";
import { runProcessIdFilterToTotal } from "./process-id-filter-to-total-tt.js";
import { runSearchPipeline } from "./gg-advanced-search-scraper.js";
import { runRapidWorker } from "./rapid.worker.js";
import { syncHashtagsFromVideos } from "../../shared/db/index.js";

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`[Pipeline] ✓ ${name}`);
  } catch (err: any) {
    console.error(`[Pipeline] ✗ ${name} failed — skipping: ${err?.message ?? err}`);
  }
}

async function main() {
  console.log("Starting TikTok Full Pipeline...");

  await runStep("Stage 1: GoogleWorker (Serper API Discovery)", runGoogleWorker);
  await runStep("Stage 2: Filter Google IDs", runFilterGoogleIds);
  await runStep("Stage 3: Process ID Filter (Playwright Enricher)", runProcessIdFilterToTotal);
  await runStep("Stage 4: Advanced Search Scraper (Browser Discovery)", runSearchPipeline);
  await runStep("Stage 5: Filter Google IDs", runFilterGoogleIds);
  await runStep("Stage 6: RapidWorker (RapidAPI Enricher)", runRapidWorker);
  await runStep("Stage 7: Process ID Filter (Playwright Fallback)", runProcessIdFilterToTotal);
  await runStep("Stage 8: Sync Hashtags to MongoDB", () => syncHashtagsFromVideos("TikTok").then(() => { }));

  console.log("\nTikTok Pipeline complete!");
}

main().catch((error) => {
  console.error("Pipeline failed:", error);
  process.exitCode = 1;
});

