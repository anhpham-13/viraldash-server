/**
 * Migration: reset viral_acceleration = null for docs with snapshot_count <= 2.
 *
 * Docs at 2 snapshots had acceleration computed as (vNow - 0) = vNow,
 * which is wrong — there was no real previous velocity to diff against.
 * Correct rule: acceleration requires >= 3 snapshots (prevSnap.delta_hours > 0).
 *
 * Usage:
 *   tsx crawler/scripts/fix-accel-snapshot2.ts          # dry-run (no writes)
 *   tsx crawler/scripts/fix-accel-snapshot2.ts --apply  # apply
 */

import 'dotenv/config';
import { getCollection, closeDb } from '../../shared/db/client.js';
import { COL } from '../../shared/db/collections.js';

const apply = process.argv.includes('--apply');

async function main() {
  const col = await getCollection(COL.VIDEOS);

  // Find docs that have wrong acceleration: snapshot_count <= 2 but accel is not null
  const filter = {
    snapshot_count:     { $lte: 2 },
    viral_acceleration: { $ne: null },
  };

  const affected = await col.countDocuments(filter);
  console.log(`[fix-accel] Docs with snapshot_count <= 2 and non-null acceleration: ${affected}`);

  if (affected === 0) {
    console.log('[fix-accel] Nothing to fix.');
    return;
  }

  if (!apply) {
    console.log('[fix-accel] Dry-run — pass --apply to write changes.');
    return;
  }

  const result = await col.updateMany(filter, { $set: { viral_acceleration: null } });
  console.log(`[fix-accel] Updated ${result.modifiedCount} documents → viral_acceleration = null`);
}

main()
  .catch(err => { console.error('[fix-accel] Error:', err); process.exit(1); })
  .finally(() => closeDb());
