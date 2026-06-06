import { Hono } from 'hono';
import { queryVideos, getCollection, COL } from '../../../shared/db/index.js';
import type { VideoDocument } from '../../../shared/types/index.js';

const HOCKEY_STICK_PERCENTILE  = 0.99;
const RESURGENCE_MIN_AGE_H     = 48;
const PIPELINE_HEALTH_DROP_PCT = 0.15;

export const alertsRouter = new Hono();

alertsRouter.get('/', async (c) => {
  try {
    // Fetch viral videos (sorted by velocity) + resurgence candidates in parallel
    const [allRecent, resurgenceResult] = await Promise.all([
      queryVideos({ sort: 'viral_velocity', dir: 'desc', limit: 1000 }),
      queryVideos({ minAge: RESURGENCE_MIN_AGE_H, minScore: 60, sort: 'viral_score', dir: 'desc', limit: 100 }),
    ]);

    // 1. Hockey-Stick — videos at or above the 99th-percentile viral velocity
    const velocities = allRecent.data
      .map(v => v.viral_velocity)
      .filter(v => v > 0)
      .sort((a, b) => a - b);

    const hockeyThreshold =
      velocities[Math.floor(velocities.length * HOCKEY_STICK_PERCENTILE)] ?? Infinity;

    const hockeyStick = allRecent.data.filter(
      v => v.viral_velocity >= hockeyThreshold && v.viral_velocity > 0,
    );

    // 2. Resurgence — older videos that remain high-scoring
    const resurgence = resurgenceResult.data;

    // 3. Pipeline health — daily discovery volume via first_seen_at (last 8 days)
    const col      = await getCollection<VideoDocument>(COL.VIDEOS);
    const last8Days = new Date(Date.now() - 8 * 24 * 3_600_000);

    const dayDocs = await col.aggregate<{ _id: string; count: number }>([
      { $match: { first_seen_at: { $gte: last8Days } } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$first_seen_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray();

    const byDay: Record<string, number> = {};
    for (const d of dayDocs) byDay[d._id] = d.count;

    const days = Object.keys(byDay).sort();
    let pipelineAlert: { todayCount: number; rollingAvg: number; dropPct: number } | null = null;

    if (days.length >= 2) {
      const lastDay    = days[days.length - 1]!;
      const todayCount = byDay[lastDay]!;
      const last7      = days.slice(-8, -1);

      if (last7.length > 0) {
        const rollingAvg = last7.reduce((s, d) => s + (byDay[d] ?? 0), 0) / last7.length;
        const dropPct    = (rollingAvg - todayCount) / rollingAvg;

        if (dropPct > PIPELINE_HEALTH_DROP_PCT) {
          pipelineAlert = {
            todayCount,
            rollingAvg: Math.round(rollingAvg),
            dropPct,
          };
        }
      }
    }

    return c.json({
      data: { hockeyStick, resurgence, pipelineAlert },
    });
  } catch (err) {
    console.error('[alerts] handler error:', err);
    return c.json({ error: 'Failed to fetch alerts' }, 500);
  }
});
