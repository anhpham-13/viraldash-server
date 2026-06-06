'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { Stats } from '@/lib/api-client';

// Mirrors VIRAL_GATES in crawler/src/core/viral-calc.ts
const GATES = [
  { name: 'TikTok', minViews: '100K', speed: '20K/h', likes: '2K', rate: '2%' },
  { name: 'YouTube', minViews: '30K', speed: '8K/h', likes: '500', rate: '1.5%' },
  { name: 'Instagram', minViews: '15K', speed: '5K/h', likes: '300', rate: '1%' },
];

// ─── Threshold reference card ─────────────────────────────────────────────────
function ThresholdCard() {
  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm md:col-span-2 xl:col-span-2">
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
          Viral Thresholds
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-zinc-500">
              <th className="text-left font-normal pb-1.5 pr-3">Platform</th>
              <th className="text-right font-normal pb-1.5 pr-2">Views</th>
              <th className="text-right font-normal pb-1.5 pr-2">Speed</th>
              <th className="text-right font-normal pb-1.5 pr-2">Likes</th>
              <th className="text-right font-normal pb-1.5">Rate</th>
            </tr>
          </thead>
          <tbody>
            {GATES.map((g, i) => (
              <tr key={g.name} className={i < GATES.length - 1 ? 'border-b border-zinc-800/60' : ''}>
                <td className="py-1.5 pr-3 font-medium text-zinc-200">{g.name}</td>
                <td className="py-1.5 pr-2 text-right text-zinc-300">{g.minViews}</td>
                <td className="py-1.5 pr-2 text-right text-zinc-300">{g.speed}</td>
                <td className="py-1.5 pr-2 text-right text-zinc-300">{g.likes}</td>
                <td className="py-1.5 text-right text-zinc-300">{g.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-emerald-600 mt-2.5 leading-snug">
          Seed: age ≤ 2h · ≥ 2K views · all saved for 48h tracking
        </p>
      </CardContent>
    </Card>
  );
}

// ─── KPI metric card ──────────────────────────────────────────────────────────
interface KPICardProps {
  title: string;
  value: string;
  note: string;
  noteColor?: string;
}

function KPICard({ title, value, note, noteColor = 'text-emerald-500' }: KPICardProps) {
  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm">
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="text-2xl font-bold text-zinc-100">{value}</div>
        <p className={`text-[11px] mt-1.5 leading-snug ${noteColor}`}>{note}</p>
      </CardContent>
    </Card>
  );
}

// ─── Last refresh per platform card ──────────────────────────────────────────
const PLATFORM_LABELS: Record<string, string> = {
  YouTube_Shorts:  'YouTube',
  TikTok:          'TikTok',
  Instagram_Reels: 'Instagram',
};

function LastRefreshCard({ data }: { data: Stats['lastRefreshByPlatform'] }) {
  const rows = (Object.keys(PLATFORM_LABELS) as Array<keyof typeof data>).map(key => ({
    label: PLATFORM_LABELS[key],
    ts: data[key],
  }));

  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm">
      <CardHeader className="pb-1 pt-4 px-4">
        <CardTitle className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">
          Last Refresh
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {rows.map(({ label, ts }) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-400">{label}</span>
            <span className="text-[11px] font-mono text-zinc-200">
              {ts
                ? formatDistanceToNow(new Date(ts), { addSuffix: true })
                : <span className="text-zinc-600">—</span>}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Strip ────────────────────────────────────────────────────────────────────
export function KPIStrip({ platform = 'all' }: { platform?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.stats(platform).then((d) => setStats(d.data)).catch(console.error);
  }, [platform]);

  if (!stats) {
    return <div className="h-24 animate-pulse bg-zinc-900/50 rounded-lg mb-6" />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-8 mb-6">
      <ThresholdCard />

      <KPICard
        title="Total Videos"
        value={stats.totalVideosCrawled.toLocaleString()}
        note="viral + seed · scored within 48h of posting"
      />

      <KPICard
        title="New"
        value={stats.newVideos.toLocaleString()}
        note="snapshot_count = 1 · initial crawl, not yet refreshed"
        noteColor="text-sky-400"
      />

      <KPICard
        title="Accelerating"
        value={stats.acceleratingVideos.toLocaleString()}
        note="velocity today > yesterday · accel > 0"
      />

      <KPICard
        title="Declining"
        value={stats.declineVideos.toLocaleString()}
        note="velocity today < yesterday · accel < 0"
        noteColor="text-rose-500"
      />

      <KPICard
        title="Active Hashtags"
        value={stats.activeHashtags.toLocaleString()}
        note="tags with ≥ 1 tracked video"
      />

      <LastRefreshCard data={stats.lastRefreshByPlatform} />
    </div>
  );
}
