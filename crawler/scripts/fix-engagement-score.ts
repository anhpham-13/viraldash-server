/**
 * One-time migration: recalculates engagement_score for documents where
 * TikTok API returned saves/likes/comments as strings instead of numbers,
 * causing JS string-concatenation to produce absurd values (e.g. 2007606%).
 *
 * Usage:
 *   tsx crawler/scripts/fix-engagement-score.ts                  # dry-run
 *   tsx crawler/scripts/fix-engagement-score.ts --apply          # write to MongoDB
 *   tsx crawler/scripts/fix-engagement-score.ts --apply --platform=TikTok
 */

import "dotenv/config";
import { getDb, closeDb } from "../../shared/db/index.js";
import type { VideoDocument } from "../../shared/types/index.js";
import { COL } from "../../shared/db/collections.js";

const args    = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");
const PLATFORM = args.find(a => a.startsWith("--platform="))?.split("=")[1];

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function recomputeEngagement(doc: VideoDocument): number {
  const views = n(doc.view_count);
  if (views <= 0) return 0;
  return +( ((n(doc.likes) + n(doc.comments) + n(doc.saves)) / views) * 100 ).toFixed(2);
}

async function run() {
  const db  = await getDb();
  const col = db.collection<VideoDocument>(COL.VIDEOS);

  const filter = PLATFORM ? { platform: PLATFORM } : {};
  const total  = await col.countDocuments(filter);
  console.log(`[fix-er] Found ${total} documents (platform=${PLATFORM ?? "all"})`);
  console.log(`[fix-er] Mode: ${DRY_RUN ? "DRY-RUN (pass --apply to write)" : "APPLY"}`);

  const cursor = col.find(filter, {
    projection: { _id: 1, video_id: 1, platform: 1, view_count: 1, likes: 1, comments: 1, saves: 1, engagement_score: 1 },
  });

  const BATCH = 500;
  let   ops: Parameters<typeof col.bulkWrite>[0] = [];
  let   scanned = 0, patched = 0, skipped = 0;

  for await (const doc of cursor) {
    scanned++;
    const correct = recomputeEngagement(doc);
    const stored  = doc.engagement_score ?? 0;

    // Only update when the stored value differs (beyond float rounding)
    if (Math.abs(correct - stored) < 0.005) {
      skipped++;
      continue;
    }

    console.log(
      `  ${doc.platform}/${doc.video_id}: ${stored.toFixed(2)}% → ${correct.toFixed(2)}%`
    );

    if (!DRY_RUN) {
      ops.push({
        updateOne: {
          filter: { _id: (doc as any)._id },
          update: { $set: { engagement_score: correct } },
        },
      });
    }

    patched++;

    if (!DRY_RUN && ops.length >= BATCH) {
      await col.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }

  if (!DRY_RUN && ops.length > 0) {
    await col.bulkWrite(ops, { ordered: false });
  }

  console.log(`\n[fix-er] Done — scanned=${scanned} patched=${patched} skipped=${skipped}`);
  if (DRY_RUN && patched > 0) {
    console.log("[fix-er] Re-run with --apply to write changes.");
  }
}

run()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => closeDb());
