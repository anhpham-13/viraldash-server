// ─── Enums ────────────────────────────────────────────────────────────────────

export type Platform =
  | 'YouTube_Shorts'
  | 'TikTok'
  | 'Instagram_Reels';

export type VideoStatus =
  | 'Emerging'
  | 'Trending'
  | 'Viral'
  | 'Declining';

// ─── RawCrawlerRecord ─────────────────────────────────────────────────────────
//
// Canonical shape mà MỌI crawler phải normalize về trước khi gọi repo.
// Normalization xảy ra tại WRITE TIME (trong crawler), không phải read time.
// Không có field nào là string | undefined — crawler phải resolve trước.

export interface RawCrawlerRecord {
  video_id: string;
  platform: Platform;
  url: string;
  published_at: Date;      // parse từ ISO string/unix timestamp trong crawler
  author: string;
  title?: string;
  hashtags: string[];
  sound?: string;
  view_count: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;    // unified: YouTube favoriteCount / TikTok collectCount / IG saves
  fetched_at: Date;      // khi crawler fetch data — dùng để tính delta_hours
}

// ─── VideoSnapshot ────────────────────────────────────────────────────────────
//
// Một điểm chụp trong lịch sử — là FACT sau khi ghi, không bao giờ thay đổi.
// Được tạo: (1) lần đầu crawl, (2) mỗi lần refresh metadata.

export interface VideoSnapshot {
  ts: Date;    // khi snapshot này được tạo (= fetched_at của refresh)

  // Raw stats tại thời điểm này
  view_count: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;

  // Delta so với snapshot trước — 0 nếu là snapshot đầu tiên
  delta_views: number;
  delta_hours: number;
  rolling_velocity: number;  // delta_views / delta_hours; 0 nếu snapshot đầu

  // Pre-computed tại snapshot time — dùng để vẽ sparkline trend
  engagement_score: number;  // (likes+comments+saves) / view_count * 100
  viral_score: number;  // score tại thời điểm snapshot này
}

// ─── VideoDocument ────────────────────────────────────────────────────────────
//
// Document lưu trong MongoDB. Tuân theo 2 nguyên tắc:
//   1. Chỉ lưu FACTS và pre-computed metrics (cập nhật khi push snapshot).
//   2. KHÔNG lưu bất kỳ field nào phụ thuộc vào "now":
//      age_hours, viral_velocity, status — compute tại query time.

export interface VideoDocument {
  // ── Identity (immutable sau insert) ─────────────────────────────────────
  video_id: string;
  platform: Platform;
  url: string;
  /** Date type — source of truth cho age. Không bao giờ tính age_hours ở đây. */
  published_at: Date;
  author: string;
  title?: string;
  hashtags: string[];
  sound?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  /** Thời điểm đầu tiên crawl — immutable sau lần insert đầu ($setOnInsert). */
  first_seen_at: Date;
  /** Thời điểm snapshot cuối cùng được push. */
  last_refreshed_at: Date;
  /** cached len(snapshots) — tránh phải $size mỗi lần query. */
  snapshot_count: number;

  // ── Latest raw stats (mirror snapshot cuối) ──────────────────────────────
  // Cập nhật mỗi khi pushSnapshot() được gọi.
  view_count: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;

  // ── Pre-computed metrics (as of last_refreshed_at) ────────────────────────
  // Max drift khi refresh 8h: recency component ≤ 3.2pt trên thang 0–100.
  engagement_score: number;
  viral_score: number;
  /** null khi chưa đủ 2 snapshots để tính delta rolling_velocity. */
  viral_acceleration: number | null;

  // ── Snapshot history (append-only, immutable sau khi ghi) ─────────────────
  snapshots: VideoSnapshot[];
}

// ─── VideoResponse ────────────────────────────────────────────────────────────
//
// Gì backend trả về qua API = VideoDocument + các field tính tại query time.
// age_hours và viral_velocity được inject bởi MongoDB aggregation pipeline,
// KHÔNG bao giờ đọc từ document đã lưu.

export interface VideoResponse extends VideoDocument {
  /** Computed: (now - published_at) / 3_600_000. Không bao giờ lưu vào DB. */
  age_hours: number;
  /** Computed: view_count / age_hours. Luôn dùng view_count mới nhất + now. */
  viral_velocity: number;
  /** Derived: từ viral_score + viral_acceleration + age_hours. */
  status: VideoStatus;

  // Backward-compat aliases — frontend cũ vẫn dùng được
  /** @deprecated Alias của saves. */
  favorites: number;
  /** @deprecated Alias của hashtags. */
  tags: string[];
}

// ─── Filters & Pagination ────────────────────────────────────────────────────

export type SortKey =
  | 'viral_score'
  | 'viral_acceleration'
  | 'viral_velocity'
  | 'view_count'
  | 'engagement_score'
  | 'age_hours'
  | 'last_refreshed_at'
  | 'snapshot_count';

export type SortDir = 'asc' | 'desc';

/** Filters dùng nội bộ ở tầng repository (typed, không phải query string). */
export interface VideoFilters {
  platform?: Platform | 'all';
  status?: VideoStatus | 'all';

  // Age
  minAge?: number;
  maxAge?: number;

  // Stats
  minViews?: number;
  maxViews?: number;

  // Metrics
  minEr?: number;
  maxEr?: number;
  minVelocity?: number;
  maxVelocity?: number;
  minScore?: number;
  maxScore?: number;
  minAcceleration?: number;
  maxAcceleration?: number;

  // Tracking depth
  /** Chỉ lấy video đã có ít nhất N snapshots (>= 2 = đã track ít nhất 1 lần sau crawl đầu). */
  minSnapshots?: number;
  /** Chỉ lấy video có tối đa N snapshots. VD: maxSnapshots=1 = chưa refresh lần nào. */
  maxSnapshots?: number;

  /** Chỉ lấy video có first_seen_at trong N giờ gần đây. VD: isNew=6 = mới crawl trong 6h qua. */
  isNew?: number;

  // Text search
  query?: string;

  // Sort & Pagination
  sort?: SortKey;
  dir?: SortDir;
  page?: number;
  limit?: number;
}

/** Query params từ frontend — dạng serializable để gắn vào URL. */
export interface VideoParams {
  platform?: string;
  status?: string;
  sort?: SortKey;
  dir?: SortDir;
  page?: number;
  limit?: number;
  query?: string;

  minAge?: number;
  maxAge?: number;
  minViews?: number;
  maxViews?: number;
  minEr?: number;
  maxEr?: number;
  minVelocity?: number;
  maxVelocity?: number;
  minScore?: number;
  maxScore?: number;
  minAcceleration?: number;
  maxAcceleration?: number;
  minSnapshots?: number;
  maxSnapshots?: number;
  /** Số giờ — isNew=6 nghĩa là first_seen_at < 6h ago. */
  isNew?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface VideosResponse {
  data: VideoResponse[];
  meta: PaginationMeta;
}
