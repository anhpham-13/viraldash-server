import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Document } from "mongodb";
import { getCollection } from "./client.js";
import { COL, AUDIT } from "./collections.js";
import { env } from "../config/env.js";
import type {
  Platform,
  RawCrawlerRecord,
  VideoDocument,
  VideoFilters,
  VideoResponse,
  VideosResponse,
  VideoSnapshot,
} from "../types/video.js";

// ─── Scoring helpers (mirrors PRD §3 from crawler/src/core/viral.calc.ts) ────
//
// shared/ must not import from crawler/ — pure math is duplicated here.
// When viral.calc.ts is promoted to shared/lib/, remove these.

// TikTok API can return stat fields (e.g. collectCount/saves) as strings instead of
// numbers. Using Number() guards against JS string-concatenation in arithmetic.
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function computeEngagement(r: RawCrawlerRecord): number {
  const views = n(r.view_count);
  if (views <= 0) return 0;
  return +(((n(r.likes) + n(r.comments) + n(r.saves)) / views) * 100).toFixed(2);
}

// effectiveVph: when provided (from pushSnapshot rolling delta), used for both gate
// and formula instead of lifetime view_count/ageHours which decays as videos age.
function computeViralScore(r: RawCrawlerRecord, ageHours: number, effectiveVph?: number): number {
  if (ageHours <= 0) return 0;
  const views = n(r.view_count);
  const likes = n(r.likes);
  const vph = effectiveVph !== undefined && effectiveVph > 0
    ? effectiveVph
    : views / ageHours;
  const lr = views > 0 ? likes / views : 0;
  if (
    views < env.scoreMinViews ||
    vph < env.scoreMinViewsPerHour ||
    likes < env.scoreMinLikes ||
    lr < env.scoreMinLikeRate
  ) return 0;
  const er = (likes + n(r.comments) + n(r.saves)) / views * 100;
  const raw =
    Math.min(30, Math.log10(views + 1) * 8) +
    Math.min(35, Math.log10(vph + 1) * 12) +
    Math.min(15, Math.log10(likes + 1) * 5) +
    Math.min(10, Math.log10(n(r.comments) + 1) * 5) +
    Math.min(10, (er / 2) * 10) +
    Math.max(0, 10 - ageHours * 0.4);   // recency decay: 0pt after 25h
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ─── Audit log ────────────────────────────────────────────────────────────────

async function appendAudit(record: RawCrawlerRecord): Promise<void> {
  const path =
    record.platform === "YouTube_Shorts" ? AUDIT.YT
      : record.platform === "TikTok" ? AUDIT.TT
        : AUDIT.IG;
  const line = JSON.stringify({
    ...record,
    published_at: record.published_at.toISOString(),
    fetched_at: record.fetched_at.toISOString(),
  }) + "\n";
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, "utf8");
}

// ─── upsertVideo ─────────────────────────────────────────────────────────────
//
// Called by discovery crawlers (Loop 1) when a new video is found.
// - New video  → inserts with first snapshot; $setOnInsert guards immutable fields.
// - Existing   → updates latest stats only; snapshots array is NOT touched.
//   (The ID-filter dedup set prevents re-discovery in practice.)

export async function upsertVideo(record: RawCrawlerRecord): Promise<void> {
  const col = await getCollection<VideoDocument>(COL.VIDEOS);

  const ageHours = Math.max(0, (record.fetched_at.getTime() - record.published_at.getTime()) / 3_600_000);
  const engagement_score = computeEngagement(record);
  const viral_score = computeViralScore(record, ageHours);

  const firstSnap: VideoSnapshot = {
    ts: record.fetched_at,
    view_count: record.view_count,
    likes: record.likes,
    comments: record.comments,
    shares: record.shares,
    saves: record.saves,
    delta_views: 0,
    delta_hours: 0,
    rolling_velocity: 0,   // no prev snapshot
    engagement_score,
    viral_score,
  };

  // Build $set conditionally to avoid writing `undefined` for optional fields
  const $set: Document = {
    video_id: record.video_id,
    platform: record.platform,
    url: record.url,
    published_at: record.published_at,
    author: record.author,
    hashtags: record.hashtags,
    view_count: record.view_count,
    likes: record.likes,
    comments: record.comments,
    shares: record.shares,
    saves: record.saves,
    last_refreshed_at: record.fetched_at,
    engagement_score,
    // viral_score intentionally excluded: score is set on first insert via $setOnInsert
    // and updated only by pushSnapshot. Re-discovery must not overwrite a valid peak
    // score with a stale lifetime-average vph that may now fall below the gate.
  };
  if (record.title !== undefined) $set["title"] = record.title;
  if (record.sound !== undefined) $set["sound"] = record.sound;

  await col.updateOne(
    { video_id: record.video_id, platform: record.platform },
    {
      $setOnInsert: {
        first_seen_at: record.fetched_at,
        snapshot_count: 1,
        snapshots: [firstSnap],
        viral_acceleration: null,
        viral_score,
      },
      $set,
    },
    { upsert: true },
  );

  await appendAudit(record);
}

