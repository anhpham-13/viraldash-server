import { Hono } from 'hono';
import { queryVideos, getVideoSnapshots } from '../../../shared/db/index.js';
import type { Platform, VideoStatus, VideoFilters, SortKey } from '../../../shared/types/index.js';

const VALID_SORT_KEYS = new Set<SortKey>([
  'viral_score', 'viral_acceleration', 'viral_velocity', 'view_count',
  'engagement_score', 'age_hours', 'last_refreshed_at', 'snapshot_count',
]);

function qInt(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function qFloat(v: string | undefined): number | undefined {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : undefined;
}

export const videosRouter = new Hono();

videosRouter.get('/', async (c) => {
  const sortRaw = c.req.query('sort');
  const sort: SortKey = (sortRaw && VALID_SORT_KEYS.has(sortRaw as SortKey))
    ? (sortRaw as SortKey)
    : 'viral_score';

  const page  = Math.max(1,   qInt(c.req.query('page'),  1));
  const limit = Math.min(200, Math.max(1, qInt(c.req.query('limit'), 25)));

  const minAge          = qFloat(c.req.query('minAge'));
  const maxAge          = qFloat(c.req.query('maxAge'));
  const minViews        = qFloat(c.req.query('minViews'));
  const maxViews        = qFloat(c.req.query('maxViews'));
  const minEr           = qFloat(c.req.query('minEr'));
  const maxEr           = qFloat(c.req.query('maxEr'));
  const minVelocity     = qFloat(c.req.query('minVelocity'));
  const maxVelocity     = qFloat(c.req.query('maxVelocity'));
  const minScore        = qFloat(c.req.query('minScore'));
  const maxScore        = qFloat(c.req.query('maxScore'));
  const minAcceleration = qFloat(c.req.query('minAcceleration'));
  const maxAcceleration = qFloat(c.req.query('maxAcceleration'));
  const minSnapshots    = qFloat(c.req.query('minSnapshots'));
  const maxSnapshots    = qFloat(c.req.query('maxSnapshots'));
  const isNew           = qFloat(c.req.query('isNew'));
  const q               = c.req.query('query')?.trim();

  const filters: VideoFilters = {
    platform: (c.req.query('platform') ?? 'all') as Platform | 'all',
    status:   (c.req.query('status')   ?? 'all') as VideoStatus | 'all',
    sort,
    dir:   c.req.query('dir') === 'asc' ? 'asc' : 'desc',
    page,
    limit,
    ...(minAge          !== undefined && { minAge }),
    ...(maxAge          !== undefined && { maxAge }),
    ...(minViews        !== undefined && { minViews }),
    ...(maxViews        !== undefined && { maxViews }),
    ...(minEr           !== undefined && { minEr }),
    ...(maxEr           !== undefined && { maxEr }),
    ...(minVelocity     !== undefined && { minVelocity }),
    ...(maxVelocity     !== undefined && { maxVelocity }),
    ...(minScore        !== undefined && { minScore }),
    ...(maxScore        !== undefined && { maxScore }),
    ...(minAcceleration !== undefined && { minAcceleration }),
    ...(maxAcceleration !== undefined && { maxAcceleration }),
    ...(minSnapshots    !== undefined && { minSnapshots }),
    ...(maxSnapshots    !== undefined && { maxSnapshots }),
    ...(isNew           !== undefined && { isNew }),
    ...(q               && { query: q }),
  };

  try {
    const result = await queryVideos(filters);
    return c.json(result);
  } catch (err) {
    console.error('[videos] queryVideos failed:', err);
    return c.json({ error: 'Database error' }, 503);
  }
});

videosRouter.get('/:videoId/snapshots', async (c) => {
  const videoId  = decodeURIComponent(c.req.param('videoId'));
  const platform = c.req.query('platform') as Platform | undefined;

  if (!videoId || !platform) {
    return c.json({ error: 'Missing videoId or platform' }, 400);
  }

  try {
    const snapshots = await getVideoSnapshots(videoId, platform);
    if (snapshots === null) return c.json({ error: 'Video not found' }, 404);
    return c.json({ data: snapshots });
  } catch (err) {
    console.error('[videos] getVideoSnapshots failed:', err);
    return c.json({ error: 'Database error' }, 503);
  }
});
