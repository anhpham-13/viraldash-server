import { Hono } from 'hono';
import { readJsonLines, readJson, getAgeHours, normalizeRecord } from '../lib/data.js';

function normalizePlatform(p: string | undefined): string {
  const s = (p ?? 'YouTube_Shorts').toLowerCase().replace('_', '');
  if (s === 'instagram') return 'instagramreels';
  return s;
}

export const statsRouter = new Hono();

statsRouter.get('/', async (c) => {
  try {
    const platform = c.req.query('platform') ?? 'all';

    const [ytTotal, ttTotal, igTotal, ytViral, ttViral, igViral, ytHash, ttHash, igHash] = await Promise.all([
      readJsonLines('youtube/total_vids_yt.jsonl'),
      readJsonLines('tiktok/total_vids_tt.jsonl'),
      readJsonLines('instagram/total_vids_ig.jsonl'),
      readJsonLines('youtube/viral_vids_yt.jsonl'),
      readJsonLines('tiktok/viral_vids_tt.jsonl'),
      readJsonLines('instagram/viral_posts_ig.jsonl'),
      readJson('youtube/hashtag_yt.json'),
      readJson('tiktok/hashtag_tt.json'),
      readJson('instagram/hashtag_ig.json'),
    ]);

    let totalVids = [...ytTotal, ...ttTotal, ...igTotal].map(normalizeRecord);
    let viralVids = [...ytViral, ...ttViral, ...igViral].map(normalizeRecord);
    const mapPlatform = (arr: any[] | null, plat: string) => 
      (arr ?? []).map(h => ({ ...h, platform: h.platform || plat }));

    let hashtags = [
      ...mapPlatform(ytHash as any[], 'YouTube_Shorts'),
      ...mapPlatform(ttHash as any[], 'TikTok'),
      ...mapPlatform(igHash as any[], 'Instagram_Reels'),
    ];

    if (platform !== 'all') {
      const target = platform.toLowerCase().replace('_', '');
      totalVids = totalVids.filter((v) => normalizePlatform(v['platform'] as string | undefined) === target);
      viralVids = viralVids.filter((v) => normalizePlatform(v['platform'] as string | undefined) === target);
      hashtags = hashtags.filter((h) => normalizePlatform(h['platform'] as string | undefined) === target);
    }

    const totalVideosCrawled = totalVids.length;

    let newVideos24h = 0;
    let trendingVideos = 0;
    let totalVelocity = 0;
    let velocityCount = 0;
    let totalEngagement = 0;
    let engagementCount = 0;

    for (const v of viralVids) {
      const ageHours = getAgeHours(v['published_at']);
      const viral_score = (v['viral_score'] as number | undefined) ?? 0;
      const viral_velocity = v['viral_velocity'];
      const engagement = v['engagement_score'];

      if (ageHours <= 24) newVideos24h++;
      if (viral_score >= 50) trendingVideos++;

      if (typeof viral_velocity === 'number') {
        totalVelocity += viral_velocity;
        velocityCount++;
      }
      if (typeof engagement === 'number') {
        totalEngagement += engagement;
        engagementCount++;
      }
    }

    return c.json({
      data: {
        totalVideosCrawled,
        newVideos24h,
        trendingVideos,
        avgVelocity: velocityCount > 0 ? totalVelocity / velocityCount : 0,
        avgEngagement: engagementCount > 0 ? totalEngagement / engagementCount : 0,
        activeHashtags: hashtags.length,
      },
    });
  } catch (error) {
    console.error('[stats] handler error:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});
