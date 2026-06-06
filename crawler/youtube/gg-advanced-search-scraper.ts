import "dotenv/config";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { readJsonLines } from "../src/core/jsonl.js";

// Cấu hình đường dẫn hệ thống
const OUTPUT_FILE = path.resolve(process.cwd(), "data/youtube/raw_google_output_yt.jsonl");
const TOTAL_FILE  = path.resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");

// Serper API keys (comma-separated) — bắt buộc phải có trong .env
const SERPER_API_KEYS = (process.env.SERPER_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// Cấu hình số query xử lý song song trong 1 Worker batch
const CONCURRENCY = Number(process.env.SERPER_CONCURRENCY || 5);

const GL        = process.env.CRAWL_REGION    || "us";
const HL        = process.env.CRAWL_LANG      || "en";
const NUM       = Number(process.env.SERPER_NUM       || 100);
const DELAY_MS  = Number(process.env.SERPER_DELAY_MS  || 400);
const MAX_PAGES = Number(process.env.SERPER_MAX_PAGES || 2);

// Regex nhận diện URL YouTube Shorts hợp lệ
const SHORTS_URL_RE = /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]{6,15})/i;

type SerperItem = {
  link?:    string;
  title?:   string;
  snippet?: string;
  date?:    string;
};

type YouTubeSeed = {
  id:        string;
  url:       string;
  fetchedAt: string;
};

/**
 * Ma trận sinh Query: Trộn nhiều chiến lược khác nhau để ép Google lùng sục
 * mọi ngách video YouTube Shorts mới nhất trong 24h qua.
 *
 * Chiến lược phối hợp:
 *   1. site:youtube.com/shorts — nhắm thẳng vào Shorts
 *   2. "youtube shorts" + danh mục — mở rộng topic
 *   3. Quét alphabet — tìm mọi video có từ khoá bất kỳ
 *   4. US location signals — ưu tiên thị trường Mỹ
 */
function generateYouTubeQueries(): string[] {
  const queries: string[] = [];

  const categories = [
    "funny", "meme", "dance", "music", "food", "gaming", "news", "beauty",
    "fashion", "fitness", "travel", "pet", "cat", "dog", "sports", "football",
    "basketball", "nfl", "nba", "soccer", "movie", "anime", "tech", "asmr",
    "reaction", "podcast", "celebrity", "prank", "challenge", "diy", "life hack",
    "motivation", "comedy", "story", "cooking", "health", "workout",
  ];

  const freshness = ["today", "now", "latest", "new", "recent", "2026", "this week"];

  const usSignals = [
    "us", "usa", "america", "american",
    "nyc", "new york", "la", "los angeles", "california",
    "texas", "florida", "chicago", "atlanta", "miami",
  ];

  const baseIntents = [
    "youtube shorts viral",
    "youtube shorts trending",
    "youtube shorts fyp",
    "youtube shorts popular",
    "youtube shorts new",
    "youtube short video",
    "youtube shorts funny",
  ];

  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
  const numbers  = ["1", "2", "3", "4", "5", "2024", "2025", "2026"];

  // ── Chiến lược 1: site:youtube.com/shorts trực tiếp ──────────────────────
  // Hiệu quả nhất — Google index chính xác URL /shorts/
  queries.push("site:youtube.com/shorts");
  for (const cat of categories) {
    queries.push(`site:youtube.com/shorts ${cat}`);
  }
  for (const fresh of freshness) {
    queries.push(`site:youtube.com/shorts ${fresh}`);
  }
  for (const c of alphabet) {
    queries.push(`site:youtube.com/shorts ${c}`);
    queries.push(`site:youtube.com/shorts "${c}"`);
  }
  for (const signal of usSignals) {
    queries.push(`site:youtube.com/shorts ${signal}`);
  }

  // ── Chiến lược 2: "youtube shorts" + danh mục + US ───────────────────────
  for (const intent of baseIntents) {
    queries.push(intent);
    for (const fresh of freshness) {
      queries.push(`${intent} ${fresh}`);
    }
    for (const cat of categories) {
      queries.push(`${intent} ${cat}`);
    }
    for (const signal of usSignals) {
      queries.push(`${intent} ${signal}`);
    }
    for (const c of alphabet) {
      queries.push(`${intent} ${c}`);
    }
    for (const n of numbers) {
      queries.push(`${intent} ${n}`);
    }
  }

  // ── Chiến lược 3: Hashtag nổi bật trên Shorts ────────────────────────────
  const hashtags = [
    "#fyp", "#viral", "#trending", "#foryou", "#shorts",
    "#youtubeshorts", "#usa", "#america", "#american",
    "#funny", "#dance", "#music", "#challenge",
  ];
  for (const tag of hashtags) {
    queries.push(`youtube shorts ${tag}`);
    queries.push(`youtube shorts ${tag} today`);
    queries.push(`site:youtube.com/shorts ${tag}`);
  }

  // ── Chiến lược 4: intitle — tìm theo tiêu đề video ───────────────────────
  for (const cat of categories.slice(0, 15)) {
    queries.push(`site:youtube.com/shorts intitle:"${cat}"`);
    queries.push(`youtube shorts intitle:"${cat}" viral`);
  }

  return Array.from(new Set(queries)).sort(() => Math.random() - 0.5);
}

/**
 * Hàm phân chia mảng query đều cho các Worker batch
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunked: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}

/**
 * Trích xuất YouTube Shorts Video ID từ URL
 * Định dạng: https://www.youtube.com/shorts/VIDEO_ID
 */
