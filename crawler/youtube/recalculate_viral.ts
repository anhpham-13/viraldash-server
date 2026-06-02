import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral.calc.js";
import { env } from "../src/config/env.js";

const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/youtube/viral_vids_yt.jsonl");

async function run() {
  const totalRows = existsSync(TOTAL_FILE) ? await readJsonLines<any>(TOTAL_FILE) : [];
  const nowMs = Date.now();
  const viralRows = totalRows
    .filter((row) => {
      const postMs = new Date(row.published_at || row.postDate || row.fetchedAt || Date.now()).getTime();
      if (!Number.isFinite(postMs)) return false;
      return (nowMs - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24;
    })
    .map((row) => withViralMetrics(row))
    .filter((row) => row.viral_score >= env.viralScoreThreshold)
    .sort((a, b) => b.viral_score - a.viral_score);

  await writeJsonLines(VIRAL_FILE, viralRows);
  console.log(`Wrote ${viralRows.length} viral records to ${VIRAL_FILE}`);
}

run().catch(console.error);
