import fs from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { BaseWorker, type BaseWorkerOptions } from "../src/core/base-worker.js";
import type { IVideoRecordCandidate } from "../src/core/types.js";
import { env } from "../src/config/env.js";

// Activate stealth plugin
chromium.use(StealthPlugin());

const HASHTAG_RE = /#([\wÀ-ɏ一-鿿]+)/g;
const GOOGLE_NO_CAPTCHA_EXTENSION_PATH = resolve(process.cwd(), "crawler", "extensions", "nocaptchaai-extension");
const GOOGLE_NO_CAPTCHA_PROFILE_DIR = resolve(process.cwd(), "data", "user_data_worker_google");

function extractYouTubeShortsId(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) {
    return null;
  }

  try {
    const directPatterns = [
      /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
      /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/i,
      /youtu\.be\/([A-Za-z0-9_-]{11})/i,
    ];

    for (const pattern of directPatterns) {
      const match = pattern.exec(rawUrl);
      if (match?.[1]) {
        return match[1];
      }
    }

    const parsedUrl = new URL(rawUrl);
    const redirectTarget = parsedUrl.searchParams.get("q") || parsedUrl.searchParams.get("url");
    if (redirectTarget) {
      return extractYouTubeShortsId(redirectTarget);
    }

    return null;
  } catch {
    return null;
  }
}

function buildGoogleQueries(keywords: string[]): string[] {
  const uniqueKeywords = [...new Set(keywords.map((item) => item.trim()).filter(Boolean))];
  return uniqueKeywords.map((keyword) => `site:youtube.com/shorts/ "${keyword}"`);
}

export interface GoogleSearchResult {
  videoId: string;
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  channelTitle?: string;
}

export interface RawGoogleResult extends GoogleSearchResult {
  keyword: string;
}

// ── Google Stealth Scraper ───────────────────────────────────────────────────
export class GoogleStealthScraper {
  constructor(_legacyApiKey?: string) {}

  async scrapeKeywords(keywords: string[]): Promise<GoogleSearchResult[]> {
    const queries = buildGoogleQueries(keywords);
    if (queries.length === 0) {
      return [];
    }

    console.log(`[GoogleScraper] Running Google noCaptcha discovery with ${queries.length} queries.`);

    const extensionInstalled = fs.existsSync(GOOGLE_NO_CAPTCHA_EXTENSION_PATH);
    const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox"];

    if (extensionInstalled) {
      launchArgs.push(`--disable-extensions-except=${GOOGLE_NO_CAPTCHA_EXTENSION_PATH}`);
      launchArgs.push(`--load-extension=${GOOGLE_NO_CAPTCHA_EXTENSION_PATH}`);
    }

    const context = await chromium.launchPersistentContext(GOOGLE_NO_CAPTCHA_PROFILE_DIR, {
      headless: false,
      args: launchArgs,
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
    });

    const page = await context.newPage();
    const uniqueById = new Map<string, GoogleSearchResult>();
    const MAX_CONSEC_ERRORS = 2;
    let consecErrors = 0;

    try {
      for (let index = 0; index < queries.length; index++) {
        const query = queries[index]!;
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=qdr:d&num=100&gl=us&hl=en`;
        console.log(`[GoogleScraper] Query ${index + 1}/${queries.length}: ${query}`);

        try {
          await page.goto(googleUrl, { waitUntil: "networkidle", timeout: 60_000 });
          await page.waitForTimeout(2_500);

          if (page.url().includes("google.com/sorry")) {
            console.warn("[GoogleScraper] CAPTCHA detected, waiting for noCaptcha extension...");
            await page
              .waitForURL((url) => !url.href.includes("google.com/sorry"), { timeout: 45_000 })
              .catch((captchaErr) => { throw captchaErr; }); // propagate to outer catch
          }

          const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll("a"));
            return anchors.map((item) => item.href).filter((href) => href.includes("youtube.com") || href.includes("youtu.be"));
          });

          consecErrors = 0; // reset on successful page load + extraction

          for (const link of links) {
            const videoId = extractYouTubeShortsId(link);
            if (!videoId) {
              continue;
            }

            if (!uniqueById.has(videoId)) {
              uniqueById.set(videoId, {
                videoId,
                url: `https://www.youtube.com/shorts/${videoId}`,
                title: "",
                snippet: "",
              });
            }
          }
        } catch (error) {
          consecErrors++;
          console.warn(`[GoogleScraper] Query failed (${consecErrors}/${MAX_CONSEC_ERRORS}): ${(error as Error).message}`);
          if (consecErrors >= MAX_CONSEC_ERRORS) {
            console.error("[GoogleScraper] Too many consecutive errors — stopping scraper.");
            break;
          }
        }

        await page.waitForTimeout(1_500);
      }
    } finally {
      await context.close().catch(() => undefined);
    }

    const results = Array.from(uniqueById.values());
    console.log(`[GoogleScraper] Extracted ${results.length} unique YouTube Shorts ids from Google.`);
    return results;
  }
}

