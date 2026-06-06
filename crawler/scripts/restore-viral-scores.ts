/**
 * One-time migration: restores viral_score for documents incorrectly zeroed by
 * the upsertVideo re-discovery bug (old lifetime-average vph dropping below gate).
 *
 * Strategy: for every document with viral_score = 0 that has at least one snapshot
 * with a non-zero viral_score, set the document viral_score to the last snapshot's
 * viral_score. Snapshots store the score as computed at that point in time and are
 * never overwritten, so they are the reliable source of truth.
 *
 * Usage:
 *   tsx crawler/scripts/restore-viral-scores.ts              # dry-run (default)
 *   tsx crawler/scripts/restore-viral-scores.ts --apply      # write to MongoDB
 */

import { getDb, ensureIndexes } from "../../shared/db/index.js";
import { COL } from "../../shared/db/collections.js";

const DRY_RUN = !process.argv.includes("--apply");

async function run(): Promise<void> {
  const db = await getDb();
  await ensureIndexes(db);
  const col = db.collection(COL.VIDEOS);

  // Find zeroed documents that have snapshots with non-zero score
  const cursor = col.find(
    { viral_score: 0, "snapshots.0": { $exists: true } },
    { projection: { _id: 1, video_id: 1, platform: 1, snapshots: 1 } },
  );

  let checked = 0;
  let restored = 0;

  for await (const doc of cursor) {
    checked++;
    const snaps: Array<{ viral_score: number }> = doc.snapshots ?? [];
    // Find the highest non-zero score across snapshots (peak score)
    let bestScore = 0;
    for (const s of snaps) {
      if (s.viral_score > bestScore) bestScore = s.viral_score;
    }

    if (bestScore === 0) continue;

    console.log(
      `[restore] ${doc.platform} ${doc.video_id}: 0 → ${bestScore}${DRY_RUN ? " (dry-run)" : ""}`,
    );

    if (!DRY_RUN) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { viral_score: bestScore } },
      );
    }
    restored++;
  }

  console.log(
    `\nDone — checked=${checked} restored=${restored}${DRY_RUN ? " (dry-run — rerun with --apply to commit)" : ""}`,
  );

  process.exit(0);
}

run().catch(err => { console.error(err); process.exitCode = 1; });
