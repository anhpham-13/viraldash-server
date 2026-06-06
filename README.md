# ViralScope — Monorepo

Three independent crawler pipelines write discovered videos into MongoDB; the backend reads from it and the frontend renders it.

```
crawl_short_video/
├── crawler/
│   ├── src/          ← shared crawler library (types, viral formula, I/O helpers, base classes)
│   ├── youtube/      ← YouTube Shorts pipeline (3 discovery flows)
│   ├── tiktok/       ← TikTok pipeline (2 discovery sources × 2 enrichment strategies)
│   ├── instagram/    ← Instagram Reels pipeline (4 phases)
│   └── scripts/      ← one-off data-migration utilities
├── shared/           ← TypeScript types + MongoDB repository (imported by backend)
├── backend/          ← Hono REST API (serves the frontend)
├── frontend/         ← Next.js 14 dashboard UI
└── data/             ← audit JSONL logs (never committed; written by crawlers for debugging)
    ├── youtube/
    ├── tiktok/
    └── instagram/
```

---

## Workspaces

| Workspace | Role |
|-----------|------|
| `crawler/` | Data collection — discovers video IDs, enriches with platform APIs, scores, writes to MongoDB |
| `shared/` | Canonical types (`VideoDocument`, `VideoSnapshot`) + MongoDB client + `upsertVideo` / `pushSnapshot` / `queryVideos` |
| `backend/` | Hono 4 REST API — queries MongoDB via `shared/`, returns paginated & filtered data |
| `frontend/` | Next.js 14 dashboard — reads from backend API, no direct DB access |

---

## Data Flow

```
┌──────────────────────────────────────────┐
│         Loop 1 — Discovery               │
│  YouTube / TikTok / Instagram crawlers   │
│  (Google SERP, platform APIs, RSS)       │
└───────────────┬──────────────────────────┘
                │ upsertVideo()
                ▼
        ┌───────────────┐     audit JSONL
        │   MongoDB     │ ←── (data/*/audit_*.jsonl)
        │  videos col.  │
        └───────┬───────┘
                │ pushSnapshot()
┌───────────────▼──────────────────────────┐
│         Loop 2 — Refresh                 │
│  meta-refresh-yt/tt/ig.ts                │
│  Re-fetch stats every REFRESH_INTERVAL   │
│  Appends VideoSnapshot → videos.snapshots│
└───────────────┬──────────────────────────┘
                │ queryVideos()
                ▼
        ┌───────────────┐
        │  Backend API  │  :4000
        │  /api/videos  │
        └───────┬───────┘
                │
        ┌───────▼───────┐
        │   Frontend    │  :3000
        │  Dashboard    │
        └───────────────┘
```

---

## MongoDB Document Model

Every video is stored as a single document with an append-only `snapshots[]` array.

```typescript
VideoDocument {
  video_id, platform, url, published_at, author, hashtags, sound?
  first_seen_at, last_refreshed_at, snapshot_count
  view_count, likes, comments, shares, saves   // mirror of latest snapshot
  engagement_score, viral_score                // pre-computed on last refresh
  viral_acceleration: number | null            // null until snapshot_count ≥ 3
  snapshots: VideoSnapshot[]                   // append-only history
}

VideoSnapshot {
  ts, view_count, likes, comments, shares, saves
  delta_views, delta_hours
  rolling_velocity   // delta_views / delta_hours  (0 on first snapshot)
  engagement_score, viral_score
}
```

**Velocity rules:**
- `viral_velocity` displayed in the API = `snapshots[-1].rolling_velocity` (real incremental speed between last two refreshes). Falls back to `view_count / age_at_crawl` for the first snapshot.
- `viral_acceleration` = `vNow − vPrev`. Requires `prevSnap.delta_hours > 0`, meaning it's `null` until the **3rd snapshot**.

---

## `crawler/src/` — Shared crawler library

| File | Purpose |
|------|---------|
| `core/viral-calc.ts` | Two-phase scoring: seed (age ≤ 2h) → score 1–20; viral (age > 2h) → platform gate → score 21–100 |
| `core/base-worker.ts` | Abstract `BaseWorker` collect/run pattern |
| `core/meta-refresh-base.ts` | Base class for refresh loops (calls `pushSnapshot`) |
| `core/seen-index.ts` | File-backed sharded dedup index |
| `core/jsonl.ts` | JSONL read / write / append helpers |
| `core/types.ts` | Shared crawler TypeScript interfaces |
| `config/env.ts` | Environment variable loader |

