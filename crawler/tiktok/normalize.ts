import fs from "node:fs";
import readline from "node:readline";
import { resolve } from "node:path";
import type { IVideoRecordCandidate } from "../src/core/types.js";

// -- Normalizer Helpers --
function normalizeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleanedValue = value.trim().replace(/,/g, "");
    if (!cleanedValue) return 0;
    const multiplier = cleanedValue.match(/([kKmMbB])$/)?.[1]?.toLowerCase();
    const numericPortion = Number.parseFloat(cleanedValue.replace(/[kKmMbB]$/, ""));
    if (!Number.isFinite(numericPortion)) return 0;
    if (multiplier === "k") return Math.round(numericPortion * 1_000);
    if (multiplier === "m") return Math.round(numericPortion * 1_000_000);
    if (multiplier === "b") return Math.round(numericPortion * 1_000_000_000);
    return numericPortion;
  }
  return 0;
}

function extractHashtags(text: string): string[] {
  return [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map((match) => match[0]).filter((value, index, array) => array.indexOf(value) === index);
}

function toIsoDate(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString();
  }
  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (!trimmedValue) return fallback;
    const numericValue = Number(trimmedValue);
    if (Number.isFinite(numericValue)) {
      return new Date(numericValue < 1_000_000_000_000 ? numericValue * 1_000 : numericValue).toISOString();
    }
    const parsedDate = new Date(trimmedValue);
    return Number.isNaN(parsedDate.getTime()) ? fallback : parsedDate.toISOString();
  }
  return fallback;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function collectRapidPayloadItems(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates = [root.data, root.result, root.response, root];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const candidateRecord = candidate as Record<string, unknown>;
    const listValue = candidateRecord.list ?? candidateRecord.items ?? candidateRecord.data ?? candidateRecord.item_list;

    if (Array.isArray(listValue)) {
      return listValue.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
    }
    if (candidateRecord.aweme_id || candidateRecord.id || candidateRecord.video_id) {
      return [candidateRecord];
    }
  }
  return [];
}

function extractRapidHashtags(item: Record<string, unknown>): string[] {
  const hashtags = new Set<string>();

  const addSingleTag = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().replace(/^#/, "");
    if (normalized) hashtags.add(`#${normalized}`);
  };

  const addFromText = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const tag of extractHashtags(value)) hashtags.add(tag);
  };

  addFromText(item.desc);
  addFromText(item.description);

  const originalClientText = item.original_client_text;
  if (originalClientText && typeof originalClientText === "object") {
    const originalRecord = originalClientText as Record<string, unknown>;
    addFromText(originalRecord.markup_text);
    const textExtra = originalRecord.text_extra;
    if (Array.isArray(textExtra)) {
      for (const entry of textExtra) {
        if (entry && typeof entry === "object" && (entry as any).type === 1) {
          addSingleTag((entry as any).hashtag_name);
        }
      }
    }
  }

  const textExtra = item.text_extra;
  if (Array.isArray(textExtra)) {
    for (const entry of textExtra) {
      if (entry && typeof entry === "object" && (entry as any).type === 1) {
        addSingleTag((entry as any).hashtag_name);
      }
    }
  }

  const chaList = item.cha_list;
  if (Array.isArray(chaList)) {
    for (const entry of chaList) {
      if (entry && typeof entry === "object") {
        addSingleTag((entry as any).cha_name);
      }
    }
  }

  return [...hashtags];
}

function extractRapidSound(item: Record<string, unknown>): string {
  const music = item.music;
  if (!music || typeof music !== "object") {
    return String(item.sound ?? item.music_title ?? item.title ?? "").trim();
  }
  const musicRecord = music as Record<string, unknown>;
  const title = String(musicRecord.title ?? "").trim();
  const author = String(musicRecord.author ?? musicRecord.owner_nickname ?? musicRecord.owner_handle ?? "").trim();
  if (title && author) return `${title} - ${author}`;
  return title || author || String(item.sound ?? item.music_title ?? item.title ?? "").trim();
}

function toSafeCandidate(input: any): IVideoRecordCandidate {
  return {
    id: input.id,
    author: input.author,
    url: input.url ?? `https://www.tiktok.com/@${input.author}/video/${input.id}`,
    likes: input.likes ?? 0,
    views: input.views ?? 0,
    comments: input.comments ?? 0,
    shares: input.shares ?? 0,
    saves: input.saves ?? 0,
    total_view_growth: input.total_view_growth ?? input.shares ?? 0,
    hashtags: input.hashtags ?? [],
    sound: input.sound ?? "",
    postDate: input.postDate ?? input.fetchedAt,
    fetchedAt: input.fetchedAt,
  };
}

