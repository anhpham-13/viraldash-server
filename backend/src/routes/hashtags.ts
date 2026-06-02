import { Hono } from 'hono';
import { readJson } from '../lib/data.js';

function normalizePlatform(p: string | undefined): string {
  return (p ?? 'YouTube_Shorts').toLowerCase().replace('_', '');
}

export const hashtagsRouter = new Hono();

hashtagsRouter.get('/', async (c) => {
  const platform = c.req.query('platform') ?? 'all';

  let hashtags = ((await readJson('youtube/hashtag_yt.json')) as Record<string, unknown>[] | null) ?? [];

  if (platform !== 'all') {
    const target = platform.toLowerCase().replace('_', '');
    hashtags = hashtags.filter(
      (h) => normalizePlatform(h['platform'] as string | undefined) === target,
    );
  }

  return c.json({ data: hashtags });
});
