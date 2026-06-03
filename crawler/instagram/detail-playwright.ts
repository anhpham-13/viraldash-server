import { chromium, type BrowserContext, type Page } from "playwright";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readJsonLines } from "../src/core/jsonl.js";
import { withViralMetrics } from "../src/core/viral.calc.js";
import { env } from "../src/config/env.js";

// ─── Paths ─────────────────────────────────────────────────────────────────────

const COOKIE_FILE    = resolve(process.cwd(), "data/instagram/cookie.json");
const ID_FILTER_FILE = resolve(process.cwd(), "data/instagram/id_filter_ig.jsonl");
const OUTPUT_FILE    = resolve(process.cwd(), "data/instagram/total_vids_ig.jsonl");
const VIRAL_FILE     = resolve(process.cwd(), "data/instagram/viral_posts_ig.jsonl");

const CONCURRENCY = 5;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PlaywrightCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
}

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

// ─── Helpers ───────────────────────────────────────────────────────────────────

const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function shortcodeToMediaId(shortcode: string): string {
    let id = BigInt(0);
    for (const char of shortcode) {
        id = id * BigInt(64) + BigInt(IG_ALPHABET.indexOf(char));
    }
    return id.toString();
}

// ─── Sound resolution (mirrors crawl_instagram_via_private_api.ts) ─────────────

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

// ─── Raw API item → InstagramRecord (mirrors crawl_instagram_via_private_api.ts) ─

