// Common fields (viralScoreThreshold, maxVideoAgeDays, concurrency) đến từ shared env.
// TikTok-specific fields (rapidApiConfigs, crawlRegions) định nghĩa tại đây.
import { env as sharedEnv } from "../../src/config/env.js";

export interface RapidApiConfig {
  apiKey: string;
  host:   string;
}

export interface TiktokAppEnv {
  maxVideoAgeDays:       number;
  viralScoreThreshold:   number;
  rapidApiConfigs:       RapidApiConfig[];
  crawlRegions:          string[];
  maxBrowserConcurrency: number;
  serperApiKeys:         string[];
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

function parseRapidApiConfigs(host?: string, keys?: string): RapidApiConfig[] {
  if (!host || !keys) return [];
  return parseCsv(keys).map(apiKey => ({ apiKey, host: host.trim() }));
}

export function loadTiktokEnv(): TiktokAppEnv {
  return {
    // Dùng shared env — đảm bảo nhất quán với toàn bộ hệ thống
    maxVideoAgeDays:       sharedEnv.maxVideoAgeDays,
    viralScoreThreshold:   sharedEnv.viralScoreThreshold,
    maxBrowserConcurrency: sharedEnv.browserConcurrency,

    // TikTok-specific
    rapidApiConfigs: parseRapidApiConfigs(process.env["RAPID_API_HOST"], process.env["RAPID_API_KEYS"]),
    crawlRegions:    parseCsv(process.env["CRAWL_REGIONS"]),
    serperApiKeys:   parseCsv(process.env["SERPER_API_KEYS"] ?? process.env["SERPER_API_KEY"]),
  };
}

export const env = loadTiktokEnv();
