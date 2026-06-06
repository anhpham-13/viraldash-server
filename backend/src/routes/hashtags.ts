import { Hono } from 'hono';
import { findByPlatform } from '../../../shared/db/index.js';
import type { Platform } from '../../../shared/types/index.js';

const VALID_PLATFORMS = new Set<Platform>(['YouTube_Shorts', 'TikTok', 'Instagram_Reels']);

export const hashtagsRouter = new Hono();

hashtagsRouter.get('/', async (c) => {
  const raw      = c.req.query('platform') ?? 'all';
  const platform = VALID_PLATFORMS.has(raw as Platform) ? (raw as Platform) : undefined;
  const limit    = Math.min(500, Math.max(1, parseInt(c.req.query('limit') ?? '80', 10) || 80));

  try {
    const data = await findByPlatform(platform, limit);
    return c.json({ data });
  } catch (err) {
    console.error('[hashtags] findByPlatform failed:', err);
    return c.json({ error: 'Database error' }, 503);
  }
});
