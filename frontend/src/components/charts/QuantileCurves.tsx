"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Activity } from "lucide-react";

interface QuantileCurvesProps {
  videos: any[];
}

export function QuantileCurves({ videos }: QuantileCurvesProps) {
  // Generate curve data (mocking the quantile math for demonstration of the component)
  // X = Age in days, Y = View Count accumulation
  const data = Array.from({ length: 7 }).map((_, i) => {
    const day = i + 1;
    return {
      day,
      p50: Math.round(500 * Math.pow(day, 1.2)),
      p95: Math.round(2000 * Math.pow(day, 1.8)),
      p99: Math.round(5000 * Math.pow(day, 2.2)),
    };
  });

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-zinc-900 border border-zinc-800 p-3 rounded shadow-lg text-xs">
          <p className="font-bold text-zinc-100 mb-2">Day {label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }} className="flex justify-between w-32">
              <span>{entry.name}:</span>
              <span className="font-mono">{entry.value.toLocaleString()}</span>
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="bg-zinc-900 border-zinc-800 shadow-sm flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center">
          📈 Trend Performance Curves
        </CardTitle>
        <CardDescription className="text-xs text-zinc-500">
          Historical View Accumulation Baselines
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 20, right: 20, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis 
              dataKey="day" 
              name="Age (Days)" 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
            />
            <YAxis 
              stroke="#52525b"
              tick={{ fill: '#71717a', fontSize: 12 }}
              tickFormatter={(val) => val >= 1000000 ? `${(val/1000000).toFixed(1)}M` : val >= 1000 ? `${(val/1000).toFixed(0)}k` : val}
            />
            <Tooltip content={<CustomTooltip />} />
            
            <Line type="monotone" dataKey="p99" name="99th Pct (Extreme Viral)" stroke="#f43f5e" strokeWidth={2} dot={{ r: 4 }} />
            <Line type="monotone" dataKey="p95" name="95th Pct (Viral)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 4 }} />
            <Line type="monotone" dataKey="p50" name="50th Pct (Average)" stroke="#71717a" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
