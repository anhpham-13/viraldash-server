import type { IYouTubeVideoRaw, IYouTubeVideoScored } from "./types.js";

// ─── Threshold constants ──────────────────────────────────────────────────────
/** Maximum video age (hours) for viral-score consideration */
const MAX_VIDEO_AGE_HOURS = 48;

const MIN_VIEWS = 2_000;
const MIN_VIEWS_PER_HOUR = 5000;
const MIN_LIKES = 100;
const MIN_LIKE_RATE = 0.01; // 1%

// ─── Utility helpers ──────────────────────────────────────────────────────────
function safeNumber(value: number | string | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function getAgeHours(publishedAt: string | undefined, fetchedAt: string): number {
  if (!publishedAt) return 0;
  const postMs = new Date(publishedAt).getTime();
  const fetchMs = new Date(fetchedAt).getTime();
  if (!Number.isFinite(postMs) || !Number.isFinite(fetchMs) || fetchMs < postMs) return 0;
  return (fetchMs - postMs) / 3_600_000;
}

// ─── PRD Formula A: Engagement Rate (ER) ─────────────────────────────────────
/**
 * Engagement Rate (ER) — PRD §3.A
 *
 * ER = (Likes + Comments + Favorites) / View Count × 100
 *
 * Isolates active audience interest from passive scrolling.
 * Returns 0 when viewCount is 0 to avoid division-by-zero.
 */
export function calcEngagementRate(
  likes: number,
  comments: number,
  saves: number,
  views: number
): number {
  if (views <= 0) return 0;
  return ((likes + comments + saves) / views) * 100;
}

// ─── PRD Formula B: Virality Velocity (Vv) ───────────────────────────────────
/**
 * Virality Velocity (Vv) — PRD §3.B
 *
 * Vv = Total View Count / (Current Time − Published Time in Hours)
 *
 * Measures raw speed of content consumption per hour since publication.
 * Returns 0 when ageHours ≤ 0 to avoid undefined behaviour.
 */
export function calcViralityVelocity(views: number, ageHours: number): number {
  if (ageHours <= 0) return 0;
  return views / ageHours;
}

// ─── PRD Formula D: Multi-Day Rolling View Velocity (Vd) ─────────────────────
/**
 * Rolling View Velocity (Vd) — PRD §3.D
 *
 * Vd = (View Count_t − View Count_{t−24h}) / Delta Time in Hours
 *
 * Tracks the net daily operational change over a continuous 24-hour cycle.
 * Requires snapshot history — callers must supply both readings.
 * Returns null when inputs are unavailable (snapshot not yet populated).
 */
export function calcRollingVelocity(
  viewsNow: number,
  viewsMinus24h: number,
  deltaHours: number
): number | null {
  if (!Number.isFinite(viewsNow) || !Number.isFinite(viewsMinus24h) || deltaHours <= 0) {
    return null;
  }
  return (viewsNow - viewsMinus24h) / deltaHours;
}

// ─── PRD Formula E: Viral Acceleration (Av) ───────────────────────────────────
/**
 * Viral Acceleration (Av) — PRD §3.E
 *
 * Av = Vd(Today) − Vd(Yesterday)
 *
 * Positive Av → content gaining speed (live breakout).
 * Negative Av → growth decelerating (fading trend).
 * Returns null when either velocity snapshot is unavailable.
 */
export function calcViralAcceleration(
  vdToday: number | null,
  vdYesterday: number | null
): number | null {
  if (vdToday === null || vdYesterday === null) return null;
  if (!Number.isFinite(vdToday) || !Number.isFinite(vdYesterday)) return null;
  return vdToday - vdYesterday;
}

// ─── PRD Formula C: Breakthrough Viral Score (0–100) ─────────────────────────
/**
 * Breakthrough Viral Score — PRD §3.C
 *
 * A normalized composite index scaled 0–100. Content that triggers extreme
 * outliers in velocity within its first 24-hour window is clamped to 100.
 *
 * Components are weighted logarithmically to reward exponential growth
 * and normalised so that genuine viral outliers saturate the scale.
 */
export function calcViralScore(video: IYouTubeVideoRaw): number {
  const views = safeNumber((video as any).view_count ?? (video as any).views ?? (video as any).statistics?.viewCount);
  const likes = safeNumber((video as any).likes ?? (video as any).statistics?.likeCount);
  const comments = safeNumber((video as any).comments ?? (video as any).statistics?.commentCount);
  const saves = safeNumber((video as any).favorites ?? (video as any).saves ?? (video as any).statistics?.favoriteCount ?? 0);

  const publishedAt =
    (video as any).published_at ??
    (video as any).postDate ??
    (video as any).snippet?.publishedAt ??
    (video as any).publishedAt;

  const fetchedAt = (video as any).fetchedAt ?? new Date().toISOString();
  const ageHours = getAgeHours(publishedAt, fetchedAt);

  if (!Number.isFinite(ageHours) || ageHours <= 0 || ageHours > MAX_VIDEO_AGE_HOURS) {
    return 0;
  }

  const viewsPerHour = calcViralityVelocity(views, ageHours);
  const likeRate = views > 0 ? likes / views : 0;

  // Gate filters — weed out low-signal videos
  if (
    views < MIN_VIEWS ||
    viewsPerHour < MIN_VIEWS_PER_HOUR ||
    likes < MIN_LIKES ||
    likeRate < MIN_LIKE_RATE
  ) {
    return 0;
  }

  const engagementRate = calcEngagementRate(likes, comments, saves, views);

  const viewComponent = Math.min(30, Math.log10(views + 1) * 8);
  const speedComponent = Math.min(35, Math.log10(viewsPerHour + 1) * 12);
  const likeComponent = Math.min(15, Math.log10(likes + 1) * 5);
  const commentComponent = Math.min(10, Math.log10(comments + 1) * 5);
  const engagementComponent = Math.min(10, (engagementRate / 2) * 10); // normalised: 2% ER → full 10pts
  const recencyComponent = Math.max(0, 10 - ageHours * 0.4);

  const rawScore =
    viewComponent +
    speedComponent +
    likeComponent +
    commentComponent +
    engagementComponent +
    recencyComponent;

  return Math.round(Math.min(100, Math.max(0, rawScore)));
}

// ─── Composite: attach all PRD metrics to a video record ─────────────────────
/**
 * Enriches a raw video record with all PRD-specified viral metrics.
 *
 * Note: `rollingVelocity` and `viralAcceleration` require historical snapshot
 * data. They are set to `null` until the snapshot pipeline is implemented.
 * Callers may override these after loading snapshot history.
 */
export function withViralMetrics(video: IYouTubeVideoRaw): IYouTubeVideoScored {
  const views = safeNumber((video as any).view_count ?? (video as any).views ?? (video as any).statistics?.viewCount);
  const likes = safeNumber((video as any).likes ?? (video as any).statistics?.likeCount);
  const comments = safeNumber((video as any).comments ?? (video as any).statistics?.commentCount);
  const saves = safeNumber((video as any).favorites ?? (video as any).saves ?? (video as any).statistics?.favoriteCount ?? 0);

  const publishedAt =
    (video as any).published_at ??
    (video as any).postDate ??
    (video as any).snippet?.publishedAt ??
    (video as any).publishedAt;

  const fetchedAt = (video as any).fetchedAt ?? new Date().toISOString();
  const ageHours = getAgeHours(publishedAt, fetchedAt);

  const engagement_score = Number(calcEngagementRate(likes, comments, saves, views).toFixed(2));
  const viral_velocity = Number(calcViralityVelocity(views, ageHours).toFixed(2));
  const viral_score = calcViralScore(video);

  return {
    ...video,
    engagement_score,
    viral_velocity,
    rolling_velocity: null,    // Requires snapshot history — see PRD §5.B
    viral_acceleration: null,  // Requires two consecutive Vd readings
    viral_score,
    // Provide duplicates of legacy properties to satisfy TypeScript interfaces and older callers
    engagementRate: engagement_score,
    viralVelocity: viral_velocity,
    rollingVelocity: null,
    viralAcceleration: null,
    viralScore: viral_score,
  } as unknown as IYouTubeVideoScored;
}

/**
 * @deprecated Use `withViralMetrics` instead.
 * Kept for backward-compatibility with existing callers.
 */
export function withViralScore(video: IYouTubeVideoRaw): IYouTubeVideoScored {
  return withViralMetrics(video);
}