// ── Data Normalizer ──────────────────────────────────────────────────────────
export class DataNormalizer {
  private parseMetricValue(text: string | undefined, regex: RegExp): number {
    if (!text) return 0;
    const match = text.match(regex);
    if (!match) return 0;

    const value = parseFloat(match[1]!);
    const unit = match[2]?.toUpperCase();

    if (unit === "M") return value * 1_000_000;
    if (unit === "K") return value * 1_000;
    return value;
  }

  normalize(raw: RawGoogleResult): IVideoRecordCandidate | null {
    const videoId = String(raw.videoId || "").trim();
    if (!videoId) return null;

    const canonicalUrl = `https://www.youtube.com/shorts/${videoId}`;
    const now = new Date().toISOString();

    const snippetText = `${raw.title || ""} ${raw.snippet || ""}`.trim();

    return {
      id: videoId,
      author: raw.channelTitle || "YouTube",
      url: canonicalUrl,
      likes: 0,
      comments: 0,
      views: 0,
      shares: 0,
      saves: 0,
      total_view_growth: 0,
      hashtags: this.extractHashtags(snippetText),
      sound: raw.title || raw.snippet || "YouTube Shorts",
      postDate: raw.publishedAt || now,
      fetchedAt: now
    };
  }

  private extractHashtags(text: string | undefined): string[] {
    if (!text) return [];
    const tags: string[] = [];
    HASHTAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_RE.exec(text)) !== null) {
      tags.push(`#${m[1]!}`);
    }
    return [...new Set(tags)];
  }
}

interface YouTubeVideoDetail {
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
    tags?: string[];
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
}