> **Backwards-compat shims:** `base.worker.ts`, `viral.calc.ts`, `seenIndex.ts` re-export from the renamed files above. Do not remove them.

---

## `crawler/youtube/` — YouTube pipeline

Three independent discovery flows, all converging on the same enrichment + MongoDB write step.

| Script | npm run | Role |
|--------|---------|------|
| `flow1-google-search.ts` | `yt:search` | **Primary daily run** — Google SERP scraping → dedup → enrich |
| `flow2-hashtag-expand.ts` | `yt:hashtag` | Hashtag-driven YT Search API expansion |
| `flow3-channel-expand.ts` | `yt:channel` | Channel RSS feeds (zero API quota) |
| `google-shorts-scout.ts` | `google-scout` | Standalone Playwright alphabet-matrix scraper |
| `filter-google-ids.ts` | `filter-id` | Deduplication step (shared by all flows) |
| `process-id-filter-to-total.ts` | `process-total` | YT Data API v3 enrichment → `upsertVideo()` → MongoDB |
| `process_ssr.ts` | `process-ssr` | Channel RSS feed scraper (Flow 3 step 1) |
| `extract_hashtags.ts` | _(standalone)_ | Mine top hashtags from viral videos |
| `recalculate_viral.ts` | _(standalone)_ | Re-score existing data without API calls |
| `meta-refresh-yt.ts` | `yt:refresh` | **Refresh loop** — re-fetches stats, calls `pushSnapshot()` |
| `google-flow-orchestrator.ts` | `google-flow` | Legacy all-in-one; prefer `yt:search` |

See [`crawler/youtube/workers-README.md`](crawler/youtube/workers-README.md) for detailed component docs.

---

## `crawler/tiktok/` — TikTok pipeline

| Script | npm run | Role |
|--------|---------|------|
| `google.worker.ts` | `tiktok:google` | Discovery via Serper API (no browser) |
| `gg-advanced-search-scraper.ts` | _(standalone)_ | Playwright Google scraper |
| `filter-google-ids-tt.ts` | `tiktok:filter-id` | Deduplication |
| `process-id-filter-to-total-tt.ts` | `tiktok:process-total` | Playwright enrichment → `upsertVideo()` |
| `rapid.worker.ts` | `tiktok:rapid` | RapidAPI enrichment alternative |
| `meta-refresh-tt.ts` | `tt:refresh` | **Refresh loop** — calls `pushSnapshot()` |
| `aggregator.ts` | `tiktok:aggregate` | _(experimental pipeline 2)_ Re-score utility |
| `normalize.ts` | `tiktok:normalize` | _(experimental)_ Cross-source normaliser |
| `index.ts` | `tiktok:all` | _(experimental)_ End-to-end orchestrator, NOT production |

See [`crawler/tiktok/worker-README.md`](crawler/tiktok/worker-README.md) for full docs.

---

## `crawler/instagram/` — Instagram pipeline (4 phases)

```
Phase 0  Auth        get_instagram_cookie.ts  — capture live session cookie
Phase 1  Discovery   gg-advanced-search-scraper.ts  (Playwright, no API key)
                     serper-search.ts          (Serper API)
Phase 2  Filter      filter-google-ids-ig.ts   — deduplication
Phase 3  Enrichment  crawl_instagram_via_private_api.ts  (native fetch, fastest)
                     detail-playwright.ts       (5 parallel workers, most reliable)
                     rapid-instagram.ts         (RapidAPI, no cookie)
Phase 4  Analysis    extract_hashtags.ts        — hashtag scoring
```

Active refresh: `ig:refresh` → `meta-refresh-ig.ts` → `pushSnapshot()`

See [`crawler/instagram/README.md`](crawler/instagram/README.md) for full docs.

---

## `crawler/scripts/` — Migration utilities

| Script | npm run | Purpose |
|--------|---------|---------|
| `migrate-jsonl-to-mongo.ts` | `migrate:dry` / `migrate:apply` | Import audit JSONL files into MongoDB |
| `fix-accel-snapshot2.ts` | `fix-accel:dry` / `fix-accel` | Reset `viral_acceleration = null` for docs with `snapshot_count ≤ 2` |

---

## Setup

```bash
# 1. Install all workspace dependencies
npm install

# 2. Install Playwright browsers (one-time, needed for browser-based crawlers)
npx playwright install chromium

# 3. Configure environment
cp .env.example .env
# Required minimum:
#   MONGODB_URI=mongodb://localhost:27017
#   MONGODB_DB=viralscope
#   YOUTUBE_DATA_API_KEY=...   (for YouTube crawlers)
#   RAPID_API_HOST / RAPID_API_KEYS  (for TikTok RapidAPI)
#   SERPER_API_KEYS=...        (for Instagram/TikTok Serper discovery)
```

