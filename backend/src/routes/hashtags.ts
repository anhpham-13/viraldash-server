import { Hono } from 'hono';
import { readJson } from '../lib/data.js';

function normalizePlatform(p: string | undefined): string {
  const s = (p ?? 'YouTube_Shorts').toLowerCase().replace('_', '');
  if (s === 'instagram') return 'instagramreels';
  return s;
}

export const hashtagsRouter = new Hono();

hashtagsRouter.get('/', async (c) => {
  const platform = c.req.query('platform') ?? 'all';

  const [ytHash, ttHash, igHash] = await Promise.all([
    readJson('youtube/hashtag_yt.json'),
    readJson('tiktok/hashtag_tt.json'),
    readJson('instagram/hashtag_ig.json'),
  ]);

  const mapPlatform = (arr: any[] | null, plat: string) => 
    (arr ?? []).map(h => ({ ...h, platform: h.platform || plat }));

  let hashtags = [
    ...mapPlatform(ytHash as any[], 'YouTube_Shorts'),
    ...mapPlatform(ttHash as any[], 'TikTok'),
    ...mapPlatform(igHash as any[], 'Instagram_Reels'),
  ];

  if (platform !== 'all') {
    const target = platform.toLowerCase().replace('_', '');
    hashtags = hashtags.filter(
      (h) => normalizePlatform(h['platform'] as string | undefined) === target,
    );
  }

  return c.json({ data: hashtags });
});