function mapToRecord(shortCode: string, inputUrl: string, item: any): InstagramRecord {
    const captionText: string = item?.caption?.text ?? "";
    const username: string    = item?.user?.username ?? "";

    return {
        id: shortCode,
        platform: "Instagram",
        postDate: item?.taken_at
            ? new Date((item.taken_at as number) * 1000).toISOString()
            : new Date().toISOString(),
        hashtags: Array.from(captionText.matchAll(/#[\w]+/g), (m) => m[0]),
        views:    item?.play_count ?? item?.view_count ?? item?.video_view_count ?? 0,
        likes:    item?.like_count ?? 0,
        comments: item?.comment_count ?? 0,
        saves:    0,   // not exposed by Instagram API for third-party sessions
        shares:   item?.media_repost_count ?? 0,
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

// ─── Deep-scan: find the media object for our shortcode inside any JSON shape ──

function findMediaObject(obj: any, shortCode: string): any | null {
    if (!obj || typeof obj !== "object") return null;

    if (
        (obj.code === shortCode || obj.shortcode === shortCode) &&
        (obj.like_count !== undefined ||
         obj.edge_media_preview_like !== undefined ||
         obj.caption !== undefined)
    ) {
        return obj;
    }

    for (const key of Object.keys(obj)) {
        const found = findMediaObject(obj[key], shortCode);
        if (found) return found;
    }

    return null;
}

/**
 * Normalises the JSON returned by any Instagram endpoint into a raw item
 * that `mapToRecord` can consume. Supports:
 *   - Modern  { items: [item] }
 *   - Legacy  { graphql: { shortcode_media: {...} } }
 *   - Deep    any nested structure containing the shortcode object
 */
function normalizeToItem(json: any, shortCode: string): any | null {
    if (!json) return null;

    // Modern envelope
    const modern = json?.items?.[0];
    if (modern?.taken_at != null) return modern;

    // Legacy graphql envelope — remap field names to modern shape
    const sm = json?.graphql?.shortcode_media;
    if (sm?.taken_at_timestamp != null) {
        return {
            taken_at:       sm.taken_at_timestamp,
            like_count:     sm.edge_media_preview_like?.count ?? sm.edge_liked_by?.count ?? 0,
            comment_count:  sm.edge_media_to_comment?.count ?? 0,
            view_count:     sm.video_view_count ?? sm.video_play_count ?? 0,
            play_count:     sm.video_play_count ?? 0,
            video_duration: sm.video_duration,
            caption:        { text: sm.edge_media_to_caption?.edges?.[0]?.node?.text ?? "" },
            user: {
                pk:        String(sm.owner?.id ?? ""),
                username:  sm.owner?.username ?? "",
                full_name: sm.owner?.full_name ?? "",
            },
            clips_metadata:  sm.clips_metadata,
            music_metadata:  sm.music_metadata,
        };
    }

    // Deep-scan fallback for wrapped/nested responses
    return findMediaObject(json, shortCode) ?? null;
}

// ─── Worker ────────────────────────────────────────────────────────────────────

async function crawlWorker(
    workerId: number,
    rows: Array<{ id: string; url: string }>,
    getNext: () => number,
    total: number,
    cookies: PlaywrightCookie[],
): Promise<{ saved: number; failed: number }> {
    console.log(`[Worker ${workerId}] Starting browser...`);

    const userDataDir = resolve(process.cwd(), `data/user_data_ig_worker_${workerId}`);

    const ctx: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        locale: "en-US",
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/125.0.0.0 Safari/537.36",
    });

    await ctx.addCookies(
        cookies
            .filter((c) => c.domain.includes("instagram.com"))
            .map((c) => ({
                ...c,
                sameSite: (["Strict", "Lax", "None"].includes(c.sameSite)
                    ? c.sameSite
                    : "Lax") as "Strict" | "Lax" | "None",
            })),
    );

    let saved = 0;
    let failed = 0;

    while (true) {
        const i = getNext();
        if (i >= total) break;

        const row = rows[i]!;
        const shortCode = row.id.trim();
        if (!shortCode) continue;

        console.log(`[Worker ${workerId}] [${i + 1}/${total}] ${shortCode}`);
        const mediaId = shortcodeToMediaId(shortCode);
        let tab: Page | null = null;

        try {
            // Fresh tab per reel — breaks SPA routing cache between items
            tab = await ctx.newPage();

            // Navigate so the browser is on instagram.com (session cookies in scope)
            await tab.goto(
                `https://www.instagram.com/reel/${shortCode}/`,
                { waitUntil: "domcontentloaded", timeout: 25_000 },
            );

            // Call Instagram's private API directly from the browser context.
            // The browser engine automatically attaches the session cookies — no
            // manual header plumbing needed beyond X-IG-App-ID.
            const apiJson = await tab.evaluate(
                async (args: { mediaId: string; shortCode: string }) => {
                    const { mediaId, shortCode } = args;

                    const csrfToken =
                        document.cookie
                            .split(";")
                            .find((c) => c.trim().startsWith("csrftoken="))
                            ?.split("=")[1] ?? "";

                    const headers: Record<string, string> = {
                        "X-IG-App-ID": "936619743392459",
                        "X-ASBD-ID":   "129477",
                        "X-CSRFToken": csrfToken,
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "*/*",
                        "Accept-Language": "en-US,en;q=0.9",
                    };

                    // Primary: private media info endpoint
                    try {
                        const r = await fetch(
                            `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
                            { headers },
                        );
                        if (r.ok) {
                            const j = await r.json() as any;
                            if (j?.items?.[0]?.taken_at) return j;
                        }
                    } catch { /* ignore */ }

                    // Fallback: legacy ?__a=1 web endpoint
                    try {
                        const r = await fetch(
                            `https://www.instagram.com/reel/${shortCode}/?__a=1&__d=dis`,
                            { headers },
                        );
                        if (r.ok) return await r.json();
                    } catch { /* ignore */ }

                    return null;
                },
                { mediaId, shortCode },
            );

            const item = normalizeToItem(apiJson, shortCode);
            if (!item) {
                console.warn(`[Worker ${workerId}] No data for ${shortCode}.`);
                failed++;
            } else {
                const record = mapToRecord(shortCode, row.url, item);

                // ── Write to total_vids_ig.jsonl ───────────────────────────────
                appendFileSync(OUTPUT_FILE, `${JSON.stringify(record)}\n`, "utf8");
                saved++;

                // ── Viral scoring (mirrors crawl_instagram_via_private_api.ts) ─
                let viralStatus = "";
                const postMs = new Date(record.postDate).getTime();
                if (
                    Number.isFinite(postMs) &&
                    (Date.now() - postMs) / 3_600_000 <= env.maxVideoAgeDays * 24
                ) {
                    const viralRecord = withViralMetrics(record as any);
                    if (viralRecord.viral_score >= env.viralScoreThreshold) {
                        viralRecord.url = viralRecord.url.replace(/\/reel[s]?\//, "/p/");
                        appendFileSync(VIRAL_FILE, `${JSON.stringify(viralRecord)}\n`, "utf8");
                        viralStatus = ` [VIRAL: ${viralRecord.viral_score}]`;
                    }
                }

                console.log(
                    `[Worker ${workerId}] Saved ${shortCode}` +
                    ` — views: ${record.views}` +
                    `, likes: ${record.likes}` +
                    `, @${record.author.username}` +
                    viralStatus,
                );
            }
        } catch (err: any) {
            console.error(`[Worker ${workerId}] Error on ${shortCode}: ${err.message}`);
            failed++;
        } finally {
            if (tab) await tab.close().catch(() => { });
        }

        // Human-like delay between requests
        await sleep(2_500 + Math.floor(Math.random() * 2_500));
    }

    await ctx.close();
    console.log(`[Worker ${workerId}] Done. saved=${saved} failed=${failed}`);
    return { saved, failed };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!existsSync(COOKIE_FILE)) {
        throw new Error(
            `Cookie file not found: ${COOKIE_FILE}\n` +
            `Run: npx tsx crawler/instagram/get_instagram_cookie.ts`,
        );
    }
    if (!existsSync(ID_FILTER_FILE)) {
        throw new Error(`Input file not found: ${ID_FILTER_FILE}`);
    }

    const cookies: PlaywrightCookie[] = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    if (!Array.isArray(cookies) || cookies.length === 0) {
        throw new Error("Cookie file is empty or not a JSON array.");
    }

    const rows = await readJsonLines<{ id: string; url: string }>(ID_FILTER_FILE);
    console.log(
        `[Main] ${rows.length} reels to crawl across ${CONCURRENCY} parallel browsers.`,
    );
    if (rows.length === 0) return;

    mkdirSync(resolve(process.cwd(), "data/instagram"), { recursive: true });

    let cursor = 0;
    const getNext = () => cursor++;

    const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
            crawlWorker(i + 1, rows, getNext, rows.length, cookies),
        ),
    );

    const totalSaved  = results.reduce((s, r) => s + r.saved, 0);
    const totalFailed = results.reduce((s, r) => s + r.failed, 0);

    console.log(`\n[Main] Finished. Saved: ${totalSaved} | Failed: ${totalFailed}`);
    console.log(`[Main] Output : ${OUTPUT_FILE}`);
    console.log(`[Main] Viral  : ${VIRAL_FILE}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
