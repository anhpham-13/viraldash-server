import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";
import { env } from "../src/config/env.js";

chromium.use(StealthPlugin());

const VIRAL_FILE = resolve(process.cwd(), "data/tiktok/viral_vids_tt.jsonl");
const SEED_FILE = resolve(process.cwd(), "data/tiktok/seed_id_viral.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/tiktok/total_vids_tt.jsonl");

interface TikTokItemStruct {
  stats?: { diggCount?: number; playCount?: number; commentCount?: number; shareCount?: number; collectCount?: number };
  author?: { uniqueId?: string; nickname?: string };
  createTime?: number;
  music?: { id?: string; title?: string; authorName?: string };
  desc?: string;
  challenges?: Array<{ title?: string }>;
}

async function fetchPageDetail(videoId: string, username: string): Promise<TikTokItemStruct | null> {
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
  let extractedData: TikTokItemStruct | null = null;

  try {
    page.on("response", async (response) => {
      const reqUrl = response.url();
      if (reqUrl.includes("/api/item/detail") || reqUrl.includes("/api/video/detail")) {
        try {
          if (response.status() === 200) {
            const json = await response.json();
            if (json?.itemInfo?.itemStruct) extractedData = json.itemInfo.itemStruct;
          }
        } catch (_) {}
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
    console.error(`[ViralRefresh] Error scraping video ${videoId}: ${error.message}`);
    return null;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function buildSeedFile(): Promise<Array<{ id: string; author: string; url: string }>> {
  if (!existsSync(VIRAL_FILE)) throw new Error(`Viral file not found: ${VIRAL_FILE}`);

  const viralRows = await readJsonLines<any>(VIRAL_FILE);
  const seen = new Set<string>();
  const seeds: Array<{ id: string; author: string; url: string }> = [];

  for (const row of viralRows) {
    const id = String(row?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seeds.push({
      id,
      author: String(row?.author ?? "").trim(),
      url: String(row?.url ?? `https://www.tiktok.com/@${row?.author || "user"}/video/${id}`),
    });
  }

  writeFileSync(SEED_FILE, seeds.map((s) => JSON.stringify(s)).join("\n") + (seeds.length ? "\n" : ""), "utf8");
  console.log(`[ViralRefresh] Wrote ${seeds.length} seed IDs → ${SEED_FILE}`);
  return seeds;
}

async function refreshViralVids(): Promise<void> {
  // Step 1: Extract IDs from viral file → seed file
  const seeds = await buildSeedFile();
  if (seeds.length === 0) {
    console.log("[ViralRefresh] No viral videos to refresh.");
    return;
  }

  // Step 2: Load total_vids_tt into a Map keyed by id for in-place update
  const totalRows: any[] = existsSync(TOTAL_FILE) ? await readJsonLines<any>(TOTAL_FILE) : [];
  const totalMap = new Map<string, any>(totalRows.map((r) => [String(r?.id ?? ""), r]));

  const concurrency = env.enricherConcurrency;
  console.log(`[ViralRefresh] Refreshing ${seeds.length} viral videos with concurrency ${concurrency}...`);

  let index = 0;
  let updatedCount = 0;

  const worker = async () => {
    while (index < seeds.length) {
      const seed = seeds[index++]!;
      console.log(`[ViralRefresh] [${index}/${seeds.length}] Fetching ID: ${seed.id}`);

      let detail = await fetchPageDetail(seed.id, seed.author);
      if (!detail) {
        await new Promise((r) => setTimeout(r, 2000));
        detail = await fetchPageDetail(seed.id, seed.author);
      }

      if (!detail) {
        console.warn(`[ViralRefresh] Failed to fetch detail for ${seed.id}, skipping.`);
        const humanDelay = Math.floor(Math.random() * 2000) + 1000;
        await new Promise((r) => setTimeout(r, humanDelay));
        continue;
      }

      const stats = detail.stats;
      const createTime = detail.createTime ? new Date(detail.createTime * 1000).toISOString() : undefined;

      let sound = "Original sound";
      if (detail.music) {
        const title = detail.music.title ?? "";
        const authorName = detail.music.authorName ?? "";
        sound = title && authorName ? `${title} - ${authorName}` : title || authorName || sound;
      }

      const tags = (detail.challenges ?? []).map((c) => `#${c.title}`).filter(Boolean);

      // Merge fresh data onto existing record (preserve fields not returned by API)
      const existing = totalMap.get(seed.id) ?? {};
      const updated = {
        ...existing,
        id: seed.id,
        platform: "TikTok",
        ...(createTime ? { postDate: createTime } : {}),
        hashtags: tags.length ? tags : existing.hashtags,
        views: Number(stats?.playCount) || existing.views || 0,
        likes: Number(stats?.diggCount) || existing.likes || 0,
        comments: Number(stats?.commentCount) || existing.comments || 0,
        saves: Number(stats?.collectCount) || existing.saves || 0,
        shares: Number(stats?.shareCount) || existing.shares || 0,
        url: seed.url || existing.url,
        fetchedAt: new Date().toISOString(),
        sound,
        author: detail.author?.uniqueId || seed.author || existing.author,
      };

      totalMap.set(seed.id, updated);
      updatedCount++;

      const humanDelay = Math.floor(Math.random() * 2000) + 1000;
      await new Promise((r) => setTimeout(r, humanDelay));
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, seeds.length) }, () => worker());
  await Promise.all(pool);

  // Step 3: Write updated total_vids_tt (all rows, refreshed ones replaced in-place)
  const allTotal = Array.from(totalMap.values());
  await writeJsonLines(TOTAL_FILE, allTotal);
  console.log(`[ViralRefresh] Updated ${updatedCount} records in ${TOTAL_FILE}`);

  // Step 4: Re-calculate viral score for refreshed IDs; overwrite viral_vids_tt
  const refreshedIds = new Set(seeds.map((s) => s.id));
  const viralRecords: any[] = [];

  for (const row of allTotal) {
    const id = String(row?.id ?? "");
    if (!refreshedIds.has(id)) continue;

    const postMs = new Date(row.postDate ?? "").getTime();
    if (!Number.isFinite(postMs) || (Date.now() - postMs) / 3_600_000 > env.maxVideoAgeDays * 24) continue;

    const scored = withViralMetrics(row, "tiktok");
    if (scored.video_phase !== "rejected") viralRecords.push(scored);
  }

  await writeJsonLines(VIRAL_FILE, viralRecords);
  console.log(`[ViralRefresh] Overwrote ${VIRAL_FILE} with ${viralRecords.length} viral records.`);
  console.log("[ViralRefresh] Done.");
}

refreshViralVids().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
