import { runRapidWorker } from "./rapid.worker.js";
import { runGoogleWorker } from "./google.worker.js";
import { runNormalize } from "./normalize.js";
import { runAggregator } from "./aggregator.js";

async function main() {
  console.log("Starting TikTok Pipeline...");
  
  console.log("\n--- Stage 1: RapidWorker ---");
  await runRapidWorker();
  
  console.log("\n--- Stage 2: GoogleWorker ---");
  await runGoogleWorker();

  console.log("\n--- Stage 3: Normalize ---");
  await runNormalize();

  console.log("\n--- Stage 4: Aggregate ---");
  await runAggregator();

  console.log("\nTikTok Pipeline complete!");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("tiktok/index.ts")) {
  main().catch((error) => {
    console.error("Pipeline failed:", error);
    process.exitCode = 1;
  });
}
