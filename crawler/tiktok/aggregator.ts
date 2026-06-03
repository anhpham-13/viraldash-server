import fs from "node:fs";
import readline from "node:readline";
import { resolve } from "node:path";
import { withViralMetrics } from "../src/core/viral.calc.js";
import { env } from "./config/env.js";

export async function runAggregator() {
  const INPUT_FILE = resolve(process.cwd(), "data/tiktok/total_vids_tt.jsonl");
  const OUTPUT_FILE = resolve(process.cwd(), "data/tiktok/viral_vids_tt.jsonl");

  if (!fs.existsSync(INPUT_FILE)) {
    console.warn(`[aggregator] Input file not found: ${INPUT_FILE}. Run enricher or rapid worker first.`);
    return;
  }

  // Chế độ "w" sẽ ghi đè file cũ để tạo bảng xếp hạng mới nhất dựa trên file total
  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: "w" });
  let totalCandidates = 0;
  let viralCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE),
    crlfDelay: Infinity,
  });

  const viralThreshold = env.viralScoreThreshold || 90;
  const maxAgeHours = (env.maxVideoAgeDays || 30) * 24;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      totalCandidates++;

      const postMs = new Date(record.postDate || record.fetchedAt || new Date().toISOString()).getTime();
      
      // Tính tuổi của video (tính theo giờ)
      const ageHours = (Date.now() - postMs) / 3_600_000;

      // Kiểm tra độ tuổi video có trong giới hạn cho phép không
      if (Number.isFinite(postMs) && ageHours <= maxAgeHours) {
        // Tính toán lại điểm viral với công thức chuẩn
        const scored = withViralMetrics(record);

        if (scored.viral_score >= viralThreshold) {
          stream.write(JSON.stringify(scored) + "\n");
          viralCount++;
        }
      }
    } catch (e) {
      console.warn(`[aggregator] Failed to parse a candidate line`, e);
    }
  }

  stream.end();
  console.log(`[aggregator] Aggregation complete!`);
  console.log(`[aggregator] Total candidates evaluated: ${totalCandidates}`);
  console.log(`[aggregator] Viral videos found: ${viralCount} (threshold: ${viralThreshold}, max age: ${env.maxVideoAgeDays} days)`);
  console.log(`[aggregator] Viral videos saved to: ${OUTPUT_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("aggregator.ts")) {
  runAggregator().catch(console.error);
}
