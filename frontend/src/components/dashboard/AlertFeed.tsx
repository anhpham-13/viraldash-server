'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertCircle, TrendingUp, Zap, Activity } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { Alerts } from '@/lib/api-client';

interface FeedItem {
  id:       string;
  title:    string;
  desc:     string;
  icon:     React.ReactNode;
  time:     Date;
  severity: 'Critical' | 'High' | 'Medium';
}

export function AlertFeed() {
  const [alerts, setAlerts] = useState<Alerts | null>(null);

  useEffect(() => {
    api
      .alerts()
      .then((d) => setAlerts(d.data))
      .catch(console.error);
  }, []);

  if (!alerts) {
    return <div className="w-80 animate-pulse bg-zinc-900/50 rounded-lg" />;
  }

  const feedItems: FeedItem[] = [];

  if (alerts.pipelineAlert) {
    const { dropPct, todayCount, rollingAvg } = alerts.pipelineAlert;
    feedItems.push({
      id:       'pipeline',
      title:    'Pipeline Health Warning',
      desc:     `Ingestion dropped by ${(dropPct * 100).toFixed(2)}%. Today: ${todayCount}, Avg: ${rollingAvg}`,
      icon:     <Activity className="w-4 h-4 text-rose-500" />,
      time:     new Date(),
      severity: 'Critical',
    });
  }

  for (const v of alerts.hockeyStick ?? []) {
    feedItems.push({
      id:       `hs-${v.video_id}`,
      title:    'Hockey-Stick Alert',
      desc:     `${v.video_id} entered top 1% acceleration with ${(v.viral_velocity || 0).toFixed(2)} v/h`,
      icon:     <Zap className="w-4 h-4 text-amber-500" />,
      time:     new Date(v.published_at ?? Date.now()),
      severity: 'High',
    });
  }

  for (const v of alerts.resurgence ?? []) {
    feedItems.push({
      id:       `rs-${v.video_id}`,
      title:    'Sudden Resurgence',
      desc:     `${v.video_id} (${(v.age_hours || 0).toFixed(2)}h old) surging again with score ${
        typeof v.viral_score === 'number' && !Number.isInteger(v.viral_score)
          ? v.viral_score.toFixed(2)
          : v.viral_score
      }`,
      icon:     <TrendingUp className="w-4 h-4 text-blue-500" />,
      time:     new Date(v.published_at ?? Date.now()),
      severity: 'Medium',
    });
  }

  feedItems.sort((a, b) => b.time.getTime() - a.time.getTime());

  return (
    <Card className="w-80 bg-zinc-900 border-zinc-800 shadow-sm flex flex-col h-[calc(100vh-6rem)] sticky top-24">
      <CardHeader className="pb-3 border-b border-zinc-800">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center">
          <AlertCircle className="w-4 h-4 mr-2 text-zinc-400" />
          Real-Time Alerts
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-4">
            {feedItems.length === 0 ? (
              <p className="text-xs text-zinc-500 text-center">No active alerts.</p>
            ) : (
              feedItems.map((item) => (
                <div key={item.id} className="relative pl-4 border-l border-zinc-800 pb-2 last:pb-0">
                  <div className="absolute -left-[9px] top-1 bg-zinc-900 border border-zinc-800 rounded-full p-0.5">
                    {item.icon}
                  </div>
                  <h4 className="text-xs font-semibold text-zinc-200">{item.title}</h4>
                  <p className="text-xs text-zinc-500 mt-1">{item.desc}</p>
                  <p className="text-[10px] text-zinc-600 mt-1">
                    {formatDistanceToNow(item.time, { addSuffix: true })}
                  </p>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
