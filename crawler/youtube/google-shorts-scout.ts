import { chromium,type BrowserContext,type Page } from "playwright";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readJsonLines } from "../src/core/jsonl.js";

// Cấu hình đường dẫn hệ thống
const EXTENSION_PATH = resolve(process.cwd(), "crawler/extensions/nocaptchaai-extension");
const OUTPUT_FILE = resolve(process.cwd(), "data/youtube/raw_google_output_yt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const LEGACY_TOTAL_FILE = resolve(process.cwd(), "data/total_video.jsonl");

// Cấu hình số luồng chạy song song (Tùy thuộc vào cấu hình RAM máy bạn, test ổn định ở mức 2 - 5 luồng)
const CONCURRENCY = 5; 

/**
 * Ma trận sinh Query: Trộn bộ chữ cái để ép Google lùng sục mọi ngách video Shorts của US
 * Chiến lược: dùng nhiều họ query khác nhau (phrase, intitle, OR, intent) để giảm trùng SERP.
 */
function generateYouTubeShortsQueries(): string[] {
  const queries: string[] = [];
  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
  const suffixes = [...alphabet, ..."0123456789".split("")];

  for (const char1 of alphabet) {
    for (const char2 of suffixes) {
      const keyword = `${char1}${char2}`;

      queries.push(`site:youtube.com/shorts/ "${keyword}"`);
      queries.push(`site:youtube.com/shorts/ ${keyword}`);
      queries.push(`site:youtube.com/shorts/ intitle:"${keyword}"`);
    }
  }

  return Array.from(new Set(queries)).sort(() => Math.random() - 0.5);
}

/**
 * Hàm phân chia mảng query đều cho các Worker
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunked: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}

/**
 * Hàm Trích xuất YouTube Video ID từ URL (Chuỗi 100% chuẩn 11 ký tự đặc trưng của YT)
 * Định dạng nhận diện: https://www.youtube.com/shorts/8u_OTViq_Bg
 */
function extractYouTubeShortsId(url: string | undefined | null): string | null {
  // 1. Kiểm tra đầu vào (Guarding clause): Nếu url không hợp lệ thì té sớm
  if (!url) return null;

  try {
    // 2. Sử dụng optional chaining hoặc lấy an toàn phần tử đầu tiên
    const firstSplit = url.split("?")[0];
    if (!firstSplit) return null;

    const cleanUrl = firstSplit.split("&")[0];
    if (!cleanUrl) return null;

    // 3. Thực hiện quét Regex để bốc tách ID 11 ký tự
    const match = /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(cleanUrl);
    
    // Nếu match hợp lệ và có chứa group 1 (ID video)
    return match && match[1] ? match[1] : null;
  } catch (error) {
    console.error("❌ Lỗi parse URL:", error);
    return null;
  }
}

async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const filePath of [TOTAL_FILE, LEGACY_TOTAL_FILE]) {
    if (!existsSync(filePath)) continue;

    const rows = await readJsonLines<any>(filePath);
    for (const row of rows) {
      const id = String(row?.id ?? row?.videoId ?? row?.video_id ?? "").trim();
      if (id) ids.add(id);
    }
  }

  return ids;
}

/**
 * Logic xử lý lõi của từng Luồng trình duyệt (Worker Context)
 */
