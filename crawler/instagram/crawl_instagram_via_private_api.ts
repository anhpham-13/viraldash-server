import "dotenv/config";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral-calc.js";
import { env } from "../src/config/env.js";
import { getDb, ensureIndexes, upsertVideo, syncHashtagsFromVideos } from "../../shared/db/index.js";
import type { RawCrawlerRecord } from "../../shared/types/index.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

const COOKIE_FILE = resolve(process.cwd(), "data/instagram/cookie.json");
const ID_FILTER_FILE = resolve(process.cwd(), "data/instagram/id_filter_ig.jsonl");
const OUTPUT_FILE = resolve(process.cwd(), "data/instagram/total_vids_ig.jsonl");
const VIRAL_FILE = resolve(process.cwd(), "data/instagram/viral_posts_ig.jsonl");

// ─── Instagram web constants ──────────────────────────────────────────────────

// Stable Instagram Web App ID — matches the value Playwright's session was
// issued under. Using this instead of the mobile app ID is what makes the
// web cookies authenticate correctly.
const IG_APP_ID = "936619743392459";

const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/125.0.0.0 Safari/537.36";

// Instagram shortcode alphabet (base64url variant)
const IG_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ─── Shortcode → numeric media ID ─────────────────────────────────────────────

/**
 * Converts an Instagram shortcode (e.g. "CxL6YG9SxFB") to the numeric
 * internal media ID. BigInt is required — IDs exceed Number.MAX_SAFE_INTEGER.
 */
function shortcodeToMediaId(shortcode: string): string {
    let id = BigInt(0);
    for (const char of shortcode) {
        id = id * BigInt(64) + BigInt(IG_ALPHABET.indexOf(char));
    }
    return id.toString();
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

interface PlaywrightCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;   // Unix seconds; -1 = session cookie
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
}

interface WebSession {
    cookieHeader: string;
    csrfToken: string;
}

/**
 * Builds the `Cookie:` header string and extracts the CSRF token from a
 * Playwright cookie array. Only instagram.com-scoped cookies are included.
 */
function buildWebSession(cookies: PlaywrightCookie[]): WebSession {
    const igCookies = cookies.filter((c) =>
        c.domain === "instagram.com" ||
        c.domain === ".instagram.com" ||
        c.domain.endsWith(".instagram.com")
    );

    const cookieHeader = igCookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

    const csrfToken =
        igCookies.find((c) => c.name === "csrftoken")?.value ?? "";

    return { cookieHeader, csrfToken };
}

// ─── Web fetch with fallback ──────────────────────────────────────────────────

/**
 * Returns base headers for every Instagram web request.
 * All requests must originate from the same "browser" context that issued
 * the cookies — hence the desktop UA and web App-ID.
 */
function buildHeaders(session: WebSession, referer: string): Record<string, string> {
    return {
        "User-Agent": CHROME_UA,
        "Cookie": session.cookieHeader,
        "X-IG-App-ID": IG_APP_ID,
        "X-ASBD-ID": "129477",
        "X-CSRFToken": session.csrfToken,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.instagram.com",
        "Referer": referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    };
}

/**
 * Normalises the ?__a=1 fallback response into the same item shape returned
 * by the primary /api/v1/media/<id>/info/ endpoint, so mapToRecord stays
 * format-agnostic.
 *
 * The endpoint has returned two different envelope shapes over the years:
 *   Modern:  { items: [item] }
 *   Legacy:  { graphql: { shortcode_media: { ... } } }
 */
function normalizeWebItem(json: any): any | null {
    // Modern path — identical to mobile API response
    if (json?.items?.[0]) return json.items[0];

    // Legacy graphql envelope
    const sm = json?.graphql?.shortcode_media;
    if (!sm) return null;

    return {
        taken_at: sm.taken_at_timestamp ?? 0,
        like_count:
            sm.edge_media_preview_like?.count ??
            sm.edge_liked_by?.count ?? 0,
        comment_count: sm.edge_media_to_comment?.count ?? 0,
        view_count: sm.video_view_count ?? sm.video_play_count ?? 0,
        play_count: sm.video_play_count ?? 0,
        caption: {
            text:
                sm.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
        },
        user: {
            pk: String(sm.owner?.id ?? ""),
            username: sm.owner?.username ?? "",
            full_name: sm.owner?.full_name ?? "",
        },
        // Reels sound metadata is not present in the legacy endpoint; resolveSound
        // will fall through to the "Original audio" fallback gracefully.
    };
}

