import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, ensureIndexes, findViralSeeds } from "../../shared/db/index.js";
import { env } from "../src/config/env.js";
import { runMetaRefresh, type RefreshSeed } from "../src/core/meta-refresh-base.js";
import type { RawCrawlerRecord } from "../../shared/types/index.js";

const COOKIE_FILE = resolve(process.cwd(), "data/instagram/cookie.json");
const IG_APP_ID   = "936619743392459";
const CHROME_UA   =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/125.0.0.0 Safari/537.36";
const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// ─── Session helpers (mirrors crawl_instagram_via_private_api.ts) ─────────────

interface PlaywrightCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }
interface WebSession { cookieHeader: string; csrfToken: string }

function shortcodeToMediaId(shortcode: string): string {
  let id = BigInt(0);
  for (const char of shortcode) id = id * BigInt(64) + BigInt(IG_ALPHABET.indexOf(char));
  return id.toString();
}

function buildWebSession(cookies: PlaywrightCookie[]): WebSession {
  const ig = cookies.filter(c =>
    c.domain === "instagram.com" || c.domain === ".instagram.com" || c.domain.endsWith(".instagram.com")
  );
  return {
    cookieHeader: ig.map(c => `${c.name}=${c.value}`).join("; "),
    csrfToken: ig.find(c => c.name === "csrftoken")?.value ?? "",
  };
}

function buildHeaders(session: WebSession, referer: string): Record<string, string> {
  return {
    "User-Agent":        CHROME_UA,
    "Cookie":            session.cookieHeader,
    "X-IG-App-ID":       IG_APP_ID,
    "X-ASBD-ID":         "129477",
    "X-CSRFToken":       session.csrfToken,
    "X-Requested-With":  "XMLHttpRequest",
    "Accept":            "*/*",
    "Accept-Language":   "en-US,en;q=0.9",
    "Origin":            "https://www.instagram.com",
    "Referer":           referer,
    "Sec-Fetch-Dest":    "empty",
    "Sec-Fetch-Mode":    "cors",
    "Sec-Fetch-Site":    "same-origin",
  };
}

function normalizeWebItem(json: any): any | null {
  if (json?.items?.[0]) return json.items[0];
  const sm = json?.graphql?.shortcode_media;
  if (!sm) return null;
  return {
    taken_at:      sm.taken_at_timestamp ?? 0,
    like_count:    sm.edge_media_preview_like?.count ?? sm.edge_liked_by?.count ?? 0,
    comment_count: sm.edge_media_to_comment?.count ?? 0,
    view_count:    sm.video_view_count ?? sm.video_play_count ?? 0,
    play_count:    sm.video_play_count ?? 0,
    caption:       { text: sm.edge_media_to_caption?.edges?.[0]?.node?.text ?? "" },
    user:          { pk: String(sm.owner?.id ?? ""), username: sm.owner?.username ?? "", full_name: sm.owner?.full_name ?? "" },
  };
}

async function fetchIgItem(shortCode: string, session: WebSession): Promise<any | null> {
  const mediaId   = shortcodeToMediaId(shortCode);
  const postReferer = `https://www.instagram.com/p/${shortCode}/`;

  // Primary: /api/v1/media/{id}/info/
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
      headers: buildHeaders(session, postReferer),
    });
    if (res.ok) {
      const item = normalizeWebItem(await res.json());
      if (item) return item;
    } else {
      console.warn(`[IgRefresh] Primary ${res.status} for ${shortCode}`);
    }
  } catch (err: any) {
    console.warn(`[IgRefresh] Primary error ${shortCode}: ${(err as Error).message}`);
  }

  // Fallback: /?__a=1
  try {
    const res = await fetch(`https://www.instagram.com/p/${shortCode}/?__a=1&__d=dis`, {
      headers: buildHeaders(session, "https://www.instagram.com/"),
    });
    if (!res.ok) { console.warn(`[IgRefresh] Fallback ${res.status} for ${shortCode}`); return null; }
    return normalizeWebItem(await res.json());
  } catch (err: any) {
    console.warn(`[IgRefresh] Fallback error ${shortCode}: ${(err as Error).message}`);
    return null;
  }
}

function resolveSound(item: any, fallbackUser: string): string {
  const clip = item?.clips_metadata?.music_info?.music_asset_info;
  if (clip?.title) return clip.display_artist ? `${clip.title} - ${clip.display_artist}` : clip.title;
  const lic = item?.music_metadata?.music_info?.music_asset_info;
  if (lic?.title) return lic.display_artist ? `${lic.title} - ${lic.display_artist}` : lic.title;
  const orig = item?.music_metadata?.original_sound_info;
  if (orig) return `Original audio — ${orig.original_media_owner?.username ?? fallbackUser}`;
  return "";
}

function toRawRecord(seed: RefreshSeed, item: any): RawCrawlerRecord {
  const now      = new Date();
  const username = item?.user?.username ?? seed.author;
  const caption: string = item?.caption?.text ?? "";
  const hashtags = Array.from(caption.matchAll(/#[\w]+/g), (m: RegExpMatchArray) => m[0]);
  const sound    = resolveSound(item, username);

  return {
    video_id:     seed.video_id,
    platform:     "Instagram_Reels",
    url:          seed.url,
    published_at: item?.taken_at ? new Date((item.taken_at as number) * 1000) : now,
    author:       username,
    hashtags,
    ...(sound && { sound }),
    view_count:   item?.view_count ?? item?.play_count ?? 0,
    likes:        item?.like_count ?? 0,
    comments:     item?.comment_count ?? 0,
    shares:       0,
    saves:        0,
    fetched_at:   now,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  if (!existsSync(COOKIE_FILE)) throw new Error(`Cookie file not found: ${COOKIE_FILE}`);

  const rawCookies: PlaywrightCookie[] = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
  if (!Array.isArray(rawCookies) || rawCookies.length === 0) throw new Error("Cookie file is empty");
  if (!rawCookies.find(c => c.name === "sessionid")) throw new Error('No "sessionid" cookie found');

  const session = buildWebSession(rawCookies);

  const db = await getDb();
  await ensureIndexes(db);

  const seeds = await findViralSeeds(
    "Instagram_Reels",
    env.refreshMaxAgeHours,
    env.refreshIntervalHours,
  );

  if (seeds.length === 0) {
    console.log("[IgRefresh] No stale seeds to refresh.");
    return;
  }

  console.log(`[IgRefresh] Refreshing ${seeds.length} Instagram Reels…`);

  await runMetaRefresh(
    seeds,
    async (seed) => {
      const item = await fetchIgItem(seed.video_id, session);
      return item ? toRawRecord(seed, item) : null;
    },
    {
      concurrency: 1,                         // Instagram is very rate-limited
      delayMs:     env.humanDelayMaxMs,        // use upper bound for safety
      retryOnce:   true,
    },
  );
}

run().catch(err => { console.error(err); process.exitCode = 1; });
