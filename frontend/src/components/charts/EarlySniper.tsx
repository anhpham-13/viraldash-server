"use client";

import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Info } from "lucide-react";

interface EarlySniperProps {
  videos: any[];
  onVideoClick?: (video: any) => void;
}

export function EarlySniper({ videos, onVideoClick }: EarlySniperProps) {
  // Map videos for scatter
  const data = videos.map(v => ({
    x: v.age_hours || 0,
    y: v.engagement_score || 0,
    ...v
  })).filter(v => v.x <= 24); // Show only recent for this chart

  // Baseline logic: y = 4.5 * e^(-0.08 * x)
  const baseline = Array.from({ length: 25 }).map((_, i) => ({
    x: i,
    y: 4.5 * Math.exp(-0.08 * i)
  }));

  // Separate data into standard and prime candidates
  const primeCandidates = data.filter(v => v.x < 6 && v.y > (4.5 * Math.exp(-0.08 * v.x)) * 1.5);
  const standard = data.filter(v => !(v.x < 6 && v.y > (4.5 * Math.exp(-0.08 * v.x)) * 1.5));

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-zinc-900 border border-zinc-800 p-3 rounded shadow-lg text-xs">
          <p className="font-mono mb-1">{data.video_id}</p>
          <p className="text-zinc-400">Age: <span className="text-zinc-100">{Number(data.x).toFixed(2)}h</span></p>
          <p className="text-zinc-400">ER: <span className="text-blue-400">{Number(data.y).toFixed(2)}%</span></p>
          <p className="text-zinc-400">Score: <span className="text-emerald-400">{typeof data.viral_score === 'number' && !Number.isInteger(data.viral_score) ? data.viral_score.toFixed(2) : data.viral_score}</span></p>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center">
          🎯 Early Sniper
          <Info className="w-4 h-4 ml-2 text-zinc-500" />
        </CardTitle>
        <CardDescription className="text-xs text-zinc-500">
          Age vs Engagement Rate (Top left = Breakout Candidate)
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis 
              type="number" 
              dataKey="x" 
              name="Age (hours)" 
              domain={[0, 24]} 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
            />
            <YAxis 
              type="number" 
              dataKey="y" 
              name="Engagement (%)" 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
              tickFormatter={(val) => `${val}%`}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
            
            {/* Decay Baseline as a line on scatter */}
            <Scatter name="Baseline" data={baseline} fill="transparent" line={{ stroke: '#52525b', strokeWidth: 2, strokeDasharray: '5 5' }} shape={() => <></>} />
            
            <Scatter name="Standard" data={standard} fill="#3b82f6" opacity={0.4} onClick={(e: any) => onVideoClick?.(e.payload || e)} cursor="pointer" />
            <Scatter name="Prime" data={primeCandidates} fill="#06b6d4" className="animate-pulse" onClick={(e: any) => onVideoClick?.(e.payload || e)} cursor="pointer" />
            
          </ScatterChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
