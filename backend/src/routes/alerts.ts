import { Hono } from 'hono';
import { readJsonLines, getAgeHours, normalizeRecord } from '../lib/data.js';

type EnrichedVideo = Record<string, unknown> & { age_hours: number };

const HOCKEY_STICK_PERCENTILE  = 0.99;
const RESURGENCE_MIN_AGE_H     = 48;
const PIPELINE_HEALTH_DROP_PCT = 0.15;

export const alertsRouter = new Hono();

alertsRouter.get('/', async (c) => {
  const [ytViral, ttViral, igViral, ytTotal, ttTotal, igTotal] = await Promise.all([
    readJsonLines('youtube/viral_vids_yt.jsonl'),
    readJsonLines('tiktok/viral_vids_tt.jsonl'),
    readJsonLines('instagram/viral_posts_ig.jsonl'),
    readJsonLines('youtube/total_vids_yt.jsonl'),
    readJsonLines('tiktok/total_vids_tt.jsonl'),
    readJsonLines('instagram/total_vids_ig.jsonl'),
  ]);

  const viralVideos = [...ytViral, ...ttViral, ...igViral].map(normalizeRecord);
  const totalVideos = [...ytTotal, ...ttTotal, ...igTotal].map(normalizeRecord);

  const enrichedViral: EnrichedVideo[] = viralVideos.map((v): EnrichedVideo => ({
    ...v,
    age_hours: getAgeHours(v['published_at']),
  }));

  // 1. Hockey-Stick — videos at or above the 99th-percentile viral velocity
  const velocities = enrichedViral
    .map((v) => (v['viral_velocity'] as number | undefined) ?? 0)
    .filter((vv) => vv > 0)
    .sort((a, b) => a - b);

  const hockeyThreshold =
    velocities[Math.floor(velocities.length * HOCKEY_STICK_PERCENTILE)] ?? Infinity;

  const hockeyStick = enrichedViral.filter(
    (v) =>
      ((v['viral_velocity'] as number | undefined) ?? 0) >= hockeyThreshold &&
      ((v['viral_velocity'] as number | undefined) ?? 0) > 0,
  );

  // 2. Resurgence — older videos that remain high-scoring
  const resurgence = enrichedViral.filter(
    (v) =>
      (v['age_hours'] as number) >= RESURGENCE_MIN_AGE_H &&
      ((v['viral_score'] as number | undefined) ?? 0) >= 60,
  );

  // 3. Pipeline health — daily volume drop alert
  const allVideos = [...enrichedViral, ...totalVideos];
  const byDay: Record<string, number> = {};

  for (const v of allVideos) {
    const pub = v['published_at'];
    if (typeof pub !== 'string' || !pub) continue;
    const day = pub.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  const days = Object.keys(byDay).sort();
  let pipelineAlert: {
    todayCount:  number;
    rollingAvg:  number;
    dropPct:     number;
  } | null = null;

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
});
