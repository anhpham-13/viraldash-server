// Base URL is baked into the client bundle at build time by Next.js.
// Set NEXT_PUBLIC_API_URL in .env.local (dev) or in your deployment platform (prod).
// Falls back to localhost:4000 for local development without an env file.
const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

// ─── Types ────────────────────────────────────────────────────────────────────

export type VideoStatus = 'Emerging' | 'Trending' | 'Viral' | 'Declining';

export interface Video {
  video_id:         string | null;
  platform:         string;
  url:              string | undefined;
  published_at:     string | null;
  author:           string | undefined;
  view_count:       number;
  likes:            number;
  comments:         number;
  favorites:        number;
  shares:           number;
  engagement_score: number;
  viral_velocity:   number;
  viral_score:      number;
  age_hours:        number;
  status:           VideoStatus;
  tags:             string[];
  [key: string]:    unknown;
}

export interface VideoMeta {
  total:      number;
  page:       number;
  limit:      number;
  totalPages: number;
}

export interface VideosResponse {
  data: Video[];
  meta: VideoMeta;
}

export interface Hashtag {
  tag:           string;
  query:         string;
  count:         number;
  videos:        number;
  totalViews:    number;
  totalLikes:    number;
  totalComments: number;
  avgViews:      number;
  avgLikeRate:   number;
  score:         number;
  platform?:     string;
}

export interface HashtagsResponse {
  data: Hashtag[];
}

export interface Stats {
  totalVideosCrawled: number;
  newVideos24h:       number;
  trendingVideos:     number;
  avgVelocity:        number;
  avgEngagement:      number;
  activeHashtags:     number;
}

export interface StatsResponse {
  data: Stats;
}

export interface PipelineAlert {
  todayCount: number;
  rollingAvg: number;
  dropPct:    number;
}

export interface Alerts {
  hockeyStick:   Video[];
  resurgence:    Video[];
  pipelineAlert: PipelineAlert | null;
}

export interface AlertsResponse {
  data: Alerts;
}

// ─── Query params ─────────────────────────────────────────────────────────────

export type SortKey =
  | 'viral_score'
  | 'age_hours'
  | 'view_count'
  | 'engagement_score'
  | 'viral_velocity';

export type SortDir = 'asc' | 'desc';

export interface VideoParams {
  page?:        number;
  limit?:       number;
  sort?:        SortKey;
  dir?:         SortDir;
  platform?:    string;
  query?:       string;
  status?:      string;
  // optional range filters — send only when the user sets them
  minAge?:      number;
  maxAge?:      number;
  minViews?:    number;
  maxViews?:    number;
  minEr?:       number;
  maxEr?:       number;
  minVelocity?: number;
  maxVelocity?: number;
  minScore?:    number;
  maxScore?:    number;
}

// ─── Fetch core ───────────────────────────────────────────────────────────────

type RawParams = Record<string, string | number | boolean | null | undefined>;

async function apiFetch<T>(
  path: string,
  params?: RawParams,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Skip undefined / null / empty string — keeps the query string clean
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    cache: 'no-store', // always fetch fresh data; disable Next.js data cache
    ...init,
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
};
