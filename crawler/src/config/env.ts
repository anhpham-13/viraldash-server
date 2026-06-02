import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AppEnv {
  nodeEnv: string;
  maxVideoAgeDays: number;
  viralScoreThreshold: number;
  youtubeDataApiKey: string;
  enricherConcurrency: number;
}

const DEFAULT_MAX_VIDEO_AGE_DAYS = 1;
const DEFAULT_VIRAL_SCORE_THRESHOLD = 98;

function loadDotEnvFile(): void {
  const dotenvPath = resolve(process.cwd(), ".env");

  if (!existsSync(dotenvPath)) {
    return;
  }

  const content = readFileSync(dotenvPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0 || trimmedLine.startsWith("#") || !trimmedLine.includes("=")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

export function loadEnv(): AppEnv {
  loadDotEnvFile();

  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    maxVideoAgeDays: parsePositiveInteger(process.env.MAX_VIDEO_AGE_DAYS, DEFAULT_MAX_VIDEO_AGE_DAYS),
    viralScoreThreshold: parsePositiveInteger(process.env.VIRAL_SCORE_THRESHOLD, DEFAULT_VIRAL_SCORE_THRESHOLD),
    youtubeDataApiKey: process.env.YOUTUBE_DATA_API_KEY || process.env.YT_DATA_API_KEY || "",
    enricherConcurrency: parsePositiveInteger(process.env.ENRICHER_CONCURRENCY, 5),
  };
}

export const env = loadEnv();
