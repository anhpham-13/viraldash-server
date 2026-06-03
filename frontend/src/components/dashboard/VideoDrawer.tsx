"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Clock, Play, ThumbsUp, MessageCircle, Share2, Heart } from "lucide-react";
import { format } from "date-fns";

interface VideoDrawerProps {
  video: any | null;
  isOpen: boolean;
  onClose: () => void;
}

export function VideoDrawer({ video, isOpen, onClose }: VideoDrawerProps) {
  if (!video) return null;

  const formatNumber = (val: number | string) => {
    const n = Number(val);
    if (isNaN(n) || !n) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
    return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
  };

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



          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1 flex items-center"><Clock className="w-3 h-3 mr-1" /> Published</p>
              <p className="text-sm font-medium">
                {(() => {
                  const dStr = video.published_at ?? video.postDate;
                  if (!dStr) return 'Unknown';
                  const d = new Date(dStr);
                  return isNaN(d.getTime()) ? 'Unknown' : format(d, 'MMM d, yyyy HH:mm');
                })()}
              </p>
            </div>
            <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800">
              <p className="text-xs text-zinc-500 mb-1">Channel ID</p>
              <p className="text-sm font-medium font-mono text-zinc-300 break-all" title={typeof video.author === 'string' ? video.author : (video.author?.username || video.snippet?.channelId || 'Unknown')}>
                {typeof video.author === 'string' ? video.author : (video.author?.username || video.snippet?.channelId || 'Unknown')}
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
              <span className="text-xs text-zinc-500">Favorites</span>
              <span className="text-sm font-mono mt-1">{formatNumber(video.favorites)}</span>
            </div>
          </div>

          <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider">Calculated Analytics</h3>
          <div className="space-y-3 mb-6">
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Engagement Rate</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                  (Likes + Comments + Favorites) / Views * 100
                </p>
              </div>
              <span className="font-mono text-blue-400">{(video.engagement_score || 0).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-zinc-800">
              <div>
                <p className="text-sm text-zinc-300">Viral Velocity</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                  Total Views / Age in Hours
                </p>
              </div>
              <span className="font-mono text-zinc-100">{formatNumber(video.viral_velocity || 0)} v/h</span>
            </div>

            <div className="flex justify-between items-center py-2">
              <div>
                <p className="text-sm text-zinc-300">Breakthrough Viral Score</p>
                <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                  Normalized algorithmic index (0-100)
                </p>
              </div>
              <span className="font-mono font-bold text-emerald-400 text-lg">{typeof video.viral_score === 'number' && !Number.isInteger(video.viral_score) ? video.viral_score.toFixed(2) : (video.viral_score || 0)}</span>
            </div>
          </div>

          <h3 className="text-sm font-semibold text-zinc-400 mb-3 uppercase tracking-wider">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {Array.isArray(video.tags) && video.tags.length > 0 ? video.tags.map((tag: string) => (
              <Badge key={tag} variant="secondary" className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
                #{tag}
              </Badge>
            )) : <span className="text-sm text-zinc-600">No tags found</span>}
          </div>

        </div>
      </SheetContent>
    </Sheet>
  );
}
