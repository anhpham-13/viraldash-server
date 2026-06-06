import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Env file loader ──────────────────────────────────────────────────────────

function loadDotEnvFile(): void {
  const dotenvPath = resolve(process.cwd(), ".env");
  if (!existsSync(dotenvPath)) return;

  const content = readFileSync(dotenvPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const sep = trimmed.indexOf("=");
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function int(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function float(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

// ─── AppEnv interface ────────────────────────────────────────────────────────

export interface AppEnv {
  nodeEnv: string;

  // ── Discovery (Loop 1) ───────────────────────────────────────────────────
  /** Max age (hours) a video can be to enter viral consideration. */
  discoveryMaxAgeHours: number;
  /** Min viral_score (0–100) to write into the viral list. */
  viralScoreThreshold: number;

  // ── Refresh (Loop 2) ─────────────────────────────────────────────────────
  /** How many hours between each metadata refresh run. */
  refreshIntervalHours: number;
  /** Only refresh videos published within this many hours. */
  refreshMaxAgeHours: number;
  /** Skip refresh for videos whose viral_score is below this. */
  refreshMinScore: number;

  // ── Concurrency & rate-limiting ──────────────────────────────────────────
  /** Parallel Playwright browser instances. */
  browserConcurrency: number;
  /** Parallel non-browser API requests (YouTube, RapidAPI, etc.). */
  apiConcurrency: number;
  /** Min ms of human-like delay between requests. */
  humanDelayMinMs: number;
  /** Max ms of human-like delay between requests. */
  humanDelayMaxMs: number;
  /** Fixed delay between API batch calls (ms). */
  batchDelayMs: number;

  // ── Viral score gate thresholds ──────────────────────────────────────────
  scoreMinViews: number;
  scoreMinViewsPerHour: number;
  scoreMinLikes: number;
  /** Like rate as a decimal fraction, e.g. 0.01 = 1%. */
  scoreMinLikeRate: number;

  // ── MongoDB ──────────────────────────────────────────────────────────────
  mongoUri: string;
  mongoDb: string;

  // ── Platform API keys ────────────────────────────────────────────────────
  youtubeDataApiKey: string;
  rapidApiHost: string;
  rapidApiKeys: string[];
  serperApiKeys: string[];

  // ── Backward-compat aliases (deprecated) ────────────────────────────────
  /** @deprecated Use discoveryMaxAgeHours instead. Derived: ceil(discoveryMaxAgeHours / 24). */
  maxVideoAgeDays: number;
  /** @deprecated Use apiConcurrency instead. */
  enricherConcurrency: number;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export function loadEnv(): AppEnv {
  loadDotEnvFile();

  // Backward compat: nếu DISCOVERY_MAX_AGE_HOURS chưa set, đọc MAX_VIDEO_AGE_DAYS * 24
  const discoveryMaxAgeHours = process.env["DISCOVERY_MAX_AGE_HOURS"]
    ? int(process.env["DISCOVERY_MAX_AGE_HOURS"], 48)
    : int(process.env["MAX_VIDEO_AGE_DAYS"], 2) * 24;

  const apiConcurrency = int(process.env["API_CONCURRENCY"] ?? process.env["ENRICHER_CONCURRENCY"], 5);
  const refreshIntervalHours = int(process.env["REFRESH_INTERVAL_HOURS"], 1);
  const refreshMaxAgeHours = int(process.env["REFRESH_MAX_AGE_HOURS"], 48);

  const rapidApiKeysRaw = str(process.env["RAPID_API_KEYS"], "");
  const serperApiKeysRaw = str(process.env["SERPER_API_KEYS"], "");

  return {
    nodeEnv: str(process.env["NODE_ENV"], "development"),

    // Discovery
    discoveryMaxAgeHours,
    viralScoreThreshold: int(process.env["VIRAL_SCORE_THRESHOLD"], 90),

    // Refresh
    refreshIntervalHours,
    refreshMaxAgeHours,
    refreshMinScore: int(process.env["REFRESH_MIN_SCORE"], 50),

    // Concurrency
    browserConcurrency: int(process.env["BROWSER_CONCURRENCY"] ?? process.env["MAX_BROWSER_CONCURRENCY"], 3),
    apiConcurrency,
    humanDelayMinMs: int(process.env["HUMAN_DELAY_MIN_MS"], 1_000),
    humanDelayMaxMs: int(process.env["HUMAN_DELAY_MAX_MS"], 3_000),
    batchDelayMs: int(process.env["BATCH_DELAY_MS"], 1_200),

    // Scoring gates
    scoreMinViews: int(process.env["SCORE_MIN_VIEWS"], 2_000),
    scoreMinViewsPerHour: int(process.env["SCORE_MIN_VPH"], 5_000),
    scoreMinLikes: int(process.env["SCORE_MIN_LIKES"], 100),
    scoreMinLikeRate: float(process.env["SCORE_MIN_LR"], 0.01),

    // MongoDB
    mongoUri: str(process.env["MONGODB_URI"], "mongodb://localhost:27017"),
    mongoDb: str(process.env["MONGODB_DB"], "viralscope"),

    // API keys
    youtubeDataApiKey: str(process.env["YOUTUBE_DATA_API_KEY"] ?? process.env["YT_DATA_API_KEY"], ""),
    rapidApiHost: str(process.env["RAPID_API_HOST"], ""),
    rapidApiKeys: rapidApiKeysRaw ? rapidApiKeysRaw.split(",").map(k => k.trim()).filter(Boolean) : [],
    serperApiKeys: serperApiKeysRaw ? serperApiKeysRaw.split(",").map(k => k.trim()).filter(Boolean) : [],

    // Backward-compat aliases
    maxVideoAgeDays: Math.ceil(discoveryMaxAgeHours / 24),
    enricherConcurrency: apiConcurrency,
  };
}

export const env = loadEnv();
