"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Clock, Play, ThumbsUp, MessageCircle, Share2, Heart, Camera } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import type { Video, VideoSnapshot } from "@/lib/api-client";
import { api } from "@/lib/api-client";

interface VideoDrawerProps {
  video: Video | null;
  isOpen: boolean;
  onClose: () => void;
}

export function VideoDrawer({ video, isOpen, onClose }: VideoDrawerProps) {
  const [snapshots, setSnapshots] = useState<VideoSnapshot[]>([]);
  const [snapsLoading, setSnapsLoading] = useState(false);

  useEffect(() => {
    if (!video || !isOpen) {
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    setSnapsLoading(true);
    api.videoSnapshots(video.platform, video.video_id as string)
      .then(res => { if (!cancelled) setSnapshots(res.data); })
      .catch(() => { if (!cancelled) setSnapshots([]); })
      .finally(() => { if (!cancelled) setSnapsLoading(false); });
    return () => { cancelled = true; };
  }, [video?.video_id, video?.platform, isOpen]);

  if (!video) return null;

  const formatNumber = (val: number | string) => {
    const n = Number(val);
    if (isNaN(n) || !n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
    return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
  };

  const formatHours = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
  };

  const accelColor =
    video.viral_acceleration == null   ? 'text-zinc-500' :
    video.viral_acceleration > 0       ? 'text-emerald-400' :
    video.viral_acceleration < 0       ? 'text-rose-400' : 'text-zinc-400';

  const accelLabel =
    video.viral_acceleration == null ? '—' :
    `${video.viral_acceleration > 0 ? '+' : ''}${Math.round(video.viral_acceleration)} v/h`;

  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent className="w-[400px] sm:w-[540px] bg-zinc-950 border-zinc-800 text-zinc-100 p-0 overflow-y-auto">
        <div className="p-6">
          <SheetHeader className="mb-6">
            <div className="flex items-start justify-between">
              <div>
                <SheetTitle className="text-xl font-bold text-zinc-100 font-mono">
                  {video.video_id}
                </SheetTitle>
                <SheetDescription className="text-zinc-400 mt-1 flex items-center">
                  <Badge variant="outline" className="mr-2 bg-zinc-900 border-zinc-700 text-zinc-300">
                    {video.platform?.replace('_', ' ')}
                  </Badge>
                  <a href={video.url} target="_blank" rel="noreferrer" className="flex items-center hover:text-blue-400 transition-colors">
                    View on {video.platform?.split('_')[0]} <ExternalLink className="w-3 h-3 ml-1" />
                  </a>
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="bg-zinc-900 p-3 rounded-lg border border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1 flex items-center"><Clock className="w-3 h-3 mr-1" /> Published</p>
              <p className="text-sm font-medium">
                {(() => {
                  const dStr = video.published_at;
                  if (!dStr) return 'Unknown';
                  const d = new Date(dStr);
                  return isNaN(d.getTime()) ? 'Unknown' : format(d, 'MMM d, yyyy HH:mm');
                })()}
              </p>
            </div>
            <div className="bg-zinc-900 p-3 rounded-lg border border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1">Author</p>
              <p className="text-sm font-medium font-mono text-zinc-300 break-all" title={video.author ?? ''}>
                {video.author ?? 'Unknown'}
              </p>
            </div>
            <div className="bg-zinc-900 p-3 rounded-lg border border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1">Last Refreshed</p>
              <p className="text-sm font-medium">
                {video.last_refreshed_at
                  ? formatDistanceToNow(new Date(video.last_refreshed_at), { addSuffix: true })
                  : 'Unknown'}
              </p>
            </div>
          </div>

          <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider">Core Metrics</h3>
          <div className="grid grid-cols-4 gap-2 mb-6">
            <div className="bg-zinc-900/50 p-3 rounded border border-zinc-800/50 flex flex-col items-center justify-center text-center">
              <Play className="w-4 h-4 text-zinc-400 mb-1" />
              <span className="text-xs text-zinc-500">Views</span>
              <span className="text-sm font-mono mt-1">{formatNumber(video.view_count)}</span>
            </div>
            <div className="bg-zinc-900/50 p-3 rounded border border-zinc-800/50 flex flex-col items-center justify-center text-center">
              <ThumbsUp className="w-4 h-4 text-zinc-400 mb-1" />
              <span className="text-xs text-zinc-500">Likes</span>
              <span className="text-sm font-mono mt-1">{formatNumber(video.likes)}</span>
            </div>
            <div className="bg-zinc-900/50 p-3 rounded border border-zinc-800/50 flex flex-col items-center justify-center text-center">
              <MessageCircle className="w-4 h-4 text-zinc-400 mb-1" />
              <span className="text-xs text-zinc-500">Comments</span>
              <span className="text-sm font-mono mt-1">{formatNumber(video.comments)}</span>
            </div>
            <div className="bg-zinc-900/50 p-3 rounded border border-zinc-800/50 flex flex-col items-center justify-center text-center">
              <Heart className="w-4 h-4 text-zinc-400 mb-1" />
              <span className="text-xs text-zinc-500">Saves</span>
              <span className="text-sm font-mono mt-1">{formatNumber(video.saves ?? video.favorites)}</span>
            </div>
          </div>

          <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider">Calculated Analytics</h3>
          <div className="space-y-3 mb-6">
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Engagement Rate</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">(Likes + Comments + Saves) / Views × 100</p>
              </div>
              <span className="font-mono text-blue-400">{(video.engagement_score || 0).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Viral Velocity</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Total Views / Age in Hours</p>
              </div>
              <span className="font-mono text-zinc-100">{formatNumber(video.viral_velocity || 0)} v/h</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Acceleration</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Velocity change between last two snapshots</p>
              </div>
              <span className={`font-mono ${accelColor}`}>{accelLabel}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Tracking Depth</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Data snapshots collected</p>
              </div>
              <span className="font-mono text-zinc-300">
                {video.snapshot_count ?? 1} snapshot{(video.snapshot_count ?? 1) !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex justify-between items-center py-2">
              <div>
                <p className="text-sm text-zinc-300">Breakthrough Viral Score</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Normalized algorithmic index (0–100)</p>
              </div>
              <span className="font-mono font-bold text-emerald-400 text-lg">
                {typeof video.viral_score === 'number' && !Number.isInteger(video.viral_score)
                  ? video.viral_score.toFixed(2)
                  : (video.viral_score || 0)}
              </span>
            </div>
          </div>

          {/* ── Snapshot Timeline ─────────────────────────────────────────── */}
          {(snapsLoading || snapshots.length > 0) && (
            <>
              <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider flex items-center gap-2">
                <Camera className="w-3.5 h-3.5" />
                Snapshot Timeline
              </h3>

              {snapsLoading ? (
                <div className="text-xs text-zinc-600 mb-6">Loading snapshots…</div>
              ) : (
                <div className="relative mb-6">
                  {/* vertical rail */}
                  <div className="absolute left-[15px] top-3 bottom-3 w-px bg-zinc-800" />

                  <div className="space-y-0">
                    {snapshots.map((snap, idx) => {
                      const isFirst = idx === 0;
                      const deltaLabel = isFirst
                        ? 'Start'
                        : `+${formatHours(snap.delta_hours)}`;

                      const effectiveVph = isFirst && video.published_at
                        ? snap.view_count / Math.max(0.01,
                            (new Date(snap.ts).getTime() - new Date(video.published_at).getTime()) / 3_600_000
                          )
                        : snap.rolling_velocity;
                      const velColor =
                        effectiveVph <= 0    ? 'text-zinc-500' :
                        effectiveVph > 5000  ? 'text-emerald-400' :
                        effectiveVph > 1000  ? 'text-blue-400' : 'text-zinc-300';

                      return (
                        <div key={idx} className="flex gap-4 relative">
                          {/* dot */}
                          <div className="flex-none w-8 flex flex-col items-center pt-3">
                            <div className={`w-3 h-3 rounded-full border-2 z-10 ${
                              isFirst
                                ? 'bg-zinc-950 border-zinc-400'
                                : 'bg-zinc-950 border-zinc-600'
                            }`} />
                          </div>

                          {/* card */}
                          <div className="flex-1 pb-4">
                            <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg p-3">
                              {/* header row */}
                              <div className="flex items-center justify-between mb-2">
                                <span className={`text-xs font-mono font-semibold ${
                                  isFirst ? 'text-zinc-300' : 'text-zinc-500'
                                }`}>
                                  {deltaLabel}
                                </span>
                                <span className="text-[10px] text-zinc-600 font-mono">
                                  {format(new Date(snap.ts), 'MMM d HH:mm')}
                                </span>
                              </div>

                              {/* stats row */}
                              <div className="grid grid-cols-3 gap-2">
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-500">Views</p>
                                  <p className="text-xs font-mono text-zinc-200 mt-0.5">
                                    {formatNumber(snap.view_count)}
                                  </p>
                                  {!isFirst && snap.delta_views > 0 && (
                                    <p className="text-[10px] font-mono text-emerald-500">
                                      +{formatNumber(snap.delta_views)}
                                    </p>
                                  )}
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-500">Likes</p>
                                  <p className="text-xs font-mono text-zinc-200 mt-0.5">
                                    {formatNumber(snap.likes)}
                                  </p>
                                </div>
                                <div className="text-center">
                                  <p className="text-[10px] text-zinc-500">Velocity</p>
                                  <p className={`text-xs font-mono mt-0.5 ${velColor}`}>
                                    {formatNumber(effectiveVph)}/h
                                  </p>
                                </div>
                              </div>

                              {/* score */}
                              <div className="mt-2 pt-2 border-t border-zinc-800/50 flex justify-between items-center">
                                <span className="text-[10px] text-zinc-600">Viral Score</span>
                                <span className="text-xs font-mono font-semibold text-emerald-400">
                                  {snap.viral_score}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {(video.hashtags ?? video.tags ?? []).length > 0
              ? (video.hashtags ?? video.tags ?? []).map((tag: string) => (
                  <Badge key={tag} variant="secondary" className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
                    {tag.startsWith('#') ? tag : `#${tag}`}
                  </Badge>
                ))
              : <span className="text-sm text-zinc-600">No tags found</span>}
          </div>

          {video.sound && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-zinc-400 mb-2 uppercase tracking-wider">Sound</h3>
              <p className="text-sm text-zinc-300">{video.sound}</p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
