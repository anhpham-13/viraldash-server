/**
 * One-time migration: reads viral_vids_*.jsonl / viral_posts_ig.jsonl from data/
 * and upserts every record into MongoDB via upsertVideo().
 *
 * Usage:
 *   tsx crawler/scripts/migrate-jsonl-to-mongo.ts              # dry-run (default)
 *   tsx crawler/scripts/migrate-jsonl-to-mongo.ts --apply      # write to MongoDB
 *   tsx crawler/scripts/migrate-jsonl-to-mongo.ts --apply --platform=yt
 *   tsx crawler/scripts/migrate-jsonl-to-mongo.ts --apply --platform=tt
 *   tsx crawler/scripts/migrate-jsonl-to-mongo.ts --apply --platform=ig
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { getDb, ensureIndexes, upsertVideo } from "../../shared/db/index.js";
import type { RawCrawlerRecord, Platform } from "../../shared/types/index.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");
const PLATFORM_ARG = args.find(a => a.startsWith("--platform="))?.split("=")[1] ?? "all";

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), "data");

const SOURCES: Array<{ file: string; platform: Platform; normalize: Normalizer }> = [
  { file: resolve(DATA_DIR, "youtube/viral_vids_yt.jsonl"),     platform: "YouTube_Shorts",    normalize: normalizeYt },
  { file: resolve(DATA_DIR, "tiktok/viral_vids_tt.jsonl"),      platform: "TikTok",            normalize: normalizeTt },
  { file: resolve(DATA_DIR, "instagram/viral_posts_ig.jsonl"),  platform: "Instagram_Reels",   normalize: normalizeIg },
];

type RawLine = Record<string, unknown>;
type Normalizer = (raw: RawLine) => RawCrawlerRecord | null;

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeYt(raw: RawLine): RawCrawlerRecord | null {
  const id = String(raw["video_id"] ?? "").trim();
  if (!id) return null;

  const snippet = raw["snippet"] as Record<string, unknown> | undefined;
  const author  = String(
    snippet?.["channelTitle"] ?? snippet?.["channelId"] ?? raw["author"] ?? "YouTube"
  ).trim() || "YouTube";

  const url         = raw["url"] ? String(raw["url"]) : `https://www.youtube.com/shorts/${id}`;
  const publishedAt = raw["published_at"] ? new Date(String(raw["published_at"])) : new Date();
  const fetchedAt   = raw["fetchedAt"]    ? new Date(String(raw["fetchedAt"]))    : new Date();
  const hashtags    = Array.isArray(raw["tags"]) ? (raw["tags"] as string[]) : [];
  const title       = raw["title"] ? String(raw["title"]).trim() : undefined;

  return {
    video_id:     id,
    platform:     "YouTube_Shorts",
    url,
    published_at: publishedAt,
    author,
    hashtags,
    view_count: Number(raw["view_count"]) || 0,
    likes:      Number(raw["likes"])      || 0,
    comments:   Number(raw["comments"])   || 0,
    shares:     0,
    saves:      Number(raw["favorites"])  || 0,
    fetched_at: fetchedAt,
    ...(title && { title }),
  };
}

function normalizeTt(raw: RawLine): RawCrawlerRecord | null {
  const id = String(raw["id"] ?? raw["video_id"] ?? "").trim();
  if (!id) return null;

  const author    = String(raw["author"] ?? "TikTok").trim() || "TikTok";
  const hashtags  = Array.isArray(raw["hashtags"]) ? (raw["hashtags"] as string[]) : [];
  const soundRaw  = raw["sound"] ? String(raw["sound"]).trim() : "";
  const url       = raw["url"]
    ? String(raw["url"])
    : `https://www.tiktok.com/@${author}/video/${id}`;

  const publishedAt = raw["postDate"]     ?? raw["published_at"];
  const fetchedAt   = raw["fetchedAt"]    ?? raw["fetched_at"];

  return {
    video_id:     id,
    platform:     "TikTok",
    url,
    published_at: publishedAt ? new Date(String(publishedAt)) : new Date(),
    author,
    hashtags,
    view_count: Number(raw["views"]    ?? raw["view_count"]) || 0,
    likes:      Number(raw["likes"])                         || 0,
    comments:   Number(raw["comments"])                      || 0,
    shares:     Number(raw["shares"])                        || 0,
    saves:      Number(raw["saves"])                         || 0,
    fetched_at: fetchedAt ? new Date(String(fetchedAt)) : new Date(),
    ...(soundRaw && { sound: soundRaw }),
  };
}

function normalizeIg(raw: RawLine): RawCrawlerRecord | null {
  const rec = normalizeTt(raw);
  if (rec) rec.platform = "Instagram_Reels";
  return rec;
}

// ─── Stream helper ────────────────────────────────────────────────────────────

async function* streamJsonl(filePath: string): AsyncGenerator<RawLine> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RawLine;
    } catch {
      // skip malformed lines
    }
  }
}

// ─── Per-file migration ───────────────────────────────────────────────────────

async function migrateFile(
  filePath: string,
  platform: Platform,
  normalize: Normalizer,
  apply: boolean,
): Promise<{ total: number; ok: number; skipped: number; failed: number }> {
  let total = 0, ok = 0, skipped = 0, failed = 0;

  for await (const raw of streamJsonl(filePath)) {
    total++;
    const rec = normalize(raw);
    if (!rec) { skipped++; continue; }

    if (apply) {
      try {
        await upsertVideo(rec);
        ok++;
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  [warn] ${platform}/${rec.video_id}: ${msg}`);
      }
    } else {
      ok++;  // dry-run: count as would-be-ok
    }
  }

  return { total, ok, skipped, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`\n[migrate] ${DRY_RUN ? "DRY-RUN" : "APPLY"} mode | platform=${PLATFORM_ARG}`);
  if (DRY_RUN) console.log("[migrate] Pass --apply to write to MongoDB.\n");

  const sources = PLATFORM_ARG === "all"
    ? SOURCES
    : SOURCES.filter(s => {
        const slug = { "YouTube_Shorts": "yt", "TikTok": "tt", "Instagram_Reels": "ig" }[s.platform];
        return slug === PLATFORM_ARG;
      });

  if (sources.length === 0) {
    console.error(`[migrate] Unknown platform: ${PLATFORM_ARG}. Use yt, tt, ig, or all.`);
    process.exitCode = 1;
    return;
  }

  if (!DRY_RUN) {
    const db = await getDb();
    await ensureIndexes(db);
    console.log("[migrate] MongoDB ready\n");
  }

  let grandTotal = 0, grandOk = 0, grandSkipped = 0, grandFailed = 0;

  for (const src of sources) {
    console.log(`[migrate] → ${src.platform}  ${src.file}`);
    const result = await migrateFile(src.file, src.platform, src.normalize, !DRY_RUN);

    grandTotal   += result.total;
    grandOk      += result.ok;
    grandSkipped += result.skipped;
    grandFailed  += result.failed;

    const action = DRY_RUN ? "would upsert" : "upserted";
    console.log(
      `           total=${result.total}  ${action}=${result.ok}` +
      `  skipped=${result.skipped}  failed=${result.failed}`,
    );
  }

  console.log(`\n[migrate] ─── Summary ───────────────────────────────`);
  console.log(`  total lines : ${grandTotal}`);
  console.log(`  ${DRY_RUN ? "would upsert" : "upserted"}   : ${grandOk}`);
  console.log(`  skipped     : ${grandSkipped}`);
  console.log(`  failed      : ${grandFailed}`);
  if (DRY_RUN) console.log(`\n  Re-run with --apply to write to MongoDB.`);
}

run().catch(err => { console.error(err); process.exitCode = 1; });
