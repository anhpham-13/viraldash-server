// Base URL is baked into the client bundle at build time by Next.js.
// Set NEXT_PUBLIC_API_URL in .env.local (dev) or in your deployment platform (prod).
// On the server, we need the absolute URL. On the client, we use relative paths
// so requests go through Next.js rewrites (avoiding Ngrok CORS preflights).
const API_BASE = typeof window === 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '')
  : '';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VideoStatus = 'Emerging' | 'Trending' | 'Viral' | 'Declining';

export interface Video {
  video_id: string | null;
  platform: string;
  url: string | undefined;
  published_at: string | null;
  author: string | undefined;
  title?: string;
  view_count: number;
  likes: number;
  comments: number;
  favorites: number;
  shares: number;
  saves: number;
  engagement_score: number;
  viral_velocity: number;
  viral_score: number;
  viral_acceleration: number | null;
  age_hours: number;
  status: VideoStatus;
  tags: string[];
  hashtags: string[];
  sound?: string;
  snapshot_count: number;
  first_seen_at: string;
  last_refreshed_at: string;
  [key: string]: unknown;
}

export interface VideoMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface VideosResponse {
  data: Video[];
  meta: VideoMeta;
}

export interface Hashtag {
  tag: string;
  query: string;
  count: number;
  videos: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number;
  avgLikeRate: number;
  score: number;
  platform?: string;
}

export interface HashtagsResponse {
  data: Hashtag[];
}

export interface Stats {
  totalVideosCrawled: number;
  newVideos24h: number;
  trendingVideos: number;
  avgVelocity: number;
  avgEngagement: number;
  avgAcceleration: number;
  acceleratingVideos: number;
  declineVideos: number;
  newVideos: number;
  activeHashtags: number;
  lastRefreshByPlatform: {
    YouTube_Shorts: string | null;
    TikTok: string | null;
    Instagram_Reels: string | null;
  };
}

export interface StatsResponse {
  data: Stats;
}

export interface PipelineAlert {
  todayCount: number;
  rollingAvg: number;
  dropPct: number;
}

export interface Alerts {
  hockeyStick: Video[];
  resurgence: Video[];
  pipelineAlert: PipelineAlert | null;
}

export interface AlertsResponse {
  data: Alerts;
}

export interface VideoSnapshot {
  ts: string;
  view_count: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  delta_views: number;
  delta_hours: number;
  rolling_velocity: number;
  engagement_score: number;
  viral_score: number;
}

export interface VideoSnapshotsResponse {
  data: VideoSnapshot[];
}

// ─── Query params ─────────────────────────────────────────────────────────────

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

export interface VideoParams {
  page?: number;
  limit?: number;
  sort?: SortKey;
  dir?: SortDir;
  platform?: string;
  query?: string;
  status?: string;
  // optional range filters — send only when the user sets them
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
  isNew?: number;
}

// ─── Fetch core ───────────────────────────────────────────────────────────────

type RawParams = Record<string, string | number | boolean | null | undefined>;

async function apiFetch<T>(
  path: string,
  params?: RawParams,
  init?: RequestInit,
): Promise<T> {
  const urlStr = `${API_BASE}${path}`;
  const base = typeof window !== 'undefined' ? window.location.origin : undefined;
  const url = new URL(urlStr, base);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Skip undefined / null / empty string — keeps the query string clean
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers = new Headers(init?.headers);
  headers.set('ngrok-skip-browser-warning', 'true');

  const res = await fetch(url.toString(), {
    cache: 'no-store', // always fetch fresh data; disable Next.js data cache
    ...init,
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[api] ${res.status} ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Public API surface ───────────────────────────────────────────────────────

export const api = {
  /**
   * Fetch a paginated, filtered, sorted page of videos.
   * All filtering and sorting happens on the backend — only `limit` rows travel the wire.
   */
  videos(params: VideoParams = {}, init?: RequestInit): Promise<VideosResponse> {
    return apiFetch<VideosResponse>('/api/videos', params as RawParams, init);
  },

  /** Fetch hashtag leaderboard, optionally filtered by platform. */
  hashtags(platform?: string, init?: RequestInit): Promise<HashtagsResponse> {
    return apiFetch<HashtagsResponse>(
      '/api/hashtags',
      platform && platform !== 'all' ? { platform } : undefined,
      init,
    );
  },

  /** Fetch aggregated KPI stats, optionally filtered by platform. */
  stats(platform?: string, init?: RequestInit): Promise<StatsResponse> {
    return apiFetch<StatsResponse>(
      '/api/stats',
      platform && platform !== 'all' ? { platform } : undefined,
      init,
    );
  },

  /** Fetch alert signals: hockey-stick, resurgence, pipeline health. */
  alerts(init?: RequestInit): Promise<AlertsResponse> {
    return apiFetch<AlertsResponse>('/api/alerts', undefined, init);
  },

  /** Fetch snapshot history for a specific video. */
  videoSnapshots(platform: string, videoId: string, init?: RequestInit): Promise<VideoSnapshotsResponse> {
    return apiFetch<VideoSnapshotsResponse>(
      `/api/videos/${encodeURIComponent(videoId)}/snapshots`,
      { platform },
      init,
    );
  },
};
