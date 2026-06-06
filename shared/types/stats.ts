import type { VideoResponse } from "./video.js";

// ─── Stats / KPI ──────────────────────────────────────────────────────────────

export interface Stats {
  totalVideosCrawled: number;
  newVideos24h: number;   // first_seen_at trong 24h qua
  trendingVideos: number;   // viral_score >= 50
  avgVelocity: number;   // avg viral_velocity của viral list
  avgEngagement: number;   // avg engagement_score của viral list
  /** Trung bình viral_acceleration — dương = thị trường đang tăng tốc. */
  avgAcceleration: number;
  /** Số video đang tăng tốc (viral_acceleration > 0). */
  acceleratingVideos: number;
  activeHashtags: number;
}

export interface StatsResponse {
  data: Stats;
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export interface PipelineAlert {
  todayCount: number;
  rollingAvg: number;
  dropPct: number;
}

export interface Alerts {
  /** Videos tại hoặc vượt 99th percentile viral_velocity — breakout signal. */
  hockeyStick: VideoResponse[];
  /** Videos tuổi >= 48h vẫn giữ viral_score >= 60 — resurgence signal. */
  resurgence: VideoResponse[];
  pipelineAlert: PipelineAlert | null;
}

export interface AlertsResponse {
  data: Alerts;
}
