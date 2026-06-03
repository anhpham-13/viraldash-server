import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const OUTPUT_FILE = "data/youtube/raw_google_output_yt.jsonl";
const HASHTAG_FILE = "data/youtube/hashtag_yt.json";

const REGION_CODE = "US";
const MAX_PAGES_PER_QUERY = 2;
const SLEEP_MS = 300;

const TOP_HASHTAGS = 60;
const MAX_SEARCH_TERMS = 100;

const SEARCH_ORDERS = ["date"] as const;

type SearchOrder = (typeof SEARCH_ORDERS)[number];

const API_KEYS = [process.env.API_V3_1, process.env.API_V3_2].filter(
  (key): key is string => Boolean(key)
);

if (API_KEYS.length === 0) {
  throw new Error("Missing API_V3_1 or API_V3_2 in .env");
}

type HashtagItem = {
  tag: string;
  query: string;
  score?: number;
};

type YouTubeSearchItem = {
  id?: {
    videoId?: string;
  };
};

type YouTubeSearchResponse = {
  items?: YouTubeSearchItem[];
  nextPageToken?: string;
};

const seen = new Set<string>();
let keyIndex = 0;

function getApiKey(): string {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

function cleanQuery(value: string): string {
  return value
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGoodQuery(query: string): boolean {
  const q = cleanQuery(query);
  if (!q) return false;

  if (q.length < 3) return false;
  if (q.length > 80) return false;

  const words = q.split(" ");
  if (words.length > 6) return false;

  const badPatterns = [
    /^[a-z]$/,
    /\b[a-z]\b$/,
    /^\d+$/,
  ];

  return !badPatterns.some((pattern) => pattern.test(q));
}

function buildIntentVariants(base: string): string[] {
  const q = cleanQuery(base);
  if (!q) return [];

  const intents = [
    "shorts",
    "viral shorts",
    "trending shorts",
    "funny shorts",
    "reaction",
    "highlights",
    "moments",
    "challenge",
    "pov",
    "meme",
    "today",
  ];

  return intents.map((intent) => `${q} ${intent}`);
}

function buildQueryVariants(base: string): string[] {
  const q = cleanQuery(base);
  if (!q) return [];

  const variants = [
    q,
    ...buildIntentVariants(q),
  ];

  if (/(minecraft|roblox|fortnite|gaming|game)/i.test(q)) {
    variants.push(
      `${q} gameplay`,
      `${q} update`,
      `${q} funny moments`,
      `${q} tips`,
      `${q} new update`,
      `${q} challenge`
    );
  }

  if (
    /(football|soccer|nba|basketball|mlb|baseball|tennis|motogp|f1|ufc|boxing)/i.test(
      q
    )
  ) {
    variants.push(
      `${q} highlights`,
      `${q} skills`,
      `${q} goal`,
      `${q} match`,
      `${q} interview`,
      `${q} best moments`
    );
  }

  if (/(anime|manga|solo leveling|crunchyroll|naruto|one piece)/i.test(q)) {
    variants.push(
      `${q} scene`,
      `${q} clip`,
      `${q} amv`,
      `${q} fight`,
      `${q} edit`
    );
  }

  if (/(food|streetfood|cooking|recipe)/i.test(q)) {
    variants.push(
      `${q} recipe`,
      `${q} cooking`,
      `${q} street food`,
      `${q} eating`,
      `${q} review`
    );
  }

  if (/(cat|cats|dog|dogs|animal|animals|pet|pets)/i.test(q)) {
    variants.push(
      `${q} cute`,
      `${q} rescue`,
      `${q} baby`,
      `${q} funny reaction`
    );
  }

  if (/(news|politics|breaking news|world news)/i.test(q)) {
    variants.push(
      `${q} latest`,
      `${q} today`,
      `${q} update`,
      `${q} explained`
    );
  }

  return [...new Set(variants)].filter(isGoodQuery);
}

function loadSearchTerms(): string[] {
  if (!fs.existsSync(HASHTAG_FILE)) {
    throw new Error(`Missing ${HASHTAG_FILE}. Run extract_hashtags.ts first.`);
  }

  const hashtags = JSON.parse(
    fs.readFileSync(HASHTAG_FILE, "utf8")
  ) as HashtagItem[];

  const topTags = hashtags
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((item) => item.tag || item.query)
    .filter(Boolean)
    .map(cleanQuery)
    .filter(isGoodQuery)
    .slice(0, TOP_HASHTAGS);

  const queryPool = topTags.flatMap(buildQueryVariants);

  return shuffle([...new Set(queryPool)])
    .filter(isGoodQuery)
    .slice(0, MAX_SEARCH_TERMS);
}

async function searchVideos(params: {
  query: string;
  regionCode: string;
  order: SearchOrder;
  pageToken?: string | undefined;
}): Promise<YouTubeSearchResponse> {
  const publishedAfter = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  const url = new URL("https://www.googleapis.com/youtube/v3/search");

  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoDuration", "short");
  url.searchParams.set("order", params.order);
  url.searchParams.set("publishedAfter", publishedAfter);
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("q", params.query);
  url.searchParams.set("regionCode", params.regionCode);
  url.searchParams.set("key", getApiKey());

  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken);
  }

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Search failed ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as YouTubeSearchResponse;
}

function saveVideo(id: string): void {
  const row = {
    id,
    url: `https://www.youtube.com/shorts/${id}`,
    fetchedAt: new Date().toISOString(),
  };

  fs.appendFileSync(OUTPUT_FILE, JSON.stringify(row) + "\n", "utf8");
}

export async function runCrawlApiV3Shorts(): Promise<void> {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, "", "utf8");

  const SEARCH_TERMS = loadSearchTerms();

  console.log(`Loaded ${SEARCH_TERMS.length} search terms`);
  console.log(`Region: ${REGION_CODE}`);
  console.log(`Orders: ${SEARCH_ORDERS.join(", ")}`);

  for (const order of SEARCH_ORDERS) {
    for (const query of SEARCH_TERMS) {
      let pageToken: string | undefined;

      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
        try {
          console.log(
            `Searching: ${query} | region=${REGION_CODE} | order=${order} | page=${page}`
          );

          const data = await searchVideos({
            query,
            regionCode: REGION_CODE,
            order,
            pageToken,
          });

          let savedCount = 0;

          for (const item of data.items ?? []) {
            const id = item.id?.videoId;
            if (!id || seen.has(id)) continue;

            seen.add(id);
            saveVideo(id);
            savedCount++;
          }

          console.log(
            `Found=${data.items?.length ?? 0}, Saved=${savedCount}, Total=${seen.size}`
          );

          pageToken = data.nextPageToken;
          if (!pageToken) break;

          await sleep(SLEEP_MS);
        } catch (err) {
          console.error(
            `[ERROR] ${query} | ${REGION_CODE} | order=${order}:`,
            err instanceof Error ? err.message : err
          );
          break;
        }
      }

      await sleep(SLEEP_MS);
    }
  }

  console.log(`Done. ${seen.size} unique videos written to ${OUTPUT_FILE}`);
}

runCrawlApiV3Shorts().catch((err) => {
  console.error(err);
  process.exit(1);
});