import { getCollection } from "./client.js";
import { COL } from "./collections.js";
import type { Platform } from "../types/video.js";
import type { HashtagRecord } from "../types/hashtag.js";
import type { VideoDocument } from "../types/video.js";

// ─── upsertHashtags ───────────────────────────────────────────────────────────

export async function upsertHashtags(records: HashtagRecord[]): Promise<void> {
  if (records.length === 0) return;

  const col = await getCollection<HashtagRecord>(COL.HASHTAGS);

  await col.bulkWrite(
    records.map(r => ({
      updateOne: {
        filter: { tag: r.tag, platform: r.platform },
        update: { $set: r },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

// ─── findByPlatform ───────────────────────────────────────────────────────────

export async function findByPlatform(
  platform?: Platform | "all",
  limit = 80,
  maxAgeHours = 48,
): Promise<HashtagRecord[]> {
  const col = await getCollection<HashtagRecord>(COL.HASHTAGS);

  const cutoff = new Date(Date.now() - maxAgeHours * MS_PER_HOUR);
  const filter: Record<string, unknown> = {
    synced_at: { $gte: cutoff },
  };
  if (platform && platform !== "all") filter["platform"] = platform;

  return col
    .find(filter as Parameters<typeof col.find>[0], {
      projection: { _id: 0 },
      sort:        { score: -1 },
      limit,
    })
    .toArray() as Promise<HashtagRecord[]>;
}

// ─── syncHashtagsFromVideos ───────────────────────────────────────────────────
//
// Reads viral videos from MongoDB (platform + 48h window), aggregates hashtag
// stats, applies scoring + dedup, then upserts results into the hashtags
// collection. Called after each platform crawl run.
//
// Returns the number of hashtag records written.

const MAX_HASHTAGS    = 80;
const MIN_OCCURRENCES = 2;
const MS_PER_HOUR     = 3_600_000;

const STOP_TAGS = new Set([
  "short", "shorts", "yt shorts", "youtube shorts", "shorts video", "shorts feed",
  "viral", "trending", "trend", "fyp", "for you", "video", "videos",
  "new", "latest", "best", "popular", "official",
  "youtube", "tiktok", "reels", "reel", "instagram",
  "meme", "memes", "funny", "humor", "humour", "pov",
  "edit", "edits", "reaction", "reactions",
  "challenge", "challenges", "compilation",
  "clips", "clip", "highlights", "highlight",
  "moments", "moment", "story", "tutorial",
  "explained", "review", "fails", "fail", "today", "2026",
]);

const BAD_WORDS = new Set([
  "short", "shorts", "viral", "trending", "trend", "fyp",
  "video", "videos", "meme", "memes", "funny", "humor", "humour", "pov",
  "edit", "edits", "reaction", "reactions",
  "challenge", "challenges", "compilation",
  "clip", "clips", "highlight", "highlights",
  "moment", "moments", "story", "tutorial",
  "explained", "review", "fails", "fail",
  "today", "latest", "new", "best", "official",
]);

const ALIAS_MAP: Record<string, string> = {
  cats: "cat", dogs: "dog", pets: "pet", animals: "animal",
  recipes: "recipe", cooking: "food", streetfood: "street food",
  futbol: "football", soccer: "football",
  basketball: "nba", hoops: "nba",
  videogames: "gaming", games: "gaming", gamer: "gaming", gamers: "gaming",
};

function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTag(raw: string): string {
  const t = normalizeTag(raw);
  return ALIAS_MAP[t] ?? t;
}

function isGoodTag(tag: string): boolean {
  if (!tag || tag.length < 2 || tag.length > 45) return false;
  if (STOP_TAGS.has(tag)) return false;
  if (tag.split(" ").some(w => BAD_WORDS.has(w))) return false;
  if (/^[0-9]+$/.test(tag)) return false;
  if (/^[a-z]$/.test(tag)) return false;
  if (/^[a-z0-9]{12,}$/.test(tag) && !tag.includes(" ")) return false;
  if (tag.split(" ").length > 4) return false;
  return true;
}

function toSearchQuery(tag: string): string {
  return tag.includes(" ") ? tag : `#${tag}`;
}

function wordSimilarity(a: string, b: string): number {
  const aW = new Set(a.split(" "));
  const bW = new Set(b.split(" "));
  const inter = [...aW].filter(w => bW.has(w)).length;
  const minSz = Math.min(aW.size, bW.size);
  return minSz === 0 ? 0 : inter / minSz;
}

function dedupe(sorted: HashtagRecord[]): HashtagRecord[] {
  const out: HashtagRecord[] = [];
  for (const item of sorted) {
    if (out.length >= MAX_HASHTAGS) break;
    const tooSimilar = out.some(
      s => s.tag === item.tag || wordSimilarity(s.tag, item.tag) >= 0.8,
    );
    if (!tooSimilar) out.push(item);
  }
  return out;
}

export async function syncHashtagsFromVideos(
  platform: Platform,
  maxAgeHours = 48,
): Promise<number> {
  const col    = await getCollection<VideoDocument>(COL.VIDEOS);
  const cutoff = new Date(Date.now() - maxAgeHours * MS_PER_HOUR);

  const docs = await col
    .find(
      { platform, published_at: { $gte: cutoff } },
      { projection: { _id: 0, hashtags: 1, view_count: 1, likes: 1, comments: 1, viral_score: 1 } },
    )
    .toArray();

  if (docs.length === 0) {
    console.log(`[hashtags] No videos for ${platform} in last ${maxAgeHours}h — skipping`);
    return 0;
  }

  type Acc = {
    videoIds: Set<string>;
    count:    number;
    totalViews:    number;
    totalLikes:    number;
    totalComments: number;
    totalScore:    number;
  };

  const tagMap = new Map<string, Acc>();

  for (const doc of docs) {
    const views    = Number(doc.view_count) || 0;
    const likes    = Number(doc.likes)      || 0;
    const comments = Number(doc.comments)   || 0;
    const score    = Number(doc.viral_score) || 0;

    for (const raw of doc.hashtags ?? []) {
      const tag = canonicalTag(raw);
      if (!isGoodTag(tag)) continue;

      let acc = tagMap.get(tag);
      if (!acc) {
        acc = { videoIds: new Set(), count: 0, totalViews: 0, totalLikes: 0, totalComments: 0, totalScore: 0 };
        tagMap.set(tag, acc);
      }
      acc.count++;
      acc.totalViews    += views;
      acc.totalLikes    += likes;
      acc.totalComments += comments;
      acc.totalScore    += score;
    }
  }

  const now = new Date();

  const scored: HashtagRecord[] = [...tagMap.entries()]
    .filter(([, a]) => a.count >= MIN_OCCURRENCES)
    .map(([tag, a]) => {
      const videos      = a.count;
      const avgViews    = a.totalViews    / Math.max(videos, 1);
      const avgLikeRate = a.totalLikes    / Math.max(a.totalViews, 1);
      const avgCmtRate  = a.totalComments / Math.max(a.totalViews, 1);
      const avgScore    = a.totalScore    / Math.max(a.count, 1);

      const score =
        Math.log10(a.totalViews    + 1) * 35 +
        Math.log10(a.totalLikes    + 1) * 25 +
        Math.log10(a.totalComments + 1) * 12 +
        Math.log10(a.count         + 1) * 18 +
        avgLikeRate * 100 +
        avgCmtRate  * 80  +
        avgScore    * 0.4;

      return {
        tag,
        query:         toSearchQuery(tag),
        platform,
        count:         a.count,
        videos,
        totalViews:    a.totalViews,
        totalLikes:    a.totalLikes,
        totalComments: a.totalComments,
        avgViews:      Math.round(avgViews),
        avgLikeRate:   Number(avgLikeRate.toFixed(4)),
        score:         Number(score.toFixed(2)),
        synced_at:     now,
      };
    })
    .sort((a, b) => b.score - a.score);

  const records = dedupe(scored);

  await upsertHashtags(records);

  console.log(`[hashtags] ${platform}: ${records.length} tags upserted (from ${docs.length} videos in last ${maxAgeHours}h)`);
  return records.length;
}
