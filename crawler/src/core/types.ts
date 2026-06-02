// ─── Schema: PRD §2 — Unified Video Record ───────────────────────────────────

export interface IYouTubeVideoRaw {
  id: string;
  author: string;
  url: string;
  likes: number;
  views: number;
  comments: number;
  shares: number;
  saves: number;
  total_view_growth: number;
  hashtags: string[];
  sound: string;
  postDate: string;
  fetchedAt: string;
}

// ─── Schema: PRD §3 — Analytics Metrics ─────────────────────────────────────

export interface IYouTubeVideoScored extends IYouTubeVideoRaw {
  // ─── Legacy camelCase properties ──────────────────────────────────────────
  engagementRate: number;
  viralVelocity: number;
  rollingVelocity: number | null;
  viralAcceleration: number | null;
  viralScore: number;

  // ─── PRD Schema snake_case properties ─────────────────────────────────────
  engagement_score: number;
  viral_velocity: number;
  rolling_velocity: number | null;
  viral_acceleration: number | null;
  viral_score: number;
}

// ─── Schema: loose candidate shape from crawlers ─────────────────────────────

export interface IVideoRecordCandidate {
  id?: string;
  author?: string;
  username?: string;
  likes?: number | string;
  views?: number | string;
  comments?: number | string;
  shares?: number | string;
  saves?: number | string;
  total_view_growth?: number | string;
  hashtags?: string[] | string;
  sound?: string;
  music?: string;
  postDate?: string;
  createdAt?: string;
  publishedAt?: string;
  fetchedAt?: string;
  video_id?: string;
  url?: string;
  [key: string]: unknown;
}

// ─── Schema: worker run output ───────────────────────────────────────────────

export interface IWorkerRunSummary {
  workerName: string;
  workerId: string;
  outputFile: string;
  acceptedCount: number;
  skippedCount: number;
}
