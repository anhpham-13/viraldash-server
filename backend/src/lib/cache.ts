import { readJsonLines, normalizeRecord, getAgeHours } from './data.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Platform = 'YouTube_Shorts' | 'TikTok' | 'Instagram_Reels' | string;
export type VideoStatus = 'Emerging' | 'Trending' | 'Viral' | 'Declining';

/** Every field a route might filter or sort on is typed here. */
export interface Video {
  // identity
  video_id:         string | null;
  platform:         Platform;
  url:              string | undefined;
  published_at:     string | null;
  author:           string | undefined;

  // metrics (always numbers — coerced at cache-load time)
  view_count:       number;
  likes:            number;
  comments:         number;
  favorites:        number;
  shares:           number;
  engagement_score: number;
  viral_velocity:   number;
  viral_score:      number;

  // derived
  age_hours:        number;
  status:           VideoStatus;

  // pass-through (hashtags, sound, fetchedAt, …)
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function determineStatus(v: Record<string, unknown>, ageHours: number): VideoStatus {
  const score        = Number(v['viral_score'])       || 0;
  const acceleration = v['viral_acceleration'] as number | null | undefined;
  const engagement   = Number(v['engagement_score'])  || 0;
  const velocity     = Number(v['viral_velocity'])    || 0;

  if (acceleration != null && acceleration < 0 && score < 50) return 'Declining';
  if (score >= 80)  return 'Viral';
  if (score >= 50)  return 'Trending';
  if (ageHours < 24 && engagement > 3 && velocity > 100) return 'Emerging';
  return 'Emerging';
}

function derivePlatform(v: Record<string, unknown>): Platform {
  const url = v['url'] as string | undefined;
  if (url) {
    if (url.includes('tiktok.com'))                               return 'TikTok';
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube_Shorts';
    if (url.includes('instagram.com'))                            return 'Instagram_Reels';
  }
  return (v['platform'] as string | undefined) ?? 'YouTube_Shorts';
}

function toVideo(raw: Record<string, unknown>): Video {
  const v          = normalizeRecord(raw);
  const ageHours   = getAgeHours(v['published_at']);
  const platform   = derivePlatform(v);

  return {
    ...v,
    video_id:         (v['video_id'] as string | null) ?? null,
    platform,
    url:              v['url']          as string | undefined,
    published_at:     (v['published_at'] as string | null) ?? null,
    author:           v['author']       as string | undefined,

    // Coerce to number — TikTok has some string fields (e.g. favorites: "34")
    view_count:       Number(v['view_count'])       || 0,
    likes:            Number(v['likes'])            || 0,
    comments:         Number(v['comments'])         || 0,
    favorites:        Number(v['favorites'])        || 0,
    shares:           Number(v['shares'])           || 0,
    engagement_score: Number(v['engagement_score']) || 0,
    viral_velocity:   Number(v['viral_velocity'])   || 0,
    viral_score:      Number(v['viral_score'])      || 0,

    age_hours: ageHours,
    status:    determineStatus(v, ageHours),
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const TTL_MS = 2 * 60 * 1000; // refresh every 2 minutes

class VideoStore {
  // The ONE shared array — all requests read from the same reference.
  private _data:      Video[] = [];
  private _loadedAt:  number  = 0;
  private _loading:   Promise<void> | null = null;

  /** Read-only view — callers must NOT mutate this array. */
  async getAll(): Promise<Readonly<Video[]>> {
    if (Date.now() - this._loadedAt > TTL_MS) {
      // Collapse concurrent reload calls into one Promise
      this._loading ??= this._reload().finally(() => { this._loading = null; });
      await this._loading;
    }
    return this._data;
  }

  /** Force a reload regardless of TTL (e.g. triggered by a manual refresh endpoint). */
  async reload(): Promise<void> {
    this._loading ??= this._reload().finally(() => { this._loading = null; });
    return this._loading;
  }

  private async _reload(): Promise<void> {
    const [yt, tt] = await Promise.all([
      readJsonLines('youtube/viral_vids_yt.jsonl'),
      readJsonLines('tiktok/viral_vids_tt.jsonl'),
    ]);

    // Interleave YT and TT round-robin so that when rows are at the same viral_score
    // both platforms appear on page 1 instead of TT being pushed to later pages.
    const interleaved: Record<string, unknown>[] = [];
    const maxLen = Math.max(yt.length, tt.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < yt.length) interleaved.push(yt[i]!);
      if (i < tt.length) interleaved.push(tt[i]!);
    }

    this._data     = interleaved.map(toVideo);
    this._loadedAt = Date.now();

    const ytCount = this._data.filter(v => v.platform === 'YouTube_Shorts').length;
    const ttCount = this._data.filter(v => v.platform === 'TikTok').length;
    console.log(
      `[cache] reloaded — total: ${this._data.length}  `  +
      `YT: ${ytCount}  TT: ${ttCount}  `                 +
      `at ${new Date().toISOString()}`
    );
  }
}

export const videoStore = new VideoStore();
