/**
 * Sync hashtags from MongoDB videos → hashtags collection.
 * Reads videos published within the last 48h per platform,
 * computes trending scores, and upserts results.
 *
 * Usage:
 *   tsx crawler/scripts/sync-hashtags.ts                  # all platforms
 *   tsx crawler/scripts/sync-hashtags.ts --platform=TikTok
 *   tsx crawler/scripts/sync-hashtags.ts --platform=YouTube_Shorts
 *   tsx crawler/scripts/sync-hashtags.ts --platform=Instagram_Reels
 */

import "dotenv/config";
import { syncHashtagsFromVideos, closeDb } from "../../shared/db/index.js";
import type { Platform } from "../../shared/types/index.js";

const ALL_PLATFORMS: Platform[] = ["TikTok", "YouTube_Shorts", "Instagram_Reels"];

const args = process.argv.slice(2);
const platformArg = args.find(a => a.startsWith("--platform="))?.split("=")[1] as Platform | undefined;

const platforms = platformArg ? [platformArg] : ALL_PLATFORMS;

async function run() {
  let total = 0;
  for (const platform of platforms) {
    const count = await syncHashtagsFromVideos(platform);
    total += count;
  }
  console.log(`\n[sync-hashtags] Done — ${total} total hashtag records written.`);
}

run()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => closeDb());
