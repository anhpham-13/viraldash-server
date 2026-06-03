import { runGoogleWorker } from "./google.worker.js";
import { runFilterGoogleIds } from "./filter-google-ids-tt.js";
import { runProcessIdFilterToTotal } from "./process-id-filter-to-total-tt.js";
import { runSearchPipeline } from "./gg-advanced-search-scraper.js";
import { runRapidWorker } from "./rapid.worker.js";

async function main() {
  console.log("Starting TikTok Full Pipeline...");
  
  console.log("\n--- Stage 1: GoogleWorker (Serper API Discovery) ---");
  await runGoogleWorker();

  console.log("\n--- Stage 2: Filter Google IDs ---");
  await runFilterGoogleIds();

  console.log("\n--- Stage 3: Process ID Filter (Playwright Enricher) ---");
  await runProcessIdFilterToTotal();

  console.log("\n--- Stage 4: Advanced Search Scraper (Browser Discovery) ---");
  await runSearchPipeline();

  console.log("\n--- Stage 5: Filter Google IDs ---");
  await runFilterGoogleIds();

  console.log("\n--- Stage 6: RapidWorker (RapidAPI Enricher) ---");
  await runRapidWorker();

  console.log("\n--- Stage 7: Process ID Filter (Playwright Enricher Fallback) ---");
  await runProcessIdFilterToTotal();

  console.log("\nTikTok Pipeline complete!");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("tiktok/index.ts")) {
  main().catch((error) => {
    console.error("Pipeline failed:", error);
    process.exitCode = 1;
  });
}
