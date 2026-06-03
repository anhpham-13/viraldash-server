'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { api } from '@/lib/api-client';
import type { Stats } from '@/lib/api-client';

type Trend = 'up' | 'down' | 'flat';

const genSparkline = (trend: Trend) =>
  Array.from({ length: 14 }).map((_, i) => ({
    value:
      50 +
      (trend === 'up' ? i * 5 : trend === 'down' ? -i * 5 : 0) +
      Math.random() * 20,
  }));

interface KPICardProps {
  title: string;
  value: string;
  trend: number;
  data:  { value: number }[];
}

function KPICard({ title, value, trend, data }: KPICardProps) {
  const isPositive = trend >= 0;
  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-zinc-400">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex justify-between items-end">
          <div>
            <div className="text-2xl font-bold text-zinc-100">{value}</div>
            <p className={`text-xs flex items-center mt-1 ${isPositive ? 'text-emerald-500' : 'text-rose-500'}`}>
              {isPositive
                ? <ArrowUpRight className="h-3 w-3 mr-1" />
                : <ArrowDownRight className="h-3 w-3 mr-1" />}
              {Math.abs(trend).toFixed(2)}% from last week
            </p>
          </div>
          <div className="h-10 w-20">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <YAxis domain={['dataMin', 'dataMax']} hide />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={isPositive ? '#10b981' : '#f43f5e'}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function KPIStrip({ platform = 'all' }: { platform?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api
      .stats(platform)
      .then((d) => setStats(d.data))
      .catch(console.error);
  }, [platform]);

  // Generated once per mount — Math.random() must not run on every re-render
  // or the sparklines visually flicker whenever any parent state changes.
  const sparklines = useMemo(
    () => ({
      s1: genSparkline('flat'),
      s2: genSparkline('flat'),
      s3: genSparkline('flat'),
      s4: genSparkline('flat'),
      s5: genSparkline('flat'),
      s6: genSparkline('flat'),
    }),
    [],
  );

  if (!stats) {
    return <div className="h-24 animate-pulse bg-zinc-900/50 rounded-lg mb-6" />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-6">
      <KPICard title="Total Videos Crawled" value={stats.totalVideosCrawled.toLocaleString()} trend={0} data={sparklines.s1} />
      <KPICard title="New Videos (24h)"     value={stats.newVideos24h.toLocaleString()}       trend={0} data={sparklines.s2} />
      <KPICard title="Trending Videos"      value={stats.trendingVideos.toLocaleString()}     trend={0} data={sparklines.s3} />
      <KPICard title="Avg Viral Velocity"   value={`${stats.avgVelocity.toFixed(2)} v/h`}    trend={0} data={sparklines.s4} />
      <KPICard title="Avg Engagement Rate"  value={`${stats.avgEngagement.toFixed(2)}%`}     trend={0} data={sparklines.s5} />
      <KPICard title="Active Hashtags"      value={stats.activeHashtags.toLocaleString()}    trend={0} data={sparklines.s6} />
    </div>
  );
}
