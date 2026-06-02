import { Hono } from 'hono';
import { videoStore, type Video } from '../lib/cache.js';

// ─── Validated sortable keys ───────────────────────────────────────────────────

const SORT_KEYS = new Set<keyof Video>([
  'viral_score',
  'age_hours',
  'view_count',
  'engagement_score',
  'viral_velocity',
]);

function parseSort(raw: string | undefined): keyof Video {
  return SORT_KEYS.has(raw as keyof Video)
    ? (raw as keyof Video)
    : 'viral_score';
}

// ─── Query-param parsers ───────────────────────────────────────────────────────

function qInt(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function qFloat(v: string | undefined): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : NaN;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export const videosRouter = new Hono();

videosRouter.get('/', async (c) => {
  // ── Pagination ─────────────────────────────────────────────────────────────
  const page  = Math.max(1,   qInt(c.req.query('page'),  1));
  const limit = Math.min(200, Math.max(1, qInt(c.req.query('limit'), 25)));

  // ── Sort ───────────────────────────────────────────────────────────────────
  const sortKey = parseSort(c.req.query('sort'));
  const sortDir = c.req.query('dir') === 'asc' ? 'asc' : 'desc';

  // ── Categorical filters ────────────────────────────────────────────────────
  const platform = c.req.query('platform') ?? 'all';
  const status   = (c.req.query('status')  ?? 'all').toLowerCase();
  const query    = (c.req.query('query')   ?? '').toLowerCase().trim();

  // ── Numeric range filters ──────────────────────────────────────────────────
  // Frontend can tighten any of these; defaults keep the original 24h constraint.
  // Send minAge/maxAge explicitly to override, e.g. maxAge=48 to see 2-day-old videos.
  const minAge      = qFloat(c.req.query('minAge'));
  const maxAge      = qFloat(c.req.query('maxAge'));      // default guard applied below
  const minViews    = qFloat(c.req.query('minViews'));
  const maxViews    = qFloat(c.req.query('maxViews'));
  const minEr       = qFloat(c.req.query('minEr'));
  const maxEr       = qFloat(c.req.query('maxEr'));
  const minVelocity = qFloat(c.req.query('minVelocity'));
  const maxVelocity = qFloat(c.req.query('maxVelocity'));
  const minScore    = qFloat(c.req.query('minScore'));
  const maxScore    = qFloat(c.req.query('maxScore'));

  // ── Load from cache (no disk I/O if TTL has not expired) ──────────────────
  const all = await videoStore.getAll();

  // ── Apply filters — order: cheapest checks first ───────────────────────────

  // 1. Age — always applied; default to 24h if caller did not pass maxAge
  const effectiveMaxAge = Number.isFinite(maxAge) ? maxAge : 24;
  let result = all.filter(v => v.age_hours <= effectiveMaxAge);
  if (Number.isFinite(minAge)) result = result.filter(v => v.age_hours >= minAge);

  // 2. Platform
  if (platform !== 'all') {
    result = result.filter(v => v.platform === platform);
  }

  // 3. Status
  if (status !== 'all') {
    result = result.filter(v => v.status.toLowerCase() === status);
  }

  // 4. Numeric ranges
  if (Number.isFinite(minViews))    result = result.filter(v => v.view_count       >= minViews);
  if (Number.isFinite(maxViews))    result = result.filter(v => v.view_count       <= maxViews);
  if (Number.isFinite(minEr))       result = result.filter(v => v.engagement_score >= minEr);
  if (Number.isFinite(maxEr))       result = result.filter(v => v.engagement_score <= maxEr);
  if (Number.isFinite(minVelocity)) result = result.filter(v => v.viral_velocity   >= minVelocity);
  if (Number.isFinite(maxVelocity)) result = result.filter(v => v.viral_velocity   <= maxVelocity);
  if (Number.isFinite(minScore))    result = result.filter(v => v.viral_score      >= minScore);
  if (Number.isFinite(maxScore))    result = result.filter(v => v.viral_score      <= maxScore);

  // 5. Text search — last (most expensive)
  if (query) {
    result = result.filter(v => {
      const id   = (v.video_id ?? '').toLowerCase();
      const tags = (v['tags'] as string[] | undefined) ?? [];
      return (
        id.includes(query) ||
        (v.author ?? '').toLowerCase().includes(query) ||
        tags.some(t => t.toLowerCase().includes(query))
      );
    });
  }

  // ── Sort ───────────────────────────────────────────────────────────────────
  // Primary: user-selected column
  // Secondary: viral_velocity desc — breaks ties between platforms so both appear on page 1
  // Tertiary: age_hours asc — among same velocity, prefer fresher videos
  result = result.slice().sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    if (av !== bv) return sortDir === 'desc' ? bv - av : av - bv;
    if (a.viral_velocity !== b.viral_velocity) return b.viral_velocity - a.viral_velocity;
    return a.age_hours - b.age_hours;
  });

  // ── Paginate ───────────────────────────────────────────────────────────────
  const total      = result.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const offset     = (page - 1) * limit;

  return c.json({
    data: result.slice(offset, offset + limit),
    meta: { total, page, limit, totalPages },
  });
});
