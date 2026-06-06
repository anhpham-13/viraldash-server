import type { IYouTubeVideoRaw, IYouTubeVideoScored } from "./types.js";

export type Platform = "tiktok" | "youtube" | "instagram";
export type VideoPhase = "viral" | "seed" | "rejected";

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_VIDEO_AGE_HOURS = 48;
const SEED_AGE_WINDOW_HOURS = 2;  // age ≤ 2 h → seed candidate window
const SEED_MIN_VIEWS = 2_000;      // any platform: min views to qualify as seed

// ─── Per-platform viral gate thresholds ───────────────────────────────────────
// TikTok (strictest) → YouTube → Instagram (most lenient)
// These apply only to established videos (age > SEED_AGE_WINDOW_HOURS).
interface ViralGate {
  minViews: number;
  minViewsPerHour: number;
  minLikes: number;
  minLikeRate: number;
}

const VIRAL_GATES: Record<Platform, ViralGate> = {
  tiktok: {
    minViews: 100_000,
    minViewsPerHour: 20_000,
    minLikes: 2_000,
    minLikeRate: 0.02,   // 2 % — TikTok users like aggressively
  },
  youtube: {
    minViews: 30_000,
    minViewsPerHour: 8_000,
    minLikes: 500,
    minLikeRate: 0.015,  // 1.5 %
  },
  instagram: {
    minViews: 15_000,
    minViewsPerHour: 5_000,
    minLikes: 300,
    minLikeRate: 0.01,   // 1 %
  },
};

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

function extractFields(video: IYouTubeVideoRaw) {
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
  return { views, likes, comments, saves, publishedAt, fetchedAt };
}

// ─── PRD Formula A: Engagement Rate (ER) ─────────────────────────────────────
/**
 * ER = (Likes + Comments + Favorites) / View Count × 100
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
 * Vv = Total View Count / (Current Time − Published Time in Hours)
 */
export function calcViralityVelocity(views: number, ageHours: number): number {
  if (ageHours <= 0) return 0;
  return views / ageHours;
}

// ─── PRD Formula D: Multi-Day Rolling View Velocity (Vd) ─────────────────────
/**
 * Vd = (View Count_t − View Count_{t−24h}) / Delta Time in Hours
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

// ─── PRD Formula E: Viral Acceleration (Av) ──────────────────────────────────
/**
 * Av = Vd(Today) − Vd(Yesterday)
 * Positive → gaining speed (live breakout). Negative → decelerating.
 */
export function calcViralAcceleration(
  vdToday: number | null,
  vdYesterday: number | null
): number | null {
  if (vdToday === null || vdYesterday === null) return null;
  if (!Number.isFinite(vdToday) || !Number.isFinite(vdYesterday)) return null;
  return vdToday - vdYesterday;
}

// ─── Internal classifier ──────────────────────────────────────────────────────
/**
 * Two-phase classification:
 *
 * • Seed  (age ≤ 2 h): video is too young for a full viral verdict.
 *   Any video that already has ≥ 2 000 views is worth monitoring — it
 *   receives a small seed score (1–20) proportional to view count.
 *
 * • Viral (age > 2 h): apply platform-specific gate thresholds.
 *   Passes the gate → full weighted score (21–100).
 *   Fails the gate  → score 0, phase "rejected".
 */
function classify(
  video: IYouTubeVideoRaw,
  platform: Platform
): { phase: VideoPhase; score: number } {
  const { views, likes, comments, saves, publishedAt, fetchedAt } = extractFields(video);
  const ageHours = getAgeHours(publishedAt, fetchedAt);

  if (!Number.isFinite(ageHours) || ageHours <= 0 || ageHours > MAX_VIDEO_AGE_HOURS) {
    return { phase: "rejected", score: 0 };
  }

  // ── Phase 1: Seed window (age ≤ 2 h) ──────────────────────────────────────
  if (ageHours <= SEED_AGE_WINDOW_HOURS) {
    if (views < SEED_MIN_VIEWS) return { phase: "rejected", score: 0 };
    // Seed score 1–20: logarithmic, so early spikes still get a decent signal
    const score = Math.min(20, Math.max(1, Math.round(Math.log10(views + 1) * 4)));
    return { phase: "seed", score };
  }

  // ── Phase 2: Established video (age > 2 h) — platform viral gate ──────────
  const gate = VIRAL_GATES[platform];
  const viewsPerHour = calcViralityVelocity(views, ageHours);
  const likeRate = views > 0 ? likes / views : 0;

  if (
    views < gate.minViews ||
    viewsPerHour < gate.minViewsPerHour ||
    likes < gate.minLikes ||
    likeRate < gate.minLikeRate
  ) {
    return { phase: "rejected", score: 0 };
  }

  const engagementRate = calcEngagementRate(likes, comments, saves, views);
  const viewComponent = Math.min(30, Math.log10(views + 1) * 8);
  const speedComponent = Math.min(35, Math.log10(viewsPerHour + 1) * 12);
  const likeComponent = Math.min(15, Math.log10(likes + 1) * 5);
  const commentComponent = Math.min(10, Math.log10(comments + 1) * 5);
  const engagementComponent = Math.min(10, (engagementRate / 2) * 10);
  const recencyComponent = Math.max(0, 10 - ageHours * 0.4);

  const rawScore =
    viewComponent +
    speedComponent +
    likeComponent +
    commentComponent +
    engagementComponent +
    recencyComponent;

  return { phase: "viral", score: Math.round(Math.min(100, Math.max(21, rawScore))) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the phase (viral / seed / rejected) for a video. */
export function getVideoPhase(video: IYouTubeVideoRaw, platform: Platform = "youtube"): VideoPhase {
  return classify(video, platform).phase;
}

/** Returns a 0–100 viral score. Seeds score 1–20; viral 21–100; rejected 0. */
export function calcViralScore(video: IYouTubeVideoRaw, platform: Platform = "youtube"): number {
  return classify(video, platform).score;
}

// ─── Composite: attach all PRD metrics to a video record ─────────────────────
export function withViralMetrics(
  video: IYouTubeVideoRaw,
  platform: Platform = "youtube"
): IYouTubeVideoScored {
  const { views, likes, comments, saves, publishedAt, fetchedAt } = extractFields(video);
  const ageHours = getAgeHours(publishedAt, fetchedAt);

  const { phase, score } = classify(video, platform);

  const engagement_score = Number(calcEngagementRate(likes, comments, saves, views).toFixed(2));
  const viral_velocity = Number(calcViralityVelocity(views, ageHours).toFixed(2));

  return {
    ...video,
    engagement_score,
    viral_velocity,
    rolling_velocity: null,
    viral_acceleration: null,
    viral_score: score,
    video_phase: phase,
    // Legacy camelCase aliases
    engagementRate: engagement_score,
    viralVelocity: viral_velocity,
    rollingVelocity: null,
    viralAcceleration: null,
    viralScore: score,
  } as unknown as IYouTubeVideoScored;
}

/**
 * @deprecated Use `withViralMetrics` instead.
 */
export function withViralScore(video: IYouTubeVideoRaw): IYouTubeVideoScored {
  return withViralMetrics(video);
}
