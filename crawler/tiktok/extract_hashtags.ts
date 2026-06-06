import fs from "node:fs";
import path from "node:path";
import { syncHashtagsFromVideos } from "../../shared/db/index.js";

const INPUT_FILE = "data/tiktok/viral_vids_tt.jsonl";
const OUTPUT_FILE = "data/tiktok/hashtag_tt.json";

const MAX_HASHTAGS = 80;
const MIN_OCCURRENCES = 2;
const ONLY_SHORTS = false;

type ViralVideo = {
  id?: string;
  video_id?: string;
  platform?: string;
  url?: string;

  postDate?: string;
  fetchedAt?: string;

  hashtags?: string[];

  views?: number | string;
  view_count?: number | string;
  likes?: number | string;
  comments?: number | string;
  saves?: number | string;
  shares?: number | string;

  total_view_growth?: number;

  sound?: string;
  author?: string;

  engagement_score?: number;
  viral_velocity?: number;
  rolling_velocity?: number | null;
  viral_acceleration?: number | null;
  viral_score?: number;

  engagementRate?: number;
  viralVelocity?: number;
  rollingVelocity?: number | null;
  viralAcceleration?: number | null;
  viralScore?: number;

  snippet?: {
    tags?: string[];
    publishedAt?: string;
    channelId?: string;
  };

  statistics?: {
    viewCount?: string | number;
    likeCount?: string | number;
    commentCount?: string | number;
  };
};

type TagStat = {
  tag: string;
  query: string;
  count: number;
  videos: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  avgViews: number;
  avgLikeRate: number;
  score: number;
};

const STOP_TAGS = new Set([
  "short",
  "shorts",
  "yt shorts",
  "youtube shorts",
  "shorts video",
  "shorts feed",
  "viral",
  "trending",
  "trend",
  "fyp",
  "for you",
  "video",
  "videos",
  "new",
  "latest",
  "best",
  "popular",
  "official",
  "youtube",
  "tiktok",
  "reels",
  "reel",
  "instagram",
  "meme",
  "memes",
  "funny",
  "humor",
  "humour",
  "pov",
  "edit",
  "edits",
  "reaction",
  "reactions",
  "challenge",
  "challenges",
  "compilation",
  "clips",
  "clip",
  "highlights",
  "highlight",
  "moments",
  "moment",
  "story",
  "tutorial",
  "explained",
  "review",
  "fails",
  "fail",
  "today",
  "2026",
]);

const BAD_WORDS = new Set([
  "short",
  "shorts",
  "viral",
  "trending",
  "trend",
  "fyp",
  "video",
  "videos",
  "meme",
  "memes",
  "funny",
  "humor",
  "humour",
  "pov",
  "edit",
  "edits",
  "reaction",
  "reactions",
  "challenge",
  "challenges",
  "compilation",
  "clip",
  "clips",
  "highlight",
  "highlights",
  "moment",
  "moments",
  "story",
  "tutorial",
  "explained",
  "review",
  "fails",
  "fail",
  "today",
  "latest",
  "new",
  "best",
  "official",
]);

const ALIAS_MAP: Record<string, string> = {
  cats: "cat",
  dogs: "dog",
  pets: "pet",
  animals: "animal",
  recipes: "recipe",
  cooking: "food",
  streetfood: "street food",
  futbol: "football",
  soccer: "football",
  basketball: "nba",
  hoops: "nba",
  videogames: "gaming",
  games: "gaming",
  gamer: "gaming",
  gamers: "gaming",
};

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTag(tag: string): string {
  const normalized = normalizeTag(tag);
  return ALIAS_MAP[normalized] ?? normalized;
}

function toSearchQuery(tag: string): string {
  return tag.includes(" ") ? tag : `#${tag}`;
}

function hasBadIntent(tag: string): boolean {
  const words = tag.split(" ");
  return words.some((word) => BAD_WORDS.has(word));
}

function isGoodTag(tag: string): boolean {
  if (!tag) return false;
  if (tag.length < 2) return false;
  if (tag.length > 45) return false;
  if (STOP_TAGS.has(tag)) return false;
  if (hasBadIntent(tag)) return false;

  if (/^[0-9]+$/.test(tag)) return false;
  if (/^[a-z]$/.test(tag)) return false;

  if (/^[a-z0-9]{12,}$/.test(tag) && !tag.includes(" ")) {
    return false;
  }

  const words = tag.split(" ");
  if (words.length > 4) return false;

  return true;
}