---

## Running

### YouTube

```bash
npm run yt:search       # Flow 1 — Google SERP → enrich → MongoDB (primary daily run)
npm run yt:hashtag      # Flow 2 — hashtag expansion (requires prior data)
npm run yt:channel      # Flow 3 — channel RSS (zero API quota)
npm run yt:refresh      # Refresh loop — re-fetch stats, push snapshots
```

### TikTok

```bash
npm run tiktok:google         # Discovery via Serper API
npm run tiktok:filter-id      # Dedup
npm run tiktok:process-total  # Enrich via Playwright → MongoDB
# or:
npm run tiktok:rapid          # Enrich via RapidAPI → MongoDB
npm run tt:refresh            # Refresh loop
```

### Instagram

```bash
npm run ig:cookie      # Phase 0 — capture session cookie (run once or on expiry)
npm run ig:search      # Phase 1 — discovery (Playwright, no API key)
npm run ig:filter      # Phase 2 — dedup
npm run ig:detail      # Phase 3 — enrich (Playwright, 5 workers)
npm run ig:hashtags    # Phase 4 — score hashtags
npm run ig:refresh     # Refresh loop
```

### Refresh all platforms

```bash
npm run refresh:all    # yt:refresh → tt:refresh → ig:refresh (sequential)
```

---

## Backend

Hono REST API — reads from MongoDB via `shared/db/`.

```bash
# from project root:
npm run backend:dev    # tsx watch  →  http://localhost:4000
npm run backend:build  # tsc → dist/
npm run backend:start  # node dist/backend/src/index.js
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/videos` | Paginated, filtered, sorted video list |
| GET | `/api/videos/:videoId/snapshots?platform=` | Snapshot history for a single video |
| GET | `/api/hashtags` | Hashtag leaderboard |
| GET | `/api/stats` | Aggregated KPIs (+ `lastRefreshByPlatform`) |
| GET | `/api/alerts` | Hockey-stick, resurgence, pipeline health |
| GET | `/health` | Liveness probe |

### `/api/videos` query params

| Param | Type | Description |
|-------|------|-------------|
| `platform` | `YouTube_Shorts` \| `TikTok` \| `Instagram_Reels` \| `all` | Platform filter |
| `status` | `Emerging` \| `Trending` \| `Viral` \| `Declining` \| `all` | Status filter |
| `sort` | `viral_score` \| `viral_velocity` \| `view_count` \| `engagement_score` \| `viral_acceleration` \| `age_hours` \| `last_refreshed_at` \| `snapshot_count` | Sort field (default: `viral_score`) |
| `dir` | `asc` \| `desc` | Sort direction (default: `desc`) |
| `page` / `limit` | number | Pagination (max limit: 200) |
| `minScore` / `maxScore` | number | Viral score range |
| `minViews` / `maxViews` | number | View count range |
| `minVelocity` / `maxVelocity` | number | Velocity range (views/hour) |
| `minAge` / `maxAge` | number | Age range in hours |
| `minSnapshots` / `maxSnapshots` | number | Snapshot count range |
| `isNew` | number | First seen within N hours |
| `query` | string | Text search (title, author, hashtags) |

---

## Frontend

Next.js 14 dashboard.

```bash
# from project root:
npm run frontend:dev    # http://localhost:3000
npm run frontend:build
npm run frontend:start
```

Set API URL in `frontend/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| `KPIStrip` | `dashboard/KPIStrip.tsx` | Top KPI cards including viral thresholds, counts, and **last refresh time per platform** |
| `ViralTable` | `dashboard/ViralTable.tsx` | Sortable/filterable video table |
| `VideoDrawer` | `dashboard/VideoDrawer.tsx` | Detail panel with core metrics, **snapshot timeline**, tags |
| `AlertFeed` | `dashboard/AlertFeed.tsx` | Hockey-stick and resurgence alerts |
| `DashboardClient` | `dashboard/DashboardClient.tsx` | Client-side data container |

---

## Running Everything Locally

```bash
# Terminal 1 — crawl to populate MongoDB
npm run yt:search

# Terminal 2 — backend API
npm run backend:dev

# Terminal 3 — frontend
npm run frontend:dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## TypeScript

```bash
npm run check                 # root tsconfig (shared + crawler types)
npm run backend:typecheck     # backend only
```
