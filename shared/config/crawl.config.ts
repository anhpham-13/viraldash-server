import { env } from "./env.js";

// ─── CrawlConfig ─────────────────────────────────────────────────────────────
//
// Single source of truth cho tất cả tham số tuning nghiệp vụ.
// Tất cả giá trị đều đọc từ env (override bằng .env), có default hợp lý.
//
// Quan hệ quan trọng:
//   snapshotsPerVideo ≈ refreshMaxAgeHours / refreshIntervalHours
//   VD: 48h / 8h = 6 snapshots per video lifecycle
//
// Khi thay đổi intervalHours, cũng cần cân nhắc maxTrackedAgeHours
// để giữ nguyên số snapshot mong muốn.

export const crawlConfig = {

  // ── Discovery Loop (Loop 1) ───────────────────────────────────────────────
  // Chạy on-demand hoặc theo cron để tìm viral vids mới.
  discovery: {
    /** Video phải được publish trong khoảng này mới được xét (tính theo giờ). */
    maxPublishedAgeHours: env.discoveryMaxAgeHours,

    /** Ngưỡng viral_score tối thiểu để vào viral list (0–100). */
    viralScoreThreshold: env.viralScoreThreshold,
  },

  // ── Refresh Loop (Loop 2) ─────────────────────────────────────────────────
  // Fetch lại metadata của viral list để track velocity & acceleration.
  refresh: {
    /** Mỗi bao nhiêu giờ chạy một lần. */
    intervalHours: env.refreshIntervalHours,

    /** Chỉ refresh video có published_at trong khoảng này (giờ). */
    maxTrackedAgeHours: env.refreshMaxAgeHours,

    /** Bỏ qua refresh nếu viral_score < ngưỡng này — tránh lãng phí request. */
    minViralScore: env.refreshMinScore,

    /** Số snapshots dự kiến mỗi video đạt được (computed, chỉ để log). */
    get expectedSnapshotsPerVideo(): number {
      return Math.floor(env.refreshMaxAgeHours / env.refreshIntervalHours);
    },
  },

  // ── Concurrency & Rate Limiting ───────────────────────────────────────────
  concurrency: {
    /** Số Playwright browser chạy đồng thời. */
    browserInstances: env.browserConcurrency,

    /** Số API request song song (YouTube API, RapidAPI…). */
    apiRequests: env.apiConcurrency,

    /** Random delay giữa các request để tránh fingerprint. */
    humanDelay: {
      minMs: env.humanDelayMinMs,
      maxMs: env.humanDelayMaxMs,
    },

    /** Delay cố định giữa các batch (ví dụ: YouTube Data API batches). */
    batchDelayMs: env.batchDelayMs,
  },

  // ── Viral Score Gate Thresholds ───────────────────────────────────────────
  // Các ngưỡng filter để loại video ít tín hiệu trước khi tính score.
  scoring: {
    minViews:        env.scoreMinViews,
    minViewsPerHour: env.scoreMinViewsPerHour,
    minLikes:        env.scoreMinLikes,
    /** Decimal fraction, e.g. 0.01 = 1%. */
    minLikeRate:     env.scoreMinLikeRate,
  },

} as const;

export type CrawlConfig = typeof crawlConfig;

// ─── Startup log ─────────────────────────────────────────────────────────────

export function logCrawlConfig(): void {
  const { discovery, refresh, concurrency } = crawlConfig;
  console.log(
    `[config] discovery: maxAge=${discovery.maxPublishedAgeHours}h  threshold=${discovery.viralScoreThreshold}`,
  );
  console.log(
    `[config] refresh:   interval=${refresh.intervalHours}h  maxAge=${refresh.maxTrackedAgeHours}h` +
    `  minScore=${refresh.minViralScore}  expectedSnapshots=${refresh.expectedSnapshotsPerVideo}`,
  );
  console.log(
    `[config] concurrency: browsers=${concurrency.browserInstances}  api=${concurrency.apiRequests}` +
    `  delay=${concurrency.humanDelay.minMs}–${concurrency.humanDelay.maxMs}ms`,
  );
}
