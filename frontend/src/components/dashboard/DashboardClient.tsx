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
import type { Video, Hashtag, SortKey, SortDir } from '@/lib/api-client';

// VideoDrawer is only needed after a row click — keep it out of the initial bundle.
const VideoDrawer = dynamic(
  () => import('@/components/dashboard/VideoDrawer').then((m) => m.VideoDrawer),
  { ssr: false },
);

interface Props {
  initialVideos:   Video[];
  initialTotal:    number;
  initialHashtags: Hashtag[];
}

export function DashboardClient({ initialVideos, initialTotal, initialHashtags }: Props) {
  const { platform, page, limit, sort, dir, query, update } = useTableState();

  // Seed from SSR data — no loading flash on first paint.
  const [videos, setVideos]         = useState<Video[]>(initialVideos);
  const [total, setTotal]           = useState<number>(initialTotal);
  const [hashtags, setHashtags]     = useState<Hashtag[]>(initialHashtags);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);

  // ── Fetch helpers ──────────────────────────────────────────────────────────

  const fetchVideos = useCallback(() => {
    api
      .videos({
        page,
        limit,
        sort:     sort as SortKey,
        dir:      dir  as SortDir,
        platform,
        query,
      })
      .then((d) => {
        setVideos(d.data);
        setTotal(d.meta.total);
      })
      .catch(console.error);
  }, [page, limit, sort, dir, platform, query]);

  const fetchHashtags = useCallback(() => {
    api
      .hashtags(platform)
      .then((d) => setHashtags(d.data))
      .catch(console.error);
  }, [platform]);

  // Skip the very first effect run: SSR already fetched this data.
  // Subsequent URL changes produce a new callback identity → re-fetch.
  const skipVideos   = useRef(true);
  const skipHashtags = useRef(true);

  useEffect(() => {
    if (skipVideos.current) { skipVideos.current = false; return; }
    fetchVideos();
  }, [fetchVideos]);

  useEffect(() => {
    if (skipHashtags.current) { skipHashtags.current = false; return; }
    fetchHashtags();
  }, [fetchHashtags]);

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
            <ViralTable
              videos={videos}
              total={total}
              page={page}
              limit={limit}
              platform={platform}
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