/**
 * Fetches full media metadata for a single post.
 *
 * Strategy:
 *   1. Primary  — /api/v1/media/<mediaId>/info/
 *      Same endpoint the private API library uses, now sent with web-compatible
 *      headers that match the Playwright session origin.
 *   2. Fallback — /p/<shortcode>/?__a=1&__d=dis
 *      Public web endpoint; returns either the modern items[] or legacy
 *      graphql envelope depending on Instagram's current rollout.
 */
async function fetchMediaItem(
    mediaId: string,
    shortCode: string,
    session: WebSession
): Promise<any | null> {
    const postReferer = `https://www.instagram.com/p/${shortCode}/`;

    // ── Primary ──────────────────────────────────────────────────────────────
    try {
        const primaryUrl = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
        const res = await fetch(primaryUrl, {
            headers: buildHeaders(session, postReferer),
        });

        if (res.ok) {
            const json = await res.json() as any;
            const item = normalizeWebItem(json);
            if (item) return item;
        } else {
            console.warn(`[WebFetch] Primary ${res.status} for ${shortCode}`);
        }
    } catch (err: any) {
        console.warn(`[WebFetch] Primary request error for ${shortCode}: ${err.message}`);
    }

    // ── Fallback ─────────────────────────────────────────────────────────────
    try {
        const fallbackUrl =
            `https://www.instagram.com/p/${shortCode}/?__a=1&__d=dis`;
        const res = await fetch(fallbackUrl, {
            headers: buildHeaders(session, "https://www.instagram.com/"),
        });

        if (!res.ok) {
            console.warn(`[WebFetch] Fallback ${res.status} for ${shortCode}`);
            return null;
        }

        const json = await res.json() as any;
        return normalizeWebItem(json);
    } catch (err: any) {
        console.warn(`[WebFetch] Fallback request error for ${shortCode}: ${err.message}`);
        return null;
    }
}

// ─── Output types ─────────────────────────────────────────────────────────────

interface SoundInfo {
    id: string;
    title: string;
    artist: string;
}

interface AuthorInfo {
    id: string;
    username: string;
    fullName: string;
}

interface InstagramRecord {
    id: string;
    platform: "Instagram";
    postDate: string;
    hashtags: string[];
    views: number;
    likes: number;
    comments: number;
    saves: number;
    shares: number;
    total_view_growth: number;
    url: string;
    fetchedAt: string;
    sound: SoundInfo;
    author: AuthorInfo;
}

// ─── Sound resolution (4-level priority chain) ────────────────────────────────

/**
 * Resolves sound metadata in priority order:
 *   1. clips_metadata  — Reels-native music (most complete, has audio_cluster_id)
 *   2. music_metadata.music_info  — licensed tracks
 *   3. music_metadata.original_sound_info  — user-recorded audio
 *   4. Fallback: "Original audio"
 */
function resolveSound(item: any, fallbackUsername: string): SoundInfo {
    const clip = item?.clips_metadata?.music_info?.music_asset_info;
    if (clip?.title) {
        return {
            id: String(clip.audio_cluster_id ?? clip.id ?? ""),
            title: clip.title,
            artist: clip.display_artist ?? clip.artist_name ?? "",
        };
    }

    const licensed = item?.music_metadata?.music_info?.music_asset_info;
    if (licensed?.title) {
        return {
            id: String(licensed.id ?? ""),
            title: licensed.title,
            artist: licensed.display_artist ?? "",
        };
    }

    const original = item?.music_metadata?.original_sound_info;
    if (original) {
        return {
            id: String(original.audio_asset_id ?? ""),
            title: "Original audio",
            artist: original.original_media_owner?.username ?? fallbackUsername,
        };
    }

    return { id: "", title: "Original audio", artist: fallbackUsername };
}

