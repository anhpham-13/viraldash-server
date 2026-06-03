import "dotenv/config";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const OUTPUT_FILE = path.resolve(
  process.cwd(),
  "data/instagram/raw_google_output_ig.jsonl"
);

const SERPER_API_KEYS = (process.env.SERPER_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const GL = process.env.CRAWL_REGION || "us";
const HL = process.env.CRAWL_LANG || "en";
const NUM = Number(process.env.SERPER_NUM || 100);
const DELAY_MS = Number(process.env.SERPER_DELAY_MS || 500);
const MAX_PAGES = Number(process.env.SERPER_MAX_PAGES || 2);

const REEL_URL_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p)\/([\w-]+)/i;

type SerperItem = {
  link?: string;
  title?: string;
  snippet?: string;
  date?: string;
};

type InstagramSeed = {
  id: string;
  url: string;
  fetchedAt: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQueries(): string[] {
  const intents = [
    "instagram reels viral us",
    "instagram reels trending us",
    "instagram reels fyp us",
    "instagram reels popular us",
    "instagram reel new trend us",
    "instagram reel latest trend us",
    "instagram reel today us",
    "instagram reel video us",
  ];

  const freshness = [
    "today",
    "now",
    "latest",
    "new",
    "recent",
    "24 hours",
  ];

  const categories = [
    "funny",
    "meme",
    "dance",
    "music",
    "food",
    "gaming",
    "news",
    "beauty",
    "fashion",
    "fitness",
    "travel",
    "pet",
    "cat",
    "dog",
    "sports",
    "football",
    "basketball",
    "nfl",
    "nba",
    "movie",
    "anime",
    "tech",
    "story",
    "asmr",
    "reaction",
    "podcast",
    "celebrity",
    "college",
    "school",
    "work",
    "relationship",
  ];

  const usSignals = [
    "us",
    "usa",
    "america",
    "american",
    "nyc",
    "new york",
    "la",
    "los angeles",
    "california",
    "texas",
    "florida",
    "chicago",
    "atlanta",
    "miami",
  ];

  const hashtags = [
    "#fyp",
    "#viral",
    "#trending",
    "#foryou",
    "#reels",
    "#instareels",
    "#usa",
    "#america",
    "#american",
    "#nyc",
    "#la",
  ];

  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("");
  const numbers = ["1", "2", "3", "4", "5", "2026"];

  const queries: string[] = [];

  for (const intent of intents) {
    queries.push(intent);

    for (const fresh of freshness) {
      queries.push(`${intent} ${fresh}`);
    }

    for (const category of categories) {
      queries.push(`${intent} ${category}`);
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

  for (const tag of hashtags) {
    queries.push(`instagram reel ${tag} us`);
    queries.push(`instagram reels ${tag} us`);
    queries.push(`instagram ${tag} today us`);
    queries.push(`instagram ${tag} trending us`);
  }

  for (const category of categories) {
    queries.push(`instagram viral ${category} reel us`);
    queries.push(`instagram trending ${category} reel us`);
    queries.push(`instagram ${category} reel us`);
    queries.push(`instagram ${category} reels today us`);
  }

  return [...new Set(queries)];
}

function extractInstagramSeed(url: string): InstagramSeed | null {
  const cleanUrl = url.split("?")[0]!;
  const match = REEL_URL_RE.exec(cleanUrl);

  if (!match) return null;

  const shortCode = match[1];
  if (!shortCode) return null;

  // Normalise to /reel/ canonical form
  const canonicalUrl = `https://www.instagram.com/reel/${shortCode}/`;

  return {
    id: shortCode,
    url: canonicalUrl,
    fetchedAt: new Date().toISOString(),
  };
}

function serperSearchRequest(
  apiKey: string,
  query: string,
  page: number
): Promise<SerperItem[]> {
  const postData = JSON.stringify({
    q: query,
    gl: GL,
    hl: HL,
    num: NUM,
    tbs: "qdr:d",
    page,
  });

  const options = {
    hostname: "google.serper.dev",
    port: 443,
    path: "/videos",
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = "";

      res.on("data", (chunk) => {
        body += chunk;
      });

      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            console.warn(`[Serper] HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
            return resolve([]);
          }

          const json = JSON.parse(body);
          const videos: SerperItem[] = json.videos || [];

          resolve(videos);
        } catch {
          console.warn("[Serper] Failed to parse response");
          resolve([]);
        }
      });
    });

    req.on("error", (err) => {
      console.warn(`[Serper] Request failed: ${err.message}`);
      resolve([]);
    });

    req.write(postData);
    req.end();
  });
}

export async function runGoogleWorker() {
  if (SERPER_API_KEYS.length === 0) {
    throw new Error("Missing SERPER_API_KEYS in .env");
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, "", "utf8");

  const queries = buildQueries();
  const seen = new Set<string>();

  let keyIndex = 0;
  let savedCount = 0;

  console.log(`[GoogleWorker-IG] Market: US`);
  console.log(`[GoogleWorker-IG] Total queries: ${queries.length}`);
  console.log(`[GoogleWorker-IG] Max pages per query: ${MAX_PAGES}`);

  for (const query of queries) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const apiKey = SERPER_API_KEYS[keyIndex % SERPER_API_KEYS.length]!;
      keyIndex++;

      console.log(`[GoogleWorker-IG] Query: "${query}" | page=${page}`);

      const results = await serperSearchRequest(apiKey, query, page);

      let added = 0;

      for (const item of results) {
        if (!item.link) continue;
        if (!item.link.includes("instagram.com")) continue;

        const seed = extractInstagramSeed(item.link);
        if (!seed) continue;

        if (seen.has(seed.id)) continue;

        seen.add(seed.id);
        added++;
        savedCount++;

        fs.appendFileSync(OUTPUT_FILE, `${JSON.stringify(seed)}\n`, "utf8");
      }

      console.log(
        `[GoogleWorker-IG] Added: ${added} | Total unique seeds: ${savedCount}`
      );

      await sleep(DELAY_MS);
    }
  }

  console.log(
    `[GoogleWorker-IG] Saved ${savedCount} Instagram seeds to ${OUTPUT_FILE}`
  );
}

runGoogleWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});