function readJsonl(filePath: string): ViralVideo[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const rows: ViralVideo[] = [];

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      rows.push(JSON.parse(trimmed) as ViralVideo);
    } catch {
      console.warn(`Skip invalid JSON line: ${index + 1}`);
    }
  }

  return rows;
}

function similarity(a: string, b: string): number {
  const aWords = new Set(a.split(" "));
  const bWords = new Set(b.split(" "));

  const intersection = [...aWords].filter((word) => bWords.has(word)).length;
  const minSize = Math.min(aWords.size, bWords.size);

  if (minSize === 0) return 0;

  return intersection / minSize;
}

function isTooSimilarToSelected(item: TagStat, selected: TagStat[]): boolean {
  for (const selectedItem of selected) {
    if (item.tag === selectedItem.tag) return true;

    const sim = similarity(item.tag, selectedItem.tag);

    if (sim >= 0.8) {
      return true;
    }
  }

  return false;
}

export async function runExtractHashtags(): Promise<void> {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const videos = readJsonl(INPUT_FILE);

  const tagMap = new Map<
    string,
    {
      tag: string;
      videoIds: Set<string>;
      count: number;
      totalViews: number;
      totalLikes: number;
      totalComments: number;
      totalViralScore: number;
    }
  >();

  for (const video of videos) {
    const url = video.url ?? "";

    if (ONLY_SHORTS && !url.includes("/shorts/")) {
      continue;
    }

    const id = video.id || video.video_id || video.url;
    if (!id) continue;

    const viewCount =
      safeNumber(video.views) ||
      safeNumber(video.view_count) ||
      safeNumber(video.statistics?.viewCount);

    const likeCount =
      safeNumber(video.likes) ||
      safeNumber(video.statistics?.likeCount);

    const commentCount =
      safeNumber(video.comments) ||
      safeNumber(video.statistics?.commentCount);
    const viralScore =
      safeNumber(video.viralScore) || safeNumber(video.viral_score);

    const rawTags = [...(video.hashtags || []), ...(video.snippet?.tags || [])];

    const uniqueTags = new Set(
      rawTags
        .map(canonicalTag)
        .filter(isGoodTag)
    );

    for (const tag of uniqueTags) {
      const current =
        tagMap.get(tag) ??
        {
          tag,
          videoIds: new Set<string>(),
          count: 0,
          totalViews: 0,
          totalLikes: 0,
          totalComments: 0,
          totalViralScore: 0,
        };

      current.count += 1;
      current.videoIds.add(id);
      current.totalViews += viewCount;
      current.totalLikes += likeCount;
      current.totalComments += commentCount;
      current.totalViralScore += viralScore;

      tagMap.set(tag, current);
    }
  }

  const sorted: TagStat[] = [...tagMap.values()]
    .map((item) => {
      const videos = item.videoIds.size;
      const avgViews = item.totalViews / Math.max(videos, 1);
      const avgLikeRate = item.totalLikes / Math.max(item.totalViews, 1);
      const avgCommentRate = item.totalComments / Math.max(item.totalViews, 1);
      const avgViralScore = item.totalViralScore / Math.max(item.count, 1);

      const score =
        Math.log10(item.totalViews + 1) * 35 +
        Math.log10(item.totalLikes + 1) * 25 +
        Math.log10(item.totalComments + 1) * 12 +
        Math.log10(item.count + 1) * 18 +
        avgLikeRate * 100 +
        avgCommentRate * 80 +
        avgViralScore * 0.4;

      return {
        tag: item.tag,
        query: toSearchQuery(item.tag),
        count: item.count,
        videos,
        totalViews: item.totalViews,
        totalLikes: item.totalLikes,
        totalComments: item.totalComments,
        avgViews: Math.round(avgViews),
        avgLikeRate: Number(avgLikeRate.toFixed(4)),
        score: Number(score.toFixed(2)),
      };
    })
    .filter((item) => item.count >= MIN_OCCURRENCES)
    .sort((a, b) => b.score - a.score);

  const results: TagStat[] = [];

  for (const item of sorted) {
    if (results.length >= MAX_HASHTAGS) break;
    if (isTooSimilarToSelected(item, results)) continue;

    results.push(item);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf8");
  console.log(`Done. ${results.length} hashtags written to ${OUTPUT_FILE}`);
  console.log(results.slice(0, 40).map((x) => x.query).join(", "));

  try {
    await syncHashtagsFromVideos("TikTok");
  } catch (err: any) {
    console.warn(`[extract_hashtags] MongoDB sync failed (non-fatal): ${err.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("extract_hashtags.ts")) {
  runExtractHashtags().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}