// ─── pushSnapshot ─────────────────────────────────────────────────────────────
//
// Called by refresh crawler (Loop 2) each refresh cycle.
// Fetches the previous snapshot to compute delta_views / delta_hours / rolling_velocity.
//
// viral_acceleration is non-null only when we have two real velocity readings:
//   snap 1 → delta_hours = 0, no real velocity
//   snap 2 → delta_hours > 0, first real velocity  → acceleration = null
//   snap 3+ → two real velocities → acceleration = vNow - vPrev

export async function pushSnapshot(
  videoId: string,
  platform: Platform,
  record: RawCrawlerRecord,
): Promise<void> {
  const col = await getCollection<VideoDocument>(COL.VIDEOS);

  // Fetch only the last snapshot to compute deltas (avoid loading full history)
  const doc = await col.findOne(
    { video_id: videoId, platform },
    { projection: { _id: 0, snapshots: { $slice: -1 } } },
  );
  if (!doc) return;   // video not found — discovery must run first

  const prevSnap = doc.snapshots?.[0] ?? null;

  const delta_views = prevSnap != null
    ? Math.max(0, record.view_count - prevSnap.view_count)
    : 0;
  const delta_hours = prevSnap != null
    ? Math.max(0, (record.fetched_at.getTime() - prevSnap.ts.getTime()) / 3_600_000)
    : 0;
  const rolling_velocity = delta_hours > 0 ? delta_views / delta_hours : 0;

  const ageHours = Math.max(0, (record.fetched_at.getTime() - record.published_at.getTime()) / 3_600_000);
  const engagement_score = computeEngagement(record);
  // Use rolling_velocity (real incremental speed) for gate+formula so aged videos
  // aren't falsely zeroed by the lifetime-average vph dropping below the threshold.
  // When score would drop to 0 (velocity decayed below gate), fall back to lifetime
  // vph so the video fades gracefully rather than disappearing from the frontend.
  const freshScore = computeViralScore(record, ageHours, rolling_velocity || undefined);
  const viral_score = freshScore > 0
    ? freshScore
    : computeViralScore(record, ageHours, undefined);   // lifetime vph fallback

  const snap: VideoSnapshot = {
    ts: record.fetched_at,
    view_count: record.view_count,
    likes: record.likes,
    comments: record.comments,
    shares: record.shares,
    saves: record.saves,
    delta_views,
    delta_hours,
    rolling_velocity,
    engagement_score,
    viral_score,
  };

  // Acceleration = velocity change vs previous snapshot.
  // Requires BOTH the current AND previous snapshot to have real velocity measurements
  // (delta_hours > 0). The first snapshot always has delta_hours = 0 and
  // rolling_velocity = 0, so:
  //   snap 1 → delta_hours = 0 → accel = null
  //   snap 2 → prevSnap.delta_hours = 0 → accel = null  (would be vNow − 0, not real)
  //   snap 3+ → prevSnap.delta_hours > 0 → accel = vNow − vPrev  ✓
  const viral_acceleration: number | null =
    prevSnap != null && delta_hours > 0 && prevSnap.delta_hours > 0
      ? rolling_velocity - prevSnap.rolling_velocity
      : null;

  const $set: Document = {
    view_count: record.view_count,
    likes: record.likes,
    comments: record.comments,
    shares: record.shares,
    saves: record.saves,
    last_refreshed_at: record.fetched_at,
    engagement_score,
    viral_score,
    viral_acceleration,
    hashtags: record.hashtags,
  };
  if (record.title !== undefined) $set["title"] = record.title;
  if (record.sound !== undefined) $set["sound"] = record.sound;

  await col.updateOne(
    { video_id: videoId, platform },
    {
      $set,
      $push: { snapshots: snap },
      $inc: { snapshot_count: 1 },
    },
  );

  await appendAudit(record);
}

// ─── queryVideos ──────────────────────────────────────────────────────────────
//
// Aggregation pipeline with 4 stages:
//   1. $match (index-friendly: stored fields)
//   2. $addFields: age_hours
//   3. $addFields: viral_velocity, status, backward-compat aliases
//   4. $match (computed fields: status, viral_velocity)
//   5. $facet: {data: [sort+page], meta: [count]}
//
// NEVER stores age_hours / viral_velocity / status — always computed here.

