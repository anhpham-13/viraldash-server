import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface RapidApiConfig {
  apiKey: string;
  host: string;
}

export interface TiktokAppEnv {
  maxVideoAgeDays: number;
  viralScoreThreshold: number;
  rapidApiConfigs: RapidApiConfig[];
  crawlRegions: string[];
  maxBrowserConcurrency: number;
  serperApiKeys: string[];
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsedValue = Number.parseInt(value, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseRapidApiConfigs(configsValue: string | undefined, hostValue?: string, keysValue?: string): RapidApiConfig[] {
  if (hostValue && keysValue) {
    const host = hostValue.trim();
    const keys = keysValue.split(",").map((key) => key.trim()).filter(Boolean);
    return keys.map((apiKey) => ({ apiKey, host }));
  }
  return [];
}

export function loadTiktokEnv(): TiktokAppEnv {
  return {
    maxVideoAgeDays: parsePositiveInteger(process.env.MAX_VIDEO_AGE_DAYS, 1),
    viralScoreThreshold: parsePositiveInteger(process.env.VIRAL_SCORE_THRESHOLD, 98),
    rapidApiConfigs: parseRapidApiConfigs(process.env.RAPID_API_CONFIGS, process.env.RAPID_API_HOST, process.env.RAPID_API_KEYS),
    crawlRegions: parseCsv(process.env.CRAWL_REGIONS),
    maxBrowserConcurrency: parsePositiveInteger(process.env.MAX_BROWSER_CONCURRENCY, 3),
    serperApiKeys: parseCsv(process.env.SERPER_API_KEYS || process.env.SERPER_API_KEY),
  };
}

export const env = loadTiktokEnv();