// ─── Record mapping ───────────────────────────────────────────────────────────

function mapToRecord(
    shortCode: string,
    inputUrl: string,
    item: any
): InstagramRecord {
    const captionText: string = item?.caption?.text ?? "";
    const username: string = item?.user?.username ?? "";

    return {
        id: shortCode,
        platform: "Instagram",
        postDate: item?.taken_at
            ? new Date((item.taken_at as number) * 1000).toISOString()
            : new Date().toISOString(),
        hashtags: Array.from(captionText.matchAll(/#[\w]+/g), (m) => m[0]),
        views: item?.view_count ?? item?.play_count ?? item?.video_view_count ?? 0,
        likes: item?.like_count ?? 0,
        comments: item?.comment_count ?? 0,
        saves: 0,  // Not exposed by the Instagram API for third-party sessions
        shares: 0, // Not exposed by the Instagram API for third-party sessions
        total_view_growth: 0,
        url: inputUrl || `https://www.instagram.com/reel/${shortCode}/`,
        fetchedAt: new Date().toISOString(),
        sound: resolveSound(item, username),
        author: {
            id: String(item?.user?.pk ?? ""),
            username,
            fullName: item?.user?.full_name ?? "",
        },
    };
}

// ─── RawCrawlerRecord normalization ──────────────────────────────────────────
// Converts InstagramRecord (local type) → canonical shared type for MongoDB.
// Platform is "Instagram_Reels" (not "Instagram") to match the Platform union.
function toRawRecord(r: InstagramRecord): RawCrawlerRecord {
  const soundStr = r.sound.title
    ? (r.sound.artist ? `${r.sound.title} - ${r.sound.artist}` : r.sound.title)
    : "";
  return {
    video_id:     r.id,
    platform:     "Instagram_Reels",
    url:          r.url,
    published_at: new Date(r.postDate),
    author:       r.author.username,
    hashtags:     r.hashtags,
    ...(soundStr && { sound: soundStr }),
    view_count:   r.views,
    likes:        r.likes,
    comments:     r.comments,
    shares:       r.shares,
    saves:        r.saves,
    fetched_at:   new Date(r.fetchedAt),
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function randomDelay(): Promise<void> {
    // 4 000 – 8 000 ms — avoids triggering Instagram's anti-bot rate limit
    const ms = 4000 + Math.floor(Math.random() * 4000);
    return sleep(ms);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // ── MongoDB init (graceful degradation if not available) ──────────────
    let mongoAvailable = false;
    try {
        const db = await getDb();
        await ensureIndexes(db);
        mongoAvailable = true;
    } catch (err: any) {
        console.warn(`[MongoDB] Not available — running JSONL-only: ${(err as Error).message}`);
    }

    if (!existsSync(COOKIE_FILE)) {
        throw new Error(`Cookie file not found: ${COOKIE_FILE}`);
    }
    if (!existsSync(ID_FILTER_FILE)) {
        throw new Error(`Input file not found: ${ID_FILTER_FILE}`);
    }

    const rawCookies: PlaywrightCookie[] = JSON.parse(
        readFileSync(COOKIE_FILE, "utf8")
    );

    if (!Array.isArray(rawCookies) || rawCookies.length === 0) {
        throw new Error(`Cookie file is empty or not a JSON array: ${COOKIE_FILE}`);
    }

    const sessionCookie = rawCookies.find((c) => c.name === "sessionid");
    if (!sessionCookie) {
        throw new Error('No "sessionid" cookie found — re-export cookies from Playwright.');
    }

    const session = buildWebSession(rawCookies);

    const dsUserIdCookie = rawCookies.find((c) => c.name === "ds_user_id");
    console.log(`[WebSession] Loaded. User ID: ${dsUserIdCookie?.value ?? "(unknown)"}`);

    mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

    const rows = await readJsonLines<{ id: string; url: string }>(ID_FILTER_FILE);
    console.log(`[WebSession] Processing ${rows.length} items from id_filter_ig.jsonl`);

    if (rows.length === 0) {
        console.log("[WebSession] Nothing to process.");
        return;
    }

    let savedCount = 0;
    let failedCount = 0;

    const CONCURRENCY = parseInt(process.env.CONCURRENCY || "1", 10);
    console.log(`[WebSession] Starting fetch with ${CONCURRENCY} concurrent workers`);

    const processItem = async (row: { id: string; url: string } | undefined, i: number) => {
        if (!row) return;

        const shortCode = row.id.trim();
        if (!shortCode) return;

        console.log(`[WebSession] [${i + 1}/${rows.length}] Fetching: ${shortCode}`);

        try {
            const mediaId = shortcodeToMediaId(shortCode);
            const item = await fetchMediaItem(mediaId, shortCode, session);

            if (!item) {
                console.warn(`[WebSession] No data returned for ${shortCode}, skipping.`);
                failedCount++;
                await randomDelay();
                return;
            }

            const record = mapToRecord(shortCode, row.url, item);
            appendFileSync(OUTPUT_FILE, `${JSON.stringify(record)}\n`, "utf8");
            savedCount++;

            // Only viral records go to MongoDB
            let viralStatus = "";
            const postMs = new Date(record.postDate).getTime();
            if (Number.isFinite(postMs) && (Date.now() - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24) {
                const viralRecord = withViralMetrics(record as any, "instagram");
                if (viralRecord.video_phase !== "rejected") {
                    // Replace /reel/ or /reels/ with /p/ for better FE display
                    viralRecord.url = viralRecord.url.replace(/\/reel[s]?\//, '/p/');
                    appendFileSync(VIRAL_FILE, `${JSON.stringify(viralRecord)}\n`, "utf8");
                    viralStatus = ` [${viralRecord.video_phase.toUpperCase()}: ${viralRecord.viral_score}]`;
                    // Only confirmed viral (not seeds) go to MongoDB to avoid score=0 noise.
                    if (mongoAvailable && viralRecord.video_phase === "viral") {
                        await upsertVideo(toRawRecord(record)).catch((e: Error) =>
                            console.warn(`[MongoDB] upsert failed ${shortCode}: ${e.message}`)
                        );
                    }
                }
            }

            console.log(
                `[WebSession] Saved ${shortCode} — views: ${record.views}, likes: ${record.likes}, author: @${record.author.username}${viralStatus}`
            );
        } catch (err: any) {
            console.error(`[WebSession] Error processing ${shortCode}: ${err.message ?? err}`);
            failedCount++;
        }

        await randomDelay();
    };

    let currentIndex = 0;
    const workers = Array.from({ length: CONCURRENCY }).map(async () => {
        while (currentIndex < rows.length) {
            const i = currentIndex++;
            await processItem(rows[i], i);
        }
    });

    await Promise.all(workers);

    console.log(`\n[WebSession] Finished. Saved: ${savedCount} | Failed: ${failedCount}`);
    console.log(`[WebSession] Output: ${OUTPUT_FILE}`);
}

import { execSync } from "node:child_process";

let isCleaningUp = false;

function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log("\n[WebSession] Run finishing or interrupted. Running post-processing...");
    try {
        console.log("\n--- Running filter-google-ids-ig ---");
        execSync("npx tsx crawler/instagram/filter-google-ids-ig.ts", { stdio: "inherit" });
    } catch (err: any) {
        console.error("Error during post-processing:", err.message);
    }
    process.exit(process.exitCode || 0);
}

process.on("SIGINT", () => {
    console.log("\n[WebSession] Caught interrupt signal (Ctrl+C).");
    cleanup();
});

main()
  .then(() => syncHashtagsFromVideos("Instagram_Reels"))
  .then(() => { cleanup(); })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
    cleanup();
  });

