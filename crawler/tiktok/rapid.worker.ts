import "dotenv/config";
import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";
import { isMain } from "../src/core/is-main.js";
import { env } from "./config/env.js";

const ID_FILTER_FILE = resolve(process.cwd(), "data/tiktok/id_filter_tt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/tiktok/total_vids_tt.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/tiktok/viral_vids_tt.jsonl");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchRapidDetail(videoId: string): Promise<any | null> {
  const config = env.rapidApiConfigs[0]; // Lấy key đầu tiên trong cấu hình
  if (!config) {
    throw new Error("No RapidAPI config found in env");
  }

  // Dựa vào rapid_snippit.txt
  // Path: /v1/post/7645024712342490386?region=US
  const host = "tokapi-mobile-version.p.rapidapi.com"; 
  const region = env.crawlRegions[0] || "US";
  const path = `/v1/post/${videoId}?region=${region}`;
  
  try {
    const url = `https://${host}${path}`;
    
    const response = await fetch(url, {
      headers: {
        "x-rapidapi-key": config.apiKey,
        "x-rapidapi-host": host,
        "Content-Type": "application/json",
        "user-agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      console.warn(`[RapidEnricher] API call failed: ${response.status} ${response.statusText} for video ${videoId}`);
      return null;
    }

    const json = await response.json();
    return json;
  } catch (error: any) {
    console.error(`[RapidEnricher] Network error for video ${videoId}:`, error.message);
    return null;
  }
}

export async function runRapidWorker() {
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

  // Rapid API thường có rate limit gắt gao (đặc biệt bản free), ta nên chạy concurrency = 1 và delay hợp lý
  const concurrency = process.env.RAPID_CONCURRENCY ? parseInt(process.env.RAPID_CONCURRENCY, 10) : 1;
  const delayMs = process.env.RAPID_DELAY_MS ? parseInt(process.env.RAPID_DELAY_MS, 10) : 2000;
  console.log(`Starting RapidAPI enrichment with concurrency ${concurrency} and delay ${delayMs}ms...`);

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

      console.log(`[RapidEnricher] Enriching [${index}/${rows.length}] video ID: ${id}`);
      let payload = await fetchRapidDetail(id);

      // Nếu gặp lỗi (như 429 Too Many Requests), chờ lâu hơn rồi thử lại
      if (!payload || !payload.aweme_detail) {
        console.warn(`[RapidEnricher] API failed for ${id}. Waiting 10 seconds before retry to avoid 429...`);
        await delay(10000);
        payload = await fetchRapidDetail(id);
      }

      if (!payload || !payload.aweme_detail) {
        consecErrors++;
        console.warn(`[RapidEnricher] Still no data for ${id} — consecutive failures: ${consecErrors}/${MAX_CONSEC_ERRORS}`);
        if (consecErrors >= MAX_CONSEC_ERRORS) {
          console.error("[RapidEnricher] Too many consecutive failures — stopping worker.");
          break;
        }
        await delay(delayMs);
        continue;
      }

      consecErrors = 0;

      if (payload && payload.aweme_detail) {
        const aweme = payload.aweme_detail;
        const stats = aweme.statistics;
        const createTime = aweme.create_time ? new Date(aweme.create_time * 1000).toISOString() : new Date().toISOString();

        let sound = "Original sound";
        if (aweme.music) {
          const title = aweme.music.title || "";
          const authorName = aweme.music.author || aweme.music.owner_nickname || "";
          sound = title && authorName ? `${title} - ${authorName}` : title || authorName || sound;
        }

        const tags = (aweme.text_extra || [])
          .map((t: any) => t.hashtag_name ? `#${t.hashtag_name}` : "")
          .filter(Boolean);

        const record = {
          id,
          platform: "TikTok",
          postDate: createTime,
          hashtags: tags,
          views: Number(stats?.play_count) || 0,
          likes: Number(stats?.digg_count) || 0,
          comments: Number(stats?.comment_count) || 0,
          saves: Number(stats?.collect_count) || 0,
          shares: Number(stats?.share_count) || 0,
          total_view_growth: 0,
          url: item.url || `https://www.tiktok.com/@${aweme.author?.unique_id || author || "user"}/video/${id}`,
          fetchedAt: new Date().toISOString(),
          sound,
          author: aweme.author?.unique_id || author,
        };

        appendFileSync(TOTAL_FILE, `${JSON.stringify(record)}\n`, "utf8");
        savedCount++;

        // Calculate viral metrics and append immediately
        const postMs = new Date(record.postDate || new Date().toISOString()).getTime();
        if (Number.isFinite(postMs) && (Date.now() - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24) {
          const viralRecord = withViralMetrics(record, "tiktok");
          if (viralRecord.video_phase !== "rejected") {
            appendFileSync(VIRAL_FILE, `${JSON.stringify(viralRecord)}\n`, "utf8");
            viralSavedCount++;
          }
        }
      } else {
        console.warn(`[RapidEnricher] Enrichment failed for video ID ${id}`);
      }

      await delay(delayMs);
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, rows.length) }, () => worker());
  await Promise.all(pool);

  console.log(`Wrote ${savedCount} new records to ${TOTAL_FILE}`);
  console.log(`Wrote ${viralSavedCount} new viral records to ${VIRAL_FILE}`);
  console.log("Done.");
}

// Allow running standalone
if (isMain(import.meta.url)) {
  runRapidWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