async function searchWorker(workerId: number, queries: string[], seenIds: Set<string>) {
  console.log(`[Worker ${workerId}] 🔥 Khởi chạy thành công với ${queries.length} queries.`);

  // Tạo Profile độc lập để cookie và cache của các luồng không đá nhau gây crash
  const userDataDir = resolve(process.cwd(), `data/user_data_worker_${workerId}`);

  const browserContext: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Bắt buộc để false để tiện ích noCaptcha AI hoạt động nhảy click chuột
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const page: Page = await browserContext.newPage();

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]!;
    console.log(`[Worker ${workerId}] [Query ${i + 1}/${queries.length}] 🔍 Google Search: ${query}`);

    try {
      // &tbs=qdr:d -> Chỉ lấy video index trong 24 giờ qua | &num=100 -> Gom tối đa 100 kết quả trên 1 trang
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=qdr:d&num=100&gl=us&hl=en`;
      
      await page.goto(googleUrl, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(3000); 

      // 🚨 BỘ XỬ LÝ TỰ ĐỘNG VƯỢT CAPTCHA CỦA GOOGLE
      if (page.url().includes("google.com/sorry")) {
        console.warn(`[Worker ${workerId}] 🚨 Gặp CAPTCHA! Đang chờ noCaptcha AI Extension tự động giải quyết...`);
        
        await page.waitForURL((url) => !url.href.includes("google.com/sorry"), { timeout: 45000 })
          .then(() => console.log(`[Worker ${workerId}] 🎉 Vượt CAPTCHA thành công!`))
          .catch(() => console.error(`[Worker ${workerId}] ❌ AI giải CAPTCHA quá thời gian (Timeout).`));
      }

      // Trích xuất toàn bộ liên kết chứa youtube.com/shorts từ Google SERP HTML
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a"));
        return Array.from(new Set(anchors.map(a => a.href).filter(href => href.includes("youtube.com/shorts/"))));
      });

      let savedCount = 0;
      for (const link of links) {
        const videoId = extractYouTubeShortsId(link);
        if (!videoId) continue;
        if (seenIds.has(videoId)) continue;

        seenIds.add(videoId);
        const record = {
          id: videoId,
          url: `https://www.youtube.com/shorts/${videoId}`,
          fetchedAt: new Date().toISOString()
        };

        // Ghi trực tiếp bản ghi vào file dạng JSON Lines (Mỗi dòng là một Object JSON hoàn chỉnh)
        appendFileSync(OUTPUT_FILE, JSON.stringify(record) + "\n", "utf-8");
        savedCount++;
      }

      if (savedCount > 0) {
        console.log(`[Worker ${workerId}] 💾 Đã bóc được ${savedCount} Shorts cho vào file gg_output.jsonl.`);
      }

      // Giãn cách nhẹ để tránh Google quét hành vi bot
      await page.waitForTimeout(2000);

    } catch (err: any) {
      console.error(`[Worker ${workerId}] Lỗi xử lý query "${query}": ${err.message}`);
    }
  }

  await browserContext.close();
  console.log(`[Worker ${workerId}] ✅ Hoàn thành nhiệm vụ.`);
}

/**
 * Entrypoint kích hoạt Pipeline Giai đoạn 1
 */
export async function runSearchPipeline() {
  console.log("=======================================================");
  console.log("🚀 KÍCH HOẠT PHASE 1: GOOGLE ADVANCED SEARCH FOR YOUTUBE SHORTS");
  console.log("=======================================================");
  
  // Đảm bảo thư mục dữ liệu tồn tại
  const dataDir = resolve(process.cwd(), "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Raw output is a fresh snapshot for each run.
  writeFileSync(OUTPUT_FILE, "", "utf8");

  const seenIds = await loadExistingIds();

  const allQueries = generateYouTubeShortsQueries();
  console.log(`📦 Tổng số lượng câu lệnh tìm kiếm ma trận: ${allQueries.length}`);

  // Chia nhỏ danh sách cho số luồng Concurrency
  const chunkSize = Math.ceil(allQueries.length / CONCURRENCY);
  const chunks = chunkArray(allQueries, chunkSize);

  console.log(`⚡ Hệ thống kích hoạt ${chunks.length} luồng Browser chạy song song...`);

  // Bấm nút chạy
  await Promise.all(
    chunks.map((chunk, index) => searchWorker(index + 1, chunk, seenIds))
  );

  console.log("\n🏁🏁🏁 HOÀN THÀNH GIAI ĐOẠN 1!");
  console.log(`📊 Kết quả ID và URL thô đã nằm tại: data/youtube/raw_google_output_yt.jsonl`);
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint && import.meta.url === entryPoint) {
  runSearchPipeline().catch(console.error);
}