import { Hono } from 'hono';
import { readJsonLines, readJson, getAgeHours, normalizeRecord } from '../lib/data.js';

function normalizePlatform(p: string | undefined): string {
  return (p ?? 'YouTube_Shorts').toLowerCase().replace('_', '');
}

export const statsRouter = new Hono();

statsRouter.get('/', async (c) => {
  try {
    const platform = c.req.query('platform') ?? 'all';

    const [ytTotal, ttTotal, ytViral, ttViral, ytHash, ttHash] = await Promise.all([
      readJsonLines('youtube/total_vids_yt.jsonl'),
      readJsonLines('tiktok/total_vids_tt.jsonl'),
      readJsonLines('youtube/viral_vids_yt.jsonl'),
      readJsonLines('tiktok/viral_vids_tt.jsonl'),
      readJson('youtube/hashtag_yt.json'),
      // tiktok hashtag file may not exist — readJson returns null gracefully
      readJson('tiktok/hashtag_tt.json'),
    ]);

    let totalVids  = [...ytTotal, ...ttTotal].map(normalizeRecord);
    let viralVids  = [...ytViral, ...ttViral].map(normalizeRecord);
    let hashtags   = [
      ...((ytHash as Record<string, unknown>[] | null) ?? []),
      ...((ttHash as Record<string, unknown>[] | null) ?? []),
    ];

    if (platform !== 'all') {
      const target = platform.toLowerCase().replace('_', '');
      totalVids  = totalVids.filter((v) => normalizePlatform(v['platform'] as string | undefined) === target);
      viralVids  = viralVids.filter((v) => normalizePlatform(v['platform'] as string | undefined) === target);
      hashtags   = hashtags.filter((h) => normalizePlatform(h['platform'] as string | undefined) === target);
    }

    const totalVideosCrawled = totalVids.length;

    let newVideos24h    = 0;
    let trendingVideos  = 0;
    let totalVelocity   = 0;
    let velocityCount   = 0;
    let totalEngagement = 0;
    let engagementCount = 0;

    for (const v of viralVids) {
      const ageHours      = getAgeHours(v['published_at']);
      const viral_score   = (v['viral_score']    as number | undefined) ?? 0;
      const viral_velocity = v['viral_velocity'];
      const engagement    = v['engagement_score'];

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
        avgVelocity:   velocityCount   > 0 ? totalVelocity   / velocityCount   : 0,
        avgEngagement: engagementCount > 0 ? totalEngagement / engagementCount : 0,
        activeHashtags: hashtags.length,
      },
    });
  } catch (error) {
    console.error('[stats] handler error:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});
