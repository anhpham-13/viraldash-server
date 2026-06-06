'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useTableState } from '@/hooks/useTableState';
import { Header } from '@/components/layout/Header';
import { KPIStrip } from '@/components/dashboard/KPIStrip';
import { ViralTable } from '@/components/dashboard/ViralTable';
import { EarlySniper } from '@/components/charts/EarlySniper';
import { HashtagSurge } from '@/components/charts/HashtagSurge';
import { api } from '@/lib/api-client';
import type { Video, Hashtag, SortKey, SortDir, VideoParams } from '@/lib/api-client';

// VideoDrawer is only needed after a row click — keep it out of the initial bundle.
const VideoDrawer = dynamic(
  () => import('@/components/dashboard/VideoDrawer').then((m) => m.VideoDrawer),
  { ssr: false },
);

const TABS = [
  {
    id: 'all',
    label: 'All',
    title: 'All tracked videos',
  },
  {
    id: 'new',
    label: 'New',
    title: 'snapshot_count = 1 — just discovered, no refresh yet',
  },
  {
    id: 'accelerating',
    label: 'Accelerating',
    title: 'snapshot_count ≥ 3 and acceleration ≥ 0.01 — growth rate increasing',
  },
  {
    id: 'declining',
    label: 'Declining',
    title: 'snapshot_count ≥ 3 and acceleration < 0 — growth rate slowing',
  },
] as const;

type TabId = typeof TABS[number]['id'];

// Maps each tab to the VideoParams filters it injects into the API call.
// Rules:
//   New:          snapshot_count <= 1
//   Growing:      snapshot_count >= 2  AND  viral_velocity > 0
//   Accelerating: snapshot_count >= 3  AND  viral_acceleration >= 0.01
//   Declining:    snapshot_count >= 3  AND  viral_acceleration < 0
function tabParams(tab: TabId): Partial<VideoParams> {
  switch (tab) {
    case 'new': return { maxSnapshots: 1 };
    case 'accelerating': return { minSnapshots: 3, minAcceleration: 0.01 };
    case 'declining': return { minSnapshots: 3, status: 'Declining' };
    default: return {};
  }
}

interface Props {
  initialVideos: Video[];
  initialTotal: number;
  initialHashtags: Hashtag[];
}

export function DashboardClient({ initialVideos, initialTotal, initialHashtags }: Props) {
  const { platform, page, limit, sort, dir, query, update } = useTableState();

  const [videos, setVideos] = useState<Video[]>(initialVideos);
  const [total, setTotal] = useState<number>(initialTotal);
  const [hashtags, setHashtags] = useState<Hashtag[]>(initialHashtags);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('all');

  // ── Fetch helpers ──────────────────────────────────────────────────────────

  const fetchVideos = useCallback(() => {
    api
      .videos({
        page,
        limit,
        sort: sort as SortKey,
        dir: dir as SortDir,
        platform,
        query,
        ...tabParams(activeTab),
      })
      .then((d) => {
        setVideos(d.data);
        setTotal(d.meta.total);
      })
      .catch(console.error);
  }, [page, limit, sort, dir, platform, query, activeTab]);

  const fetchHashtags = useCallback(() => {
    api
      .hashtags(platform)
      .then((d) => setHashtags(d.data))
      .catch(console.error);
  }, [platform]);

  const skipVideos = useRef(true);
  const skipHashtags = useRef(true);

  useEffect(() => {
    if (skipVideos.current) { skipVideos.current = false; return; }
    fetchVideos();
  }, [fetchVideos]);

  useEffect(() => {
    if (skipHashtags.current) { skipHashtags.current = false; return; }
    fetchHashtags();
  }, [fetchHashtags]);

  // Switching tabs resets to page 1 and re-fetches.
  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    update({ page: 1 });
  };

  // ── Sort handler ───────────────────────────────────────────────────────────

  const handleSort = (key: string) => {
    update(
      sort === key
        ? { dir: dir === 'desc' ? 'asc' : 'desc', page: 1 }
        : { sort: key, dir: 'desc', page: 1 },
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      <Header
        query={query}
        platform={platform}
        onSearch={(q) => update({ query: q, page: 1 })}
        onRefresh={fetchVideos}
        onPlatformChange={(p) => update({ platform: p, page: 1 })}
      />

      <div className="flex gap-6 p-6 flex-1 overflow-hidden">
        <div id="main-scroll-area" className="flex-1 min-w-0 flex flex-col overflow-y-auto pr-2">
          <KPIStrip platform={platform} />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
            <EarlySniper videos={videos} onVideoClick={setSelectedVideo} />
            <HashtagSurge hashtags={hashtags} />
          </div>

          <div className="mb-6">
            {/* Filter tabs — each tab maps to specific snapshot_count + metric rules */}
            <div className="flex items-center gap-1 mb-3">
              {TABS.map((tab) => {
                const isActive = activeTab === tab.id;
                const accentClass =
                  tab.id === 'accelerating' ? (isActive ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/50' : 'text-emerald-600 hover:text-emerald-400 hover:bg-emerald-900/30') :
                    tab.id === 'declining' ? (isActive ? 'bg-rose-900/60 text-rose-300 border border-rose-700/50' : 'text-rose-600 hover:text-rose-400 hover:bg-rose-900/30') :
                      tab.id === 'new' ? (isActive ? 'bg-amber-900/60 text-amber-300 border border-amber-700/50' : 'text-amber-600 hover:text-amber-400 hover:bg-amber-900/30') :
                        (isActive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800');
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    title={tab.title}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${accentClass}`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <ViralTable
              videos={videos}
              total={total}
              page={page}
              limit={limit}
              platform={platform}
              activeTab={activeTab}
              onPageChange={(p) => update({ page: p })}
              onLimitChange={(l) => update({ limit: l, page: 1 })}
              onSortChange={handleSort}
              onPlatformChange={(p) => update({ platform: p, page: 1 })}
              onRowClick={setSelectedVideo}
            />
          </div>
        </div>
      </div>

      {selectedVideo && (
        <VideoDrawer
          video={selectedVideo}
          isOpen
          onClose={() => setSelectedVideo(null)}
        />
      )}
    </div>
  );
}