const MS_PER_HOUR = 3_600_000;

const ADD_AGE_HOURS: Document = {
  $addFields: {
    age_hours: {
      $max: [
        0,
        { $divide: [{ $subtract: ["$$NOW", "$published_at"] }, MS_PER_HOUR] },
      ],
    },
  },
};

const ADD_COMPUTED: Document = {
  $addFields: {
    // viral_velocity = rolling_velocity from the most recent snapshot (real incremental speed).
    // Falls back to lifetime view_count / age_hours only when the last snapshot has no
    // real measurement (snapshot_count = 1, i.e. rolling_velocity stored as 0).
    viral_velocity: {
      $let: {
        vars: { lastSnap: { $arrayElemAt: ["$snapshots", -1] } },
        in: {
          $cond: {
            if: { $gt: [{ $ifNull: ["$$lastSnap.rolling_velocity", 0] }, 0] },
            then: "$$lastSnap.rolling_velocity",
            else: {
              // Single snapshot: use views/age at crawl time, not query time
              $let: {
                vars: {
                  crawlAgeHours: {
                    $divide: [
                      { $subtract: ["$$lastSnap.ts", "$published_at"] },
                      MS_PER_HOUR,
                    ],
                  },
                },
                in: {
                  $cond: {
                    if:   { $gt: ["$$crawlAgeHours", 0] },
                    then: { $divide: ["$$lastSnap.view_count", "$$crawlAgeHours"] },
                    else: 0,
                  },
                },
              },
            },
          },
        },
      },
    },
    // Status priority: Declining > Viral > Trending > Emerging
    // null acceleration is never treated as negative ($ne guard required).
    status: {
      $switch: {
        branches: [
          {
            case: {
              $and: [
                { $ne: ["$viral_acceleration", null] },
                { $lt: ["$viral_acceleration", 0] },
              ],
            },
            then: "Declining",
          },
          { case: { $gte: ["$viral_score", 75] }, then: "Viral" },
          { case: { $gte: ["$viral_score", 50] }, then: "Trending" },
        ],
        default: "Emerging",
      },
    },
    favorites: "$saves",
    tags: "$hashtags",
  },
};

