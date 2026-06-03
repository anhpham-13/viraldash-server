"use client";

import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Hash } from "lucide-react";

interface HashtagSurgeProps {
  hashtags: any[];
}

const GENERIC_TAGS = new Set([
  'shorts', 'short', 'yt shorts', 'youtube shorts', 'viral',
  'trending', 'trend', 'fyp', 'foryou', 'for you', 'video',
  'videos', 'new', 'latest', 'best', 'popular', 'official',
  'tiktok', 'reels', 'youtube',
]);

export function HashtagSurge({ hashtags }: HashtagSurgeProps) {
  const filtered = hashtags.filter(item => {
    const tag = String(item.tag || '').toLowerCase().trim();
    return tag.length >= 2 && !GENERIC_TAGS.has(tag);
  }).slice(0, 100);

  const data = filtered.map(item => {
    const postCount = item.videos || item.count || 0;
    const totalViews = item.totalViews || (item.avgViews || 0) * postCount;
    const avgViews = item.avgViews || (postCount > 0 ? totalViews / postCount : 0);
    const score = item.score || 1;
    const estAvgAge = Math.max(0.5, Math.min(24, (avgViews / (score + 1)) * 0.05));
    const aggViralVelocity = estAvgAge > 0 ? (totalViews / Math.max(postCount, 1)) / estAvgAge : 0;

    return {
      tag: item.tag,
      x: +estAvgAge.toFixed(2),
      y: +aggViralVelocity.toFixed(2),
      z: postCount,
      avgViews: Math.round(avgViews),
      avgLikeRate: item.avgLikeRate || 0,
    };
  });

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-zinc-900 border border-zinc-800 p-3 rounded shadow-lg text-xs">
          <p className="font-bold text-blue-400 mb-1">#{data.tag}</p>
          <p className="text-zinc-400">Avg Age: <span className="text-zinc-100">{Number(data.x).toFixed(2)}h</span></p>
          <p className="text-zinc-400">Velocity: <span className="text-emerald-400">{Number(data.y).toFixed(2)} v/h</span></p>
          <p className="text-zinc-400">Videos: <span className="text-zinc-100">{data.z}</span></p>
          <p className="text-zinc-400">Avg Views: <span className="text-zinc-100">{data.avgViews.toLocaleString()}</span></p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center">
          💥 Hashtag Surge
        </CardTitle>
        <CardDescription className="text-xs text-zinc-500">
          Age vs Aggregated Velocity (Size = Videos)
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis 
              type="number" 
              dataKey="x" 
              name="Avg Age" 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
            />
            <YAxis 
              type="number" 
              dataKey="y" 
              name="Velocity" 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
              tickFormatter={(val) => val >= 1000 ? `${(val/1000).toFixed(0)}k` : val}
            />
            <ZAxis type="number" dataKey="z" range={[20, 400]} />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
            
            <Scatter name="Hashtags" data={data} fill="#8b5cf6" fillOpacity={0.6} stroke="#a78bfa" strokeWidth={1} />
          </ScatterChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
