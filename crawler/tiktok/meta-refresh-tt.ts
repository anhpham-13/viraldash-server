import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getDb, ensureIndexes, findViralSeeds } from "../../shared/db/index.js";
import { env } from "../src/config/env.js";
import { runMetaRefresh, type RefreshSeed } from "../src/core/meta-refresh-base.js";
import type { RawCrawlerRecord } from "../../shared/types/index.js";

chromium.use(StealthPlugin());

// ─── TikTok page fetcher (mirrors logic in process-id-filter-to-total-tt.ts) ─

interface TikTokItemStruct {
  stats?:      { diggCount?: number; playCount?: number; commentCount?: number; shareCount?: number; collectCount?: number };
  author?:     { uniqueId?: string; nickname?: string };
  createTime?: number;
  music?:      { id?: string; title?: string; authorName?: string };
  desc?:       string;
  challenges?: Array<{ title?: string }>;
}

async function fetchTikTokDetail(videoId: string, username: string): Promise<TikTokItemStruct | null> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,720"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
  });

  const page = await context.newPage();
  const url = `https://www.tiktok.com/@${username || "user"}/video/${videoId}`;
  let extracted: TikTokItemStruct | null = null;

  try {
    page.on("response", async (res) => {
      const reqUrl = res.url();
      if (reqUrl.includes("/api/item/detail") || reqUrl.includes("/api/video/detail")) {
        try {
          if (res.status() === 200) {
            const json = await res.json();
            if (json?.itemInfo?.itemStruct) extracted = json.itemInfo.itemStruct;
          }
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(3_000);

    if (!extracted) {
      extracted = await page.evaluate(() => {
        const nd = document.getElementById("__NEXT_DATA__");
        if (nd?.textContent) {
          const d = JSON.parse(nd.textContent);
          return d.props?.pageProps?.itemInfo?.itemStruct ?? d.props?.pageProps?.videoData?.itemInfo?.itemStruct ?? null;
        }
        const ud = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
        if (ud?.textContent) {
          const d = JSON.parse(ud.textContent);
          return d.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct ?? null;
        }
        return null;
      });
    }

    return extracted;
  } catch (err: any) {
    console.warn(`[TtRefresh] Error scraping ${videoId}: ${(err as Error).message}`);
    return null;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function toRawRecord(seed: RefreshSeed, detail: TikTokItemStruct): RawCrawlerRecord {
  const now    = new Date();
  const stats  = detail.stats;
  const sound  = detail.music
    ? (detail.music.title && detail.music.authorName
        ? `${detail.music.title} - ${detail.music.authorName}`
        : detail.music.title ?? detail.music.authorName ?? "")
    : "";
  const hashtags = (detail.challenges ?? []).map(c => `#${c.title}`).filter(Boolean);

  return {
    video_id:     seed.video_id,
    platform:     "TikTok",
    url:          seed.url,
    published_at: detail.createTime ? new Date(detail.createTime * 1000) : now,
    author:       String(detail.author?.uniqueId || seed.author || "TikTok").trim(),
    hashtags,
    ...(sound && { sound }),
    view_count:   Number(stats?.playCount)    || 0,
    likes:        Number(stats?.diggCount)    || 0,
    comments:     Number(stats?.commentCount) || 0,
    shares:       Number(stats?.shareCount)   || 0,
    saves:        Number(stats?.collectCount) || 0,
    fetched_at:   now,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const db = await getDb();
  await ensureIndexes(db);

  const seeds = await findViralSeeds(
    "TikTok",
    env.refreshMaxAgeHours,
    env.refreshIntervalHours,
  );

  if (seeds.length === 0) {
    console.log("[TtRefresh] No stale seeds to refresh.");
    return;
  }

  console.log(`[TtRefresh] Refreshing ${seeds.length} TikTok videos…`);

  await runMetaRefresh(
    seeds,
    async (seed) => {
      const detail = await fetchTikTokDetail(seed.video_id, seed.author);
      return detail ? toRawRecord(seed, detail) : null;
    },
    {
      concurrency: env.browserConcurrency,
      delayMs:     env.humanDelayMinMs,
      retryOnce:   true,
    },
  );
}

run().catch(err => { console.error(err); process.exitCode = 1; });
