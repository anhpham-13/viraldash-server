import type { Db } from "mongodb";
import { COL } from "./collections.js";

// ─── Index strategy (derived from dashboard query patterns) ──────────────────
//
// videos collection
//   {video_id, platform}              → UNIQUE upsert key
//   {viral_score, last_refreshed_at}  → main dashboard sort (all platforms)
//   {platform, viral_score}           → platform tab filter + sort
//   {viral_acceleration}              → "Accelerating" tab sort (sparse: skip nulls)
//   {published_at}                    → age window filter (maxAge=48h)
//   {first_seen_at}                   → "New" tab filter (isNew=6h)
//   {last_refreshed_at, viral_score}  → refresh loop: which videos need refresh
//   {snapshot_count}                  → "Multi-tracked" filter (minSnapshots>=2)
//
// hashtags collection
//   {tag, platform}                   → UNIQUE upsert key
//   {platform, score}                 → leaderboard query

export async function ensureIndexes(db: Db): Promise<void> {
  // ── videos ────────────────────────────────────────────────────────────────
  await db.collection(COL.VIDEOS).createIndexes([
    {
      key:    { video_id: 1, platform: 1 },
      unique: true,
      name:   "video_id_platform_uniq",
    },
    {
      key:  { viral_score: -1, last_refreshed_at: -1 },
      name: "viral_score_idx",
    },
    {
      key:  { platform: 1, viral_score: -1 },
      name: "platform_score_idx",
    },
    {
      // sparse: true → null values excluded, index chỉ dành cho videos có >= 2 snapshots
      key:    { viral_acceleration: -1 },
      name:   "acceleration_idx",
      sparse: true,
    },
    {
      key:  { published_at: -1 },
      name: "published_at_idx",
    },
    {
      key:  { first_seen_at: -1 },
      name: "first_seen_idx",
    },
    {
      key:  { last_refreshed_at: 1, viral_score: -1 },
      name: "refresh_queue_idx",
    },
    {
      key:  { snapshot_count: 1 },
      name: "snapshot_count_idx",
    },
  ]);

  // ── hashtags ──────────────────────────────────────────────────────────────
  await db.collection(COL.HASHTAGS).createIndexes([
    {
      key:    { tag: 1, platform: 1 },
      unique: true,
      name:   "tag_platform_uniq",
    },
    {
      key:  { platform: 1, score: -1 },
      name: "platform_score_idx",
    },
  ]);

  console.log("[db] Indexes ensured");
}
