// Server Component — no "use client".
// Reads URL search params, SSR-fetches initial data from the Hono backend,
// then hands off to DashboardClient for all interactive state management.
import { Suspense } from 'react';
import { DashboardClient } from '@/components/dashboard/DashboardClient';
import { api } from '@/lib/api-client';
import type { SortKey, SortDir } from '@/lib/api-client';

type RawSP = Record<string, string | string[] | undefined>;

// Next.js 15: searchParams is a Promise.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<RawSP>;
}) {
  const sp = await searchParams;

  const platform = String(sp['platform'] ?? 'all');
  const page     = Math.max(1, Number(sp['page']  ?? 1));
  const limit    = Math.max(1, Number(sp['limit'] ?? 25));
  const sort     = String(sp['sort']  ?? 'viral_score') as SortKey;
  const dir      = String(sp['dir']   ?? 'desc')        as SortDir;
  const query    = String(sp['query'] ?? '');

  const [videosData, hashtagsData] = await Promise.all([
    api
      .videos({ page, limit, sort, dir, platform, query })
      .catch(() => ({ data: [], meta: { total: 0, page: 1, limit, totalPages: 0 } })),
    api
      .hashtags(platform)
      .catch(() => ({ data: [] })),
  ]);

  return (
    // Suspense is required because DashboardClient calls useSearchParams().
    <Suspense fallback={null}>
      <DashboardClient
        initialVideos={videosData.data}
        initialTotal={videosData.meta.total}
        initialHashtags={hashtagsData.data}
      />
    </Suspense>
  );
}
