import { Hono } from 'hono';
import { getCollection, COL, findByPlatform } from '../../../shared/db/index.js';
import type { Platform, VideoDocument } from '../../../shared/types/index.js';

const MS_PER_HOUR = 3_600_000;
const VALID_PLATFORMS = new Set<Platform>(['YouTube_Shorts', 'TikTok', 'Instagram_Reels']);

export const statsRouter = new Hono();

statsRouter.get('/', async (c) => {
  try {
    const raw = c.req.query('platform') ?? 'all';
    const platform = VALID_PLATFORMS.has(raw as Platform) ? (raw as Platform) : undefined;

    const col = await getCollection<VideoDocument>(COL.VIDEOS);
    const last24h = new Date(Date.now() - 24 * MS_PER_HOUR);

    // Single round-trip: two $addFields stages then $group for all KPIs.
    // Two stages needed because _velocity references $age_hours from stage 1.
    const pipeline = [
      ...(platform ? [{ $match: { platform } }] : []),
      {
        $addFields: {
          age_hours: {
            $max: [0, { $divide: [{ $subtract: ['$$NOW', '$published_at'] }, MS_PER_HOUR] }],
          },
        },
      },
      {
        $addFields: {
          _velocity: {
            $cond: {
              if: { $gt: ['$age_hours', 0] },
              then: { $divide: ['$view_count', '$age_hours'] },
              else: 0,
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalVideosCrawled: { $sum: 1 },
          newVideos24h: { $sum: { $cond: [{ $gte: ['$first_seen_at', last24h] }, 1, 0] } },
          trendingVideos: { $sum: { $cond: [{ $gte: ['$viral_score', 50] }, 1, 0] } },
          totalVelocity: { $sum: '$_velocity' },
          velocityCount: { $sum: { $cond: [{ $gt: ['$_velocity', 0] }, 1, 0] } },
          totalEngagement: { $sum: '$engagement_score' },
          totalAcceleration: {
            $sum: { $cond: [{ $ne: ['$viral_acceleration', null] }, '$viral_acceleration', 0] },
          },
          accelerationCount: { $sum: { $cond: [{ $ne: ['$viral_acceleration', null] }, 1, 0] } },
          acceleratingVideos: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$viral_acceleration', null] }, { $gt: ['$viral_acceleration', 0] }] },
                1, 0,
              ],
            },
          },
          declineVideos: {
            $sum: {
              $cond: [
                // Guard $ne null required: MongoDB treats null < 0 as true in aggregation expressions.
                { $and: [{ $ne: ['$viral_acceleration', null] }, { $lt: ['$viral_acceleration', 0] }] },
                1, 0,
              ],
            },
          },
          newVideos: { $sum: { $cond: [{ $eq: ['$snapshot_count', 1] }, 1, 0] } },
        },
      },
    ];

    type StatsGroup = {
      _id: null;
      totalVideosCrawled: number;
      newVideos24h: number;
      trendingVideos: number;
      totalVelocity: number;
      velocityCount: number;
      totalEngagement: number;
      totalAcceleration: number;
      accelerationCount: number;
      acceleratingVideos: number;
      declineVideos: number;
      newVideos: number;
    };

    type PlatformRefresh = { _id: Platform; lastRefresh: Date };

    const [[stats], hashtags, platformRefreshes] = await Promise.all([
      col.aggregate<StatsGroup>(pipeline).toArray(),
      findByPlatform(platform, 1000),
      col.aggregate<PlatformRefresh>([
        { $group: { _id: '$platform', lastRefresh: { $max: '$last_refreshed_at' } } },
      ]).toArray(),
    ]);

    const lastRefreshByPlatform: Record<string, string | null> = {
      YouTube_Shorts: null,
      TikTok: null,
      Instagram_Reels: null,
    };
    for (const r of platformRefreshes) {
      if (r._id && r.lastRefresh) {
        lastRefreshByPlatform[r._id] = r.lastRefresh.toISOString();
      }
    }

    return c.json({
      data: {
        totalVideosCrawled: stats?.totalVideosCrawled ?? 0,
        newVideos24h: stats?.newVideos24h ?? 0,
        trendingVideos: stats?.trendingVideos ?? 0,
        avgVelocity: stats && stats.velocityCount > 0
          ? stats.totalVelocity / stats.velocityCount : 0,
        avgEngagement: stats && stats.totalVideosCrawled > 0
          ? stats.totalEngagement / stats.totalVideosCrawled : 0,
        avgAcceleration: stats && stats.accelerationCount > 0
          ? stats.totalAcceleration / stats.accelerationCount : 0,
        acceleratingVideos: stats?.acceleratingVideos ?? 0,
        declineVideos: stats?.declineVideos ?? 0,
        newVideos: stats?.newVideos ?? 0,
        activeHashtags: hashtags.length,
        lastRefreshByPlatform,
      },
    });
  } catch (err) {
    console.error('[stats] handler error:', err);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});
