import "dotenv/config";
import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";

const ID_FILTER_FILE = resolve(process.cwd(), "data/instagram/id_filter_ig.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/instagram/total_posts_ig.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/instagram/viral_posts_ig.jsonl");

const RAPID_API_HOST = process.env.RAPID_API_IG_HOST || "instagram-scraper-api2.p.rapidapi.com";
const RAPID_API_KEYS = (process.env.RAPID_API_IG_KEYS || process.env.RAPID_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const MAX_POST_AGE_DAYS = Number(process.env.MAX_VIDEO_AGE_DAYS || 1);
const VIRAL_SCORE_THRESHOLD = Number(process.env.VIRAL_SCORE_THRESHOLD || 98);

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchRapidDetail(shortCode: string): Promise<any | null> {
  const apiKey = RAPID_API_KEYS[0];
  if (!apiKey) {
    throw new Error("No RapidAPI key found. Set RAPID_API_IG_KEYS in .env");
  }

  const url = `https://${RAPID_API_HOST}/v1/post_info?code_or_id_or_url=${shortCode}`;

  try {
    const response = await fetch(url, {
      headers: {
        "x-rapidapi-key": apiKey,
        "x-rapidapi-host": RAPID_API_HOST,
        "Content-Type": "application/json",
        "user-agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      console.warn(`[RapidEnricher-IG] API call failed: ${response.status} ${response.statusText} for post ${shortCode}`);
      return null;
    }

    const json = await response.json();
    return json;
  } catch (error: any) {
    console.error(`[RapidEnricher-IG] Network error for post ${shortCode}:`, error.message);
    return null;
  }
}

export async function runRapidWorker() {
  if (!existsSync(ID_FILTER_FILE)) {
    throw new Error(`Input file not found: ${ID_FILTER_FILE}`);
  }

  if (RAPID_API_KEYS.length === 0) {
    throw new Error("Missing RAPID_API_IG_KEYS in .env");
  }

  const rows = await readJsonLines<any>(ID_FILTER_FILE);
  const queue = [...rows];

  console.log(`Loaded ${queue.length} queued ids from id_filter.`);

  if (queue.length === 0) {
    console.log("No ids found to call API for.");
    return;
  }

  // RapidAPI has strict rate limits on free plans — keep concurrency low
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

      console.log(`[RapidEnricher-IG] Enriching [${index}/${rows.length}] post ID: ${id}`);
      let payload = await fetchRapidDetail(id);

      // On error (e.g. 429 Too Many Requests) wait longer then retry once
      if (!payload || !payload.data) {
        console.warn(`[RapidEnricher-IG] API failed for ${id}. Waiting 10 seconds before retry to avoid 429...`);
        await delay(10000);
        payload = await fetchRapidDetail(id);
      }

      if (!payload || !payload.data) {
        consecErrors++;
        console.warn(`[RapidEnricher-IG] Still no data for ${id} — consecutive failures: ${consecErrors}/${MAX_CONSEC_ERRORS}`);
        if (consecErrors >= MAX_CONSEC_ERRORS) {
          console.error("[RapidEnricher-IG] Too many consecutive failures — stopping worker.");
          break;
        }
        await delay(delayMs);
        continue;
      }

      consecErrors = 0;

      if (payload && payload.data) {
        const post = payload.data;

        const createTime = post.taken_at_timestamp
          ? new Date(post.taken_at_timestamp * 1000).toISOString()
          : new Date().toISOString();

        const shortCode = post.shortCode || post.short_code || id;
        const username = post.owner?.username || author || "user";

        const caption: string = post.caption || post.edge_media_to_caption?.edges?.[0]?.node?.text || "";
        const tags = (caption.match(/#[\w]+/g) || []);

        const record = {
          id,
          platform: "Instagram",
          postDate: createTime,
          hashtags: tags,
          views: post.video_view_count ?? post.video_play_count ?? 0,
          likes: post.like_count ?? post.likes_count ?? 0,
          comments: post.comments_count ?? post.edge_media_to_comment?.count ?? 0,
          saves: 0, // Instagram API does not expose save count
          shares: 0, // Instagram API does not expose share count
          total_view_growth: 0,
          url: item.url || `https://www.instagram.com/reel/${shortCode}/`,
          fetchedAt: new Date().toISOString(),
          sound: post.clips_music_attribution_info?.song_name
            ? `${post.clips_music_attribution_info.song_name} - ${post.clips_music_attribution_info.artist_name || ""}`
            : "Original audio",
          author: username,
        };

        appendFileSync(TOTAL_FILE, `${JSON.stringify(record)}\n`, "utf8");
        savedCount++;

        const postMs = new Date(record.postDate).getTime();
        if (Number.isFinite(postMs) && (Date.now() - postMs) / 3_600_000 <= MAX_POST_AGE_DAYS * 24) {
          const viralRecord = withViralMetrics(record as any, "instagram");
          if (viralRecord.video_phase !== "rejected") {
            viralRecord.url = viralRecord.url.replace(/\/reel[s]?\//, '/p/');
            appendFileSync(VIRAL_FILE, `${JSON.stringify(viralRecord)}\n`, "utf8");
            viralSavedCount++;
          }
        }
      } else {
        console.warn(`[RapidEnricher-IG] Enrichment failed for post ID ${id}`);
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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("rapid-instagram.ts")) {
  runRapidWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