function collectFromRapidPayload(payload: unknown, fetchedAt: string): IVideoRecordCandidate[] {
  const items = collectRapidPayloadItems(payload);
  const results: IVideoRecordCandidate[] = [];

  for (const item of items) {
    const id = String(item.aweme_id ?? item.id ?? item.video_id ?? "").trim();
    if (!id) continue;

    const authorRecord = item.author;
    const author = authorRecord && typeof authorRecord === "object"
      ? String((authorRecord as any).unique_id ?? (authorRecord as any).nickname ?? item.nickname ?? item.unique_id ?? "").trim()
      : String(item.unique_id ?? item.nickname ?? "").trim();

    if (!author) continue;

    const statistics = item.statistics && typeof item.statistics === "object" ? (item.statistics as any) : {};
    const views = normalizeNumber(statistics.play_count ?? item.play_count ?? item.views ?? item.view_count ?? 0);
    const likes = normalizeNumber(statistics.digg_count ?? item.digg_count ?? item.likes ?? item.like_count ?? 0);
    const comments = normalizeNumber(statistics.comment_count ?? item.comment_count ?? item.comments ?? item.commentCount ?? 0);
    const shares = normalizeNumber(statistics.share_count ?? item.share_count ?? item.shares ?? item.total_view_growth ?? 0);
    const saves = normalizeNumber(statistics.collect_count ?? item.collect_count ?? item.saves ?? item.favorite_count ?? 0);
    const postDate = toIsoDate(item.create_time ?? item.createTime ?? item.created_at ?? item.createdAt, fetchedAt);

    results.push(toSafeCandidate({
      id, author, likes, views, comments, shares, saves, total_view_growth: shares,
      hashtags: unique(extractRapidHashtags(item)),
      sound: extractRapidSound(item) || "Original audio",
      postDate, fetchedAt,
    }));
  }
  return results;
}

function collectFromScraper7Payload(payload: unknown, fetchedAt: string): IVideoRecordCandidate[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const dataObj = root.data;
  if (!dataObj || typeof dataObj !== "object") return [];
  const videos = (dataObj as any).videos;
  if (!Array.isArray(videos)) return [];

  const results: IVideoRecordCandidate[] = [];
  for (const video of videos) {
    if (!video || typeof video !== "object") continue;
    const videoRecord = video as Record<string, unknown>;
    const id = String(videoRecord.video_id ?? videoRecord.aweme_id ?? videoRecord.id ?? "").trim();
    if (!id) continue;

    const authorRecord = videoRecord.author;
    const author = authorRecord && typeof authorRecord === "object"
      ? String((authorRecord as any).unique_id ?? (authorRecord as any).nickname ?? "").trim()
      : "";

    if (!author) continue;

    const title = String(videoRecord.title ?? "").trim();
    let musicSound = "";
    const musicInfoObj = videoRecord.music_info;
    if (musicInfoObj && typeof musicInfoObj === "object") {
      const musicInfo = musicInfoObj as any;
      const musicTitle = String(musicInfo.title ?? "").trim();
      const musicAuthor = String(musicInfo.author ?? "").trim();
      if (musicTitle && musicAuthor) musicSound = `${musicTitle} - ${musicAuthor}`;
      else if (musicTitle) musicSound = musicTitle;
      else if (musicAuthor) musicSound = musicAuthor;
    }
    if (!musicSound) musicSound = title || "Original audio";

    results.push(toSafeCandidate({
      id, author,
      views: normalizeNumber(videoRecord.play_count ?? 0),
      likes: normalizeNumber(videoRecord.digg_count ?? 0),
      comments: normalizeNumber(videoRecord.comment_count ?? 0),
      shares: normalizeNumber(videoRecord.share_count ?? 0),
      saves: normalizeNumber(videoRecord.collect_count ?? 0),
      total_view_growth: normalizeNumber(videoRecord.share_count ?? 0),
      hashtags: unique(extractHashtags(title)),
      sound: musicSound,
      postDate: toIsoDate(videoRecord.create_time ?? 0, fetchedAt),
      fetchedAt,
    }));
  }
  return results;
}

export async function runNormalize() {
  const RAPID_FILE = resolve(process.cwd(), "output_json", "tiktok_rapid_raw.jsonl");
  const GOOGLE_FILE = resolve(process.cwd(), "output_json", "tiktok_google_raw.jsonl");
  const OUTPUT_FILE = resolve(process.cwd(), "output_json", "tiktok_candidates.jsonl");

  const seenIds = new Set<string>();
  const stream = fs.createWriteStream(OUTPUT_FILE, { flags: "w" });

  let totalRapid = 0;
  let totalGoogle = 0;
  let deduplicated = 0;

  // 1. Process Rapid File
  if (fs.existsSync(RAPID_FILE)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(RAPID_FILE),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const { host, payload, fetchedAt } = record;
        const candidates = host.includes("scraper7") 
          ? collectFromScraper7Payload(payload, fetchedAt)
          : collectFromRapidPayload(payload, fetchedAt);

        for (const candidate of candidates) {
          if (!candidate.id || seenIds.has(candidate.id)) continue;
          seenIds.add(candidate.id);
          stream.write(JSON.stringify(candidate) + "\n");
          deduplicated++;
        }
        totalRapid += candidates.length;
      } catch (e) {
        console.warn("[normalize] Failed to parse a rapid line", e);
      }
    }
  }

  // 2. Process Google File
  if (fs.existsSync(GOOGLE_FILE)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(GOOGLE_FILE),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const candidate = record.data;
        totalGoogle++;
        if (!candidate.id || seenIds.has(candidate.id)) continue;
        seenIds.add(candidate.id);
        stream.write(JSON.stringify(candidate) + "\n");
        deduplicated++;
      } catch (e) {
        console.warn("[normalize] Failed to parse a google line", e);
      }
    }
  }

  stream.end();
  console.log(`[normalize] Normalization complete!`);
  console.log(`[normalize] Rapid total: ${totalRapid}`);
  console.log(`[normalize] Google total: ${totalGoogle}`);
  console.log(`[normalize] Unique candidates saved to ${OUTPUT_FILE}: ${deduplicated}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("normalize.ts")) {
  runNormalize().catch(console.error);
}