async function fetchYouTubeVideoDetail(videoId: string): Promise<YouTubeVideoDetail | null> {
  if (!env.youtubeDataApiKey) {
    throw new Error("Missing YOUTUBE_DATA_API_KEY or YT_DATA_API_KEY in env");
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", env.youtubeDataApiKey);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const item = data?.items?.[0];
  return item || null;
}

// ── Google Worker ────────────────────────────────────────────────────────────
export interface GoogleWorkerOptions extends BaseWorkerOptions {
  serperApiKey?: string;
}

export class GoogleWorker extends BaseWorker {
  private readonly scraper: GoogleStealthScraper;
  private readonly normalizer = new DataNormalizer();

  constructor(options: GoogleWorkerOptions) {
    super(options);
    this.scraper = new GoogleStealthScraper(options.serperApiKey);
  }

  private extractHashtags(text: string | undefined): string[] {
    if (!text) return [];
    const tags: string[] = [];
    HASHTAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HASHTAG_RE.exec(text)) !== null) {
      tags.push(`#${match[1]!}`);
    }
    return [...new Set(tags)];
  }

  protected override async collect(): Promise<IVideoRecordCandidate[]> {
    const keywordsFile = resolve(process.cwd(), "data", "keywords.json");
    let keywords = ["fyp", "trending", "viral"];

    if (fs.existsSync(keywordsFile)) {
      try {
        const data = fs.readFileSync(keywordsFile, "utf8");
        keywords = JSON.parse(data) as string[];
      } catch (err: any) {
        console.warn(`[GoogleWorker] Failed to load keywords.json: ${err.message}. Using defaults.`);
      }
    }

    console.log(`[GoogleWorker] Starting Google noCaptcha discovery for keywords: ${keywords.join(", ")}`);
    const candidatesMap = new Map<string, IVideoRecordCandidate>();

    const rawResults = await this.scraper.scrapeKeywords(keywords);
    for (const raw of rawResults) {
      const candidate = this.normalizer.normalize({ ...raw, keyword: "google-scout" });
      if (candidate && candidate.id) {
        candidatesMap.set(candidate.id, candidate);
      }
    }

    const uniqueCandidates = Array.from(candidatesMap.values());
    console.log(`[GoogleWorker] Google discovery yielded ${uniqueCandidates.length} unique candidates. Starting YouTube Data API enrichment...`);

    const enrichedCandidates: IVideoRecordCandidate[] = [];
    
    // Concurrency pool for detail page enrichment
    const concurrency = env.enricherConcurrency;
    let index = 0;

    const MAX_ENRICH_CONSEC_ERRORS = 2;

    const worker = async () => {
      let consecEnrichErrors = 0;

      while (index < uniqueCandidates.length) {
        const candidate = uniqueCandidates[index++];
        if (!candidate || !candidate.id) continue;

        console.log(`[GoogleWorker] Enriching [${index}/${uniqueCandidates.length}] video ID: ${candidate.id}`);
        let detail: YouTubeVideoDetail | null = null;
        try {
          detail = await fetchYouTubeVideoDetail(candidate.id);
        } catch (err: any) {
          console.warn(`[GoogleWorker] API error for ${candidate.id}: ${err.message}`);
        }

        if (!detail) {
          // Retry once after 2 seconds
          await new Promise((r) => setTimeout(r, 2000));
          try {
            detail = await fetchYouTubeVideoDetail(candidate.id);
          } catch { /* ignore retry error */ }
        }

        if (!detail) {
          consecEnrichErrors++;
          console.warn(`[GoogleWorker] Enrichment failed for ${candidate.id} — consecutive failures: ${consecEnrichErrors}/${MAX_ENRICH_CONSEC_ERRORS}`);
          if (consecEnrichErrors >= MAX_ENRICH_CONSEC_ERRORS) {
            console.error("[GoogleWorker] Too many consecutive API failures — stopping enricher.");
            break;
          }
          const humanDelay = Math.floor(Math.random() * 3000) + 3000;
          await new Promise((r) => setTimeout(r, humanDelay));
          continue;
        }

        consecEnrichErrors = 0;

        const snippet = detail.snippet ?? {};
        const stats = detail.statistics ?? {};

        const patch: Partial<IVideoRecordCandidate> = {
          author: snippet.channelTitle || candidate.author || "YouTube",
          likes: Math.max(Number(candidate.likes ?? 0), Number(stats.likeCount ?? 0)),
          views: Number(stats.viewCount ?? 0),
          comments: Number(stats.commentCount ?? 0),
          shares: 0,
          saves: 0,
          total_view_growth: 0,
          hashtags: this.extractHashtags(`${snippet.title || ""} ${snippet.description || ""}`),
          url: candidate.url || `https://www.youtube.com/shorts/${candidate.id}`,
          sound: snippet.title || candidate.sound || "YouTube Shorts",
        };

        if (snippet.publishedAt) {
          patch.postDate = new Date(snippet.publishedAt).toISOString();
        }

        enrichedCandidates.push({
          ...candidate,
          ...patch,
        });

        // Random delay 3-6s simulated human delay between enrichment crawls
        const humanDelay = Math.floor(Math.random() * 3000) + 3000;
        await new Promise((r) => setTimeout(r, humanDelay));
      }
    };

    const pool = Array.from({ length: concurrency }, () => worker());
    await Promise.all(pool);

    console.log(`[GoogleWorker] Enrichment complete! Enriched ${enrichedCandidates.length} videos.`);
    return enrichedCandidates;
  }
}
