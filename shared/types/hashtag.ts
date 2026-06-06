import type { Platform } from "./video.js";

// ─── HashtagRecord ────────────────────────────────────────────────────────────
//
// Lưu trong MongoDB collection "hashtags" (upsert theo {tag, platform}).
// Được tính lại sau mỗi lần aggregator chạy extract_hashtags.

export interface HashtagRecord {
  tag:           string;
  /** Query string dùng để tìm video có hashtag này (Google/Serper query). */
  query?:        string;
  platform:      Platform;

  // Aggregate stats từ viral list
  count:         number;    // số video viral có tag này
  videos:        number;    // alias của count (backward compat)
  totalViews:    number;
  totalLikes:    number;
  totalComments: number;
  avgViews:      number;
  avgLikeRate:   number;    // trung bình (likes/views) của các video có tag này
  score:         number;    // composite trending score

  /** Timestamp của lần sync gần nhất — dùng để lọc hashtag stale. */
  synced_at:     Date;
}

export interface HashtagsResponse {
  data: HashtagRecord[];
}