export async function queryVideos(filters: VideoFilters = {}): Promise<VideosResponse> {
  const col = await getCollection<VideoDocument>(COL.VIDEOS);
  const now = new Date();
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
  const skip = (page - 1) * limit;

  const sortKey = filters.sort ?? "viral_score";
  const sortDir = filters.dir === "asc" ? 1 : -1;
  const sortDoc: Document = { [sortKey]: sortDir };
  if (sortKey !== "viral_score") sortDoc["viral_score"] = -1;  // secondary sort

  // ── Pre-match: stored fields (index-eligible) ─────────────────────────────
  const preMatch: Document = {};

  if (filters.platform && filters.platform !== "all") {
    preMatch["platform"] = filters.platform;
  }

  // view_count
  if (filters.minViews !== undefined || filters.maxViews !== undefined) {
    preMatch["view_count"] = {
      ...(filters.minViews !== undefined && { $gte: filters.minViews }),
      ...(filters.maxViews !== undefined && { $lte: filters.maxViews }),
    };
  }

  // viral_score — default to $gt:0 so score=0 (gate-failed / seed records) are
  // excluded unless the caller explicitly requests them via minScore=0.
  preMatch["viral_score"] = {
    ...(filters.minScore !== undefined ? { $gte: filters.minScore } : { $gt: 0 }),
    ...(filters.maxScore !== undefined && { $lte: filters.maxScore }),
  };

  // viral_acceleration (sparse index — null docs excluded from acceleration filter)
  if (filters.minAcceleration !== undefined || filters.maxAcceleration !== undefined) {
    preMatch["viral_acceleration"] = {
      ...(filters.minAcceleration !== undefined && { $gte: filters.minAcceleration }),
      ...(filters.maxAcceleration !== undefined && { $lte: filters.maxAcceleration }),
    };
  }

  // engagement_score (stored, not computed)
  if (filters.minEr !== undefined || filters.maxEr !== undefined) {
    preMatch["engagement_score"] = {
      ...(filters.minEr !== undefined && { $gte: filters.minEr }),
      ...(filters.maxEr !== undefined && { $lte: filters.maxEr }),
    };
  }

  // snapshot_count
  if (filters.minSnapshots !== undefined || filters.maxSnapshots !== undefined) {
    preMatch["snapshot_count"] = {
      ...(filters.minSnapshots !== undefined && { $gte: filters.minSnapshots }),
      ...(filters.maxSnapshots !== undefined && { $lte: filters.maxSnapshots }),
    };
  }

  // isNew: first_seen_at within N hours
  if (filters.isNew !== undefined) {
    preMatch["first_seen_at"] = { $gte: new Date(now.getTime() - filters.isNew * MS_PER_HOUR) };
  }

  // Age → translate to published_at range (uses published_at_idx).
  // Default: show only videos published within the last discoveryMaxAgeHours (48h).
  // Pass maxAge explicitly to override (e.g. maxAge=720 for historical search).
  const effectiveMaxAge = filters.maxAge ?? env.discoveryMaxAgeHours;
  preMatch["published_at"] = {
    $gte: new Date(now.getTime() - effectiveMaxAge * MS_PER_HOUR),
    ...(filters.minAge !== undefined && { $lte: new Date(now.getTime() - filters.minAge * MS_PER_HOUR) }),
  };

  // Text search via regex (no text index required)
  if (filters.query) {
    const escaped = filters.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "i");
    preMatch["$or"] = [{ title: re }, { author: re }, { hashtags: re }];
  }

  // ── Post-match: computed fields ───────────────────────────────────────────
  const postMatch: Document = {};

  if (filters.status && filters.status !== "all") {
    postMatch["status"] = filters.status;
  }
  if (filters.minVelocity !== undefined || filters.maxVelocity !== undefined) {
    postMatch["viral_velocity"] = {
      ...(filters.minVelocity !== undefined && { $gte: filters.minVelocity }),
      ...(filters.maxVelocity !== undefined && { $lte: filters.maxVelocity }),
    };
  }

  // ── Pipeline ──────────────────────────────────────────────────────────────
  const pipeline: Document[] = [
    { $match: preMatch },
    ADD_AGE_HOURS,
    ADD_COMPUTED,
    ...(Object.keys(postMatch).length ? [{ $match: postMatch }] : []),
    {
      $facet: {
        data: [
          { $sort: sortDoc },
          { $skip: skip },
          { $limit: limit },
          { $project: { _id: 0, snapshots: 0 } },  // exclude heavy snapshot array from list API
        ],
        meta: [{ $count: "total" }],
      },
    },
  ];

  const [result] = await col
    .aggregate<{ data: VideoResponse[]; meta: Array<{ total: number }> }>(pipeline)
    .toArray();

  const total = result?.meta?.[0]?.total ?? 0;
  return {
    data: result?.data ?? [],
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ─── getVideoSnapshots ────────────────────────────────────────────────────────

export async function getVideoSnapshots(
  videoId: string,
  platform: Platform,
): Promise<VideoSnapshot[] | null> {
  const col = await getCollection<VideoDocument>(COL.VIDEOS);
  const doc = await col.findOne(
    { video_id: videoId, platform },
    { projection: { _id: 0, snapshots: 1 } },
  );
  if (!doc) return null;
  return doc.snapshots ?? [];
}

// ─── findViralSeeds ───────────────────────────────────────────────────────────
//
// Used by refresh loop (Loop 2) to build the refresh queue.
// Returns videos sorted by last_refreshed_at ASC — stalest first.
//
// minStaleHours: only return videos last_refreshed_at < (now - minStaleHours).
// Set to env.refreshIntervalHours to skip recently refreshed videos.
// Uses refresh_queue_idx {last_refreshed_at, viral_score} for efficient filtering.

export async function findViralSeeds(
  platform?: Platform,
  maxAgeHours: number = env.refreshMaxAgeHours,
  minStaleHours: number = 0,
): Promise<Array<Pick<VideoDocument, "video_id" | "platform" | "url" | "author">>> {
  const col = await getCollection<VideoDocument>(COL.VIDEOS);
  const now = Date.now();
  const cutoff = new Date(now - maxAgeHours * MS_PER_HOUR);

  const filter: Document = {
    viral_score: { $gte: env.refreshMinScore },
    published_at: { $gte: cutoff },
  };
  if (platform) filter["platform"] = platform;
  if (minStaleHours > 0) {
    filter["last_refreshed_at"] = { $lt: new Date(now - minStaleHours * MS_PER_HOUR) };
  }

  const docs = await col
    .find(filter as Parameters<typeof col.find>[0], {
      projection: { _id: 0, video_id: 1, platform: 1, url: 1, author: 1 },
      sort: { last_refreshed_at: 1 },
    })
    .toArray();

  return docs.map(d => ({
    video_id: d.video_id,
    platform: d.platform,
    url: d.url,
    author: d.author,
  }));
}
