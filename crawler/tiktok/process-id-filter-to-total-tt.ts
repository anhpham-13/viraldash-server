import { existsSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";
import { env } from "../src/config/env.js";
import { getDb, ensureIndexes, upsertVideo } from "../../shared/db/index.js";
import type { RawCrawlerRecord } from "../../shared/types/index.js";

chromium.use(StealthPlugin());

const ID_FILTER_FILE = resolve(process.cwd(), "data/tiktok/id_filter_tt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/tiktok/total_vids_tt.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/tiktok/viral_vids_tt.jsonl");

interface TikTokItemStruct {
  stats?: { diggCount?: number; playCount?: number; commentCount?: number; shareCount?: number; collectCount?: number; };
  author?: { uniqueId?: string; nickname?: string };
  createTime?: number;
  music?: { id?: string; title?: string; authorName?: string };
  desc?: string;
  challenges?: Array<{ title?: string }>;
}

// ─── RawCrawlerRecord normalization ──────────────────────────────────────────
function toRawRecord(
  id: string,
  url: string,
  detail: TikTokItemStruct,
  stats: { views: number; likes: number; comments: number; shares: number; saves: number; hashtags: string[]; sound: string },
): RawCrawlerRecord {
  const now = new Date();
  return {
    video_id:     id,
    platform:     "TikTok",
    url,
    published_at: detail.createTime ? new Date(detail.createTime * 1000) : now,
    author:       String(detail.author?.uniqueId || "").trim() || "TikTok",
    hashtags:     stats.hashtags,
    ...(stats.sound && { sound: stats.sound }),
    view_count:   stats.views,
    likes:        stats.likes,
    comments:     stats.comments,
    shares:       stats.shares,
    saves:        stats.saves,
    fetched_at:   now,
  };
}

async function fetchPageDetail(videoId: string, username: string): Promise<TikTokItemStruct | null> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,720"]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-US"
  });

  const page = await context.newPage();
  const url = `https://www.tiktok.com/@${username || "user"}/video/${videoId}`;
  let extractedData: TikTokItemStruct | null = null;

  try {
    page.on("response", async (response) => {
      const reqUrl = response.url();
      if (reqUrl.includes("/api/item/detail") || reqUrl.includes("/api/video/detail")) {
        try {
          if (response.status() === 200) {
            const json = await response.json();
            if (json?.itemInfo?.itemStruct) {
              extractedData = json.itemInfo.itemStruct;
            }
          }
        } catch (_) { }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(3000);

    if (!extractedData) {
      extractedData = await page.evaluate(() => {
        const nextDataEl = document.getElementById("__NEXT_DATA__");
        if (nextDataEl?.textContent) {
          const data = JSON.parse(nextDataEl.textContent);
          return data.props?.pageProps?.itemInfo?.itemStruct ?? data.props?.pageProps?.videoData?.itemInfo?.itemStruct ?? null;
        }
        const universalEl = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
        if (universalEl?.textContent) {
          const data = JSON.parse(universalEl.textContent);
          return data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ?? null;
        }
        return null;
      });
    }

    return extractedData;
  } catch (error: any) {
    console.error(`[TikTokEnricher] Error scraping video ${videoId}: ${error.message}`);
    return null;
  } finally {
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
  }
}

export async function runProcessIdFilterToTotal(): Promise<void> {
  // ── MongoDB init (graceful degradation if not available) ─────────────────
  let mongoAvailable = false;
  try {
    const db = await getDb();
    await ensureIndexes(db);
    mongoAvailable = true;
  } catch (err: any) {
    console.warn(`[MongoDB] Not available — running JSONL-only: ${(err as Error).message}`);
  }

  if (!existsSync(ID_FILTER_FILE)) {
    throw new Error(`Input file not found: ${ID_FILTER_FILE}`);
  }

  const rows = await readJsonLines<any>(ID_FILTER_FILE);
  const queue = [...rows];

  console.log(`Loaded ${queue.length} queued ids from id_filter.`);

  if (queue.length === 0) {
    console.log("No ids found to call API for.");
    return;
  }

  const concurrency = process.env.ENRICHER_CONCURRENCY ? parseInt(process.env.ENRICHER_CONCURRENCY, 10) : 5;
  console.log(`Starting Playwright enrichment with concurrency ${concurrency}...`);

  let index = 0;
  let savedCount = 0;
  let viralSavedCount = 0;
  const MAX_CONSEC_ERRORS = 2;

  const worker = async () => {
    let consecErrors = 0;

    while (index < rows.length) {
      const item = rows[index++];
      const id = String(item?.id ?? "").trim();
      const author = String(item?.author ?? "").trim();
      if (!id) continue;

      console.log(`[TikTokEnricher] Enriching [${index}/${rows.length}] video ID: ${id}`);
      let detail = await fetchPageDetail(id, author);

      if (!detail) {
        // Retry once
        await new Promise((r) => setTimeout(r, 2000));
        detail = await fetchPageDetail(id, author);
      }

      if (!detail) {
        consecErrors++;
        console.warn(`[TikTokEnricher] No detail for ${id} — consecutive failures: ${consecErrors}/${MAX_CONSEC_ERRORS}`);
        if (consecErrors >= MAX_CONSEC_ERRORS) {
          console.error("[TikTokEnricher] Too many consecutive failures — stopping worker.");
          break;
        }
        const humanDelay = Math.floor(Math.random() * 2000) + 1000;
        await new Promise((r) => setTimeout(r, humanDelay));
        continue;
      }

      consecErrors = 0;

      if (detail) {
        const stats = detail.stats;
        const createTime = detail.createTime ? new Date(detail.createTime * 1000).toISOString() : new Date().toISOString();

        let sound = "Original sound";
        if (detail.music) {
          const title = detail.music.title || "";
          const authorName = detail.music.authorName || "";
          sound = title && authorName ? `${title} - ${authorName}` : title || authorName || sound;
        }

        const tags = (detail.challenges || []).map(c => `#${c.title}`).filter(Boolean);

        const record = {
          id,
          platform: "TikTok",
          postDate: createTime,
          hashtags: tags,
          views: Number(stats?.playCount) || 0,
          likes: Number(stats?.diggCount) || 0,
          comments: Number(stats?.commentCount) || 0,
          saves: Number(stats?.collectCount) || 0,
          shares: Number(stats?.shareCount) || 0,
          total_view_growth: 0,
          url: item.url || `https://www.tiktok.com/@${author || "user"}/video/${id}`,
          fetchedAt: new Date().toISOString(),
          sound,
          author: detail.author?.uniqueId || author,
        };

        appendFileSync(TOTAL_FILE, `${JSON.stringify(record)}\n`, "utf8");
        savedCount++;

        // Calculate viral metrics — only viral records go to MongoDB
        const postMs = new Date(record.postDate || new Date().toISOString()).getTime();
        if (Number.isFinite(postMs) && (Date.now() - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24) {
          const viralRecord = withViralMetrics(record, "tiktok");
          if (viralRecord.video_phase !== "rejected") {
            appendFileSync(VIRAL_FILE, `${JSON.stringify(viralRecord)}\n`, "utf8");
            viralSavedCount++;
            // Only confirmed viral (not seeds) go to MongoDB to avoid score=0 noise.
            if (mongoAvailable && viralRecord.video_phase === "viral") {
              const rawRecord = toRawRecord(id, record.url, detail, record);
              await upsertVideo(rawRecord).catch((e: Error) =>
                console.warn(`[MongoDB] upsert failed ${id}: ${e.message}`)
              );
            }
          }
        }
      } else {
        console.warn(`[TikTokEnricher] Enrichment failed for video ID ${id}`);
      }

      const humanDelay = Math.floor(Math.random() * 2000) + 1000;
      await new Promise((r) => setTimeout(r, humanDelay));
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(pool);

  console.log(`Wrote ${savedCount} new records to ${TOTAL_FILE}`);
  console.log(`Wrote ${viralSavedCount} new viral records to ${VIRAL_FILE}`);
  console.log("Done.");
}


if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("process-id-filter-to-total-tt.ts")) {
  runProcessIdFilterToTotal().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

