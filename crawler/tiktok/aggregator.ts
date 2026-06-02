import fs from "node:fs";
import readline from "node:readline";
import { resolve } from "node:path";
import type { IVideoRecordCandidate, IYouTubeVideoScored } from "../src/core/types.js";
import { withViralMetrics } from "../src/core/viral.calc.js";
import { env } from "./config/env.js";

export async function runAggregator() {
  const INPUT_FILE = resolve(process.cwd(), "output_json", "tiktok_candidates.jsonl");
  const OUTPUT_FILE = resolve(process.cwd(), "output_json", "tiktok_viral_tt.jsonl");

  if (!fs.existsSync(INPUT_FILE)) {
    console.warn(`[aggregator] Input file not found: ${INPUT_FILE}. Run normalize stage first.`);
    return;
  }

  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: "w" });
  let totalCandidates = 0;
  let viralCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  const viralThreshold = env.viralScoreThreshold || 90;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const candidate = JSON.parse(line) as IVideoRecordCandidate;
      totalCandidates++;

      const scored = withViralMetrics(candidate as any);

      if (scored.viral_score >= viralThreshold) {
        stream.write(JSON.stringify(scored) + "\n");
        viralCount++;
      }
    } catch (e) {
      console.warn(`[aggregator] Failed to parse a candidate line`, e);
    }
  }

  stream.end();
  console.log(`[aggregator] Aggregation complete!`);
  console.log(`[aggregator] Total candidates evaluated: ${totalCandidates}`);
  console.log(`[aggregator] Viral videos found: ${viralCount} (threshold: ${viralThreshold})`);
  console.log(`[aggregator] Viral videos saved to: ${OUTPUT_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("aggregator.ts")) {
  runAggregator().catch(console.error);
}