function extractShortId(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const cleanUrl = url.split("?")[0]?.split("&")[0];
    if (!cleanUrl) return null;
    const match = SHORTS_URL_RE.exec(cleanUrl);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Load tất cả video ID đã có trong total_vids_yt.jsonl
 * để bỏ qua các ID đã crawl rồi
 */
async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(TOTAL_FILE)) return ids;

  const rows = await readJsonLines<Record<string, unknown>>(TOTAL_FILE);
  for (const row of rows) {
    const id = String(row?.["video_id"] ?? row?.["id"] ?? row?.["videoId"] ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Gọi Serper Video Search API — trả về danh sách kết quả video
 * Dùng endpoint /videos để ưu tiên nhận kết quả YouTube
 */
function serperSearchRequest(
  apiKey: string,
  query:  string,
  page:   number,
): Promise<SerperItem[]> {
  const postData = JSON.stringify({
    q:   query,
    gl:  GL,
    hl:  HL,
    num: NUM,
    tbs: "qdr:d",  // Giới hạn kết quả trong 24h qua
    page,
  });

  const options = {
    hostname: "google.serper.dev",
    port:     443,
    path:     "/videos",
    method:   "POST",
    headers: {
      "X-API-KEY":      apiKey,
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            console.warn(`[Serper] HTTP ${res.statusCode} — ${body.slice(0, 200)}`);
            return resolve([]);
          }
          const json = JSON.parse(body) as { videos?: SerperItem[] };
          resolve(json.videos ?? []);
        } catch {
          console.warn("[Serper] Parse thất bại — bỏ qua response");
          resolve([]);
        }
      });
    });
    req.on("error", (err) => {
      console.warn(`[Serper] Request lỗi: ${err.message}`);
      resolve([]);
    });
    req.write(postData);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Logic xử lý lõi của từng Worker batch
 * Mỗi worker nhận 1 slice query, gọi Serper API tuần tự
 * với key rotation và delay chống rate-limit
 */
async function searchWorker(
  workerId:  number,
  queries:   string[],
  seenIds:   Set<string>,
  keyPool:   string[],
  keyOffset: { value: number },
): Promise<number> {
  console.log(`[Worker ${workerId}] Khởi chạy với ${queries.length} queries.`);
  let savedCount = 0;

  for (let i = 0; i < queries.length; i++) {
    const query  = queries[i]!;
    const apiKey = keyPool[keyOffset.value % keyPool.length]!;
    keyOffset.value++;

    console.log(`[Worker ${workerId}] [${i + 1}/${queries.length}] Query: "${query}"`);

    for (let page = 1; page <= MAX_PAGES; page++) {
      const results = await serperSearchRequest(apiKey, query, page);
      let added = 0;

      for (const item of results) {
        if (!item.link) continue;
        if (!item.link.includes("youtube.com/shorts")) continue;

        const videoId = extractShortId(item.link);
        if (!videoId) continue;
        if (seenIds.has(videoId)) continue;

        seenIds.add(videoId);
        added++;
        savedCount++;

        const seed: YouTubeSeed = {
          id:        videoId,
          url:       `https://www.youtube.com/shorts/${videoId}`,
          fetchedAt: new Date().toISOString(),
        };

        fs.appendFileSync(OUTPUT_FILE, `${JSON.stringify(seed)}\n`, "utf-8");
      }

      if (added > 0) {
        console.log(`[Worker ${workerId}]   page=${page} → +${added} Shorts mới (tổng worker: ${savedCount})`);
      }

      if (page < MAX_PAGES) await sleep(DELAY_MS);
    }

    await sleep(DELAY_MS);
  }

  console.log(`[Worker ${workerId}] Hoàn thành — đã bắt được ${savedCount} Shorts.`);
  return savedCount;
}

/**
 * Entrypoint kích hoạt Pipeline Giai đoạn 1 — YouTube Shorts Discovery
 */
export async function runSearchPipeline(): Promise<void> {
  console.log("=======================================================");
  console.log("KÍCH HOẠT PHASE 1: SERPER SEARCH FOR YOUTUBE SHORTS");
  console.log("=======================================================");

  if (SERPER_API_KEYS.length === 0) {
    throw new Error("Thiếu SERPER_API_KEYS trong .env (comma-separated list)");
  }

  // Đảm bảo thư mục dữ liệu tồn tại
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  // Raw output là snapshot mới cho mỗi lần chạy
  fs.writeFileSync(OUTPUT_FILE, "", "utf8");

  const seenIds = await loadExistingIds();
  console.log(`Đã load ${seenIds.size} video ID từ total_vids_yt.jsonl (sẽ bỏ qua những ID này).`);

  const allQueries = generateYouTubeQueries();
  console.log(`Tổng số câu lệnh tìm kiếm ma trận: ${allQueries.length}`);
  console.log(`Số key Serper: ${SERPER_API_KEYS.length} | Concurrency: ${CONCURRENCY} workers`);

  // Shared key counter để các worker xoay vòng key đồng đều
  const keyOffset = { value: 0 };

  // Chia nhỏ danh sách query cho các worker chạy song song
  const chunkSize = Math.ceil(allQueries.length / CONCURRENCY);
  const chunks    = chunkArray(allQueries, chunkSize);

  console.log(`Kích hoạt ${chunks.length} Worker chạy song song...\n`);

  const counts = await Promise.all(
    chunks.map((chunk, index) =>
      searchWorker(index + 1, chunk, seenIds, SERPER_API_KEYS, keyOffset)
    ),
  );

  const total = counts.reduce((s, n) => s + n, 0);

  console.log("\n=======================================================");
  console.log("HOÀN THÀNH GIAI ĐOẠN 1!");
  console.log(`Tổng YouTube Shorts mới tìm được: ${total}`);
  console.log(`Kết quả ID và URL thô đã nằm tại: data/youtube/raw_google_output_yt.jsonl`);
  console.log("=======================================================");
}


runSearchPipeline().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
