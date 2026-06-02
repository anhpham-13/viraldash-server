# ViralScope — Monorepo

Three independent sub-projects share a single `data/` directory: the crawler writes to it, the backend reads from it.

```
crawl_short_video/
├── crawler/
│   ├── src/          ← shared library (types, viral formula, I/O utils, base worker)
│   ├── youtube/      ← YouTube Shorts crawl pipeline
│   ├── tiktok/       ← TikTok crawl pipeline
│   ├── scripts/      ← one-off data-migration utilities
│   └── extensions/   ← browser extension loaded by Playwright
├── backend/          ← Hono REST API (serves the frontend)
├── frontend/         ← Next.js dashboard UI
└── data/             ← shared JSONL output (never committed)
    ├── youtube/
    └── tiktok/
```

---

## `crawler/src/` — Shared library

Both the YouTube and TikTok pipelines import from here. **No platform-specific code lives here.**

| File | Purpose |
|------|---------|
| `core/types.ts` | Shared TypeScript interfaces |
| `core/viral.calc.ts` | Viral score / engagement / velocity formulae |
| `core/jsonl.ts` | JSONL read / write / append helpers |
| `core/seenIndex.ts` | File-backed deduplication index |
| `core/stream-dedup.ts` | Streaming deduplication pipeline |
| `core/base.worker.ts` | Abstract base class for scrape workers |
| `config/env.ts` | Shared environment variable loader |

---

## `crawler/youtube/` — YouTube pipeline

Mirrors the `tiktok/` folder structure. All scripts run via `tsx` from the project root.

| File | Role |
|------|------|
| `index.ts` | Main entry — starts the Google Playwright worker |
| `google-worker.ts` | `BaseWorker` subclass: Google Stealth Scraper + YT Data API enrichment |
| `polyfills.ts` | Node.js polyfills (File API) required by Playwright |
| `flow1-google-search.ts` | **Flow 1** — Google search → id list → enrich → `viral_vids_yt.jsonl` |
| `flow2-hashtag-expand.ts` | **Flow 2** — Mine hashtags from existing viral videos → crawl by hashtag |
| `flow3-channel-expand.ts` | **Flow 3** — Expand via channel RSS feeds (SSR) |
| `google-shorts-scout.ts` | Playwright stealth scraper (alphabet-matrix Google queries) |
| `google-flow-orchestrator.ts` | Orchestrate search + scoring in one pass |
| `crawl_api_v3_shorts.ts` | YouTube Data API v3 search by hashtag |
| `extract_hashtags.ts` | Mine top hashtags from existing viral video records |
| `filter-google-ids.ts` | Deduplicate raw IDs → `id_filter_yt.jsonl` |
| `process-id-filter-to-total.ts` | Enrich IDs with YT Data API → `total_vids_yt.jsonl` + `viral_vids_yt.jsonl` |
| `process_ssr.ts` | Fetch channel RSS feeds, extract recent Shorts IDs |
| `recalculate_viral.ts` | Recompute viral scores on existing data without re-crawling |

---

## `crawler/tiktok/` — TikTok pipeline

| File | Role |
|------|------|
| `index.ts` | Run all TikTok steps in sequence |
| `rapid.worker.ts` | Fetch TikTok video data via RapidAPI |
| `google.worker.ts` | Discover TikTok video IDs via Google search |
| `filter-google-ids-tt.ts` | Deduplicate raw IDs → `id_filter_tt.jsonl` |
| `process-id-filter-to-total-tt.ts` | Enrich IDs with Playwright → `total_vids_tt.jsonl` |
| `normalize.ts` | Normalise field names across API sources |
| `aggregator.ts` | Compute viral scores + hashtag leaderboard |
| `config/env.ts` | TikTok-specific env vars (RAPIDAPI_KEY, etc.) |
| `workers/source.types.ts` | Raw API response types |

---

## Running the crawlers

### Setup

```bash
# from project root
cp .env.example .env
# fill in: YOUTUBE_DATA_API_KEY, API_V3_1, API_V3_2, RAPIDAPI_KEY, NOCAPTCHAAI_API_KEY
npm install
```

### YouTube

```bash
# Flow 1 — Google search → score → viral_vids_yt.jsonl  (primary daily run)
npm run flow:google-search
# alias: npm run yt:search

# Flow 2 — Hashtag-driven crawl (run after Flow 1 has data)
npm run flow:hashtag-expand
# alias: npm run yt:hashtag

# Flow 3 — Channel RSS expansion
npm run flow:channel-expand
# alias: npm run yt:channel

# Individual steps
npm run google-scout     # Playwright Google scraper only
npm run google-flow      # Google search + scoring in one pass
npm run process-ssr      # Channel RSS feed scraper
npm run filter-id        # Deduplicate raw IDs
npm run process-total    # Enrich IDs via YouTube Data API

# Shared-lib type check
npm run check
```

### TikTok

```bash
npm run tiktok:all           # Run all TikTok steps in sequence

# Individual steps
npm run tiktok:rapid         # RapidAPI fetch
npm run tiktok:google        # Google-search discovery
npm run tiktok:filter-id     # Deduplicate IDs
npm run tiktok:process-total # Playwright enrichment
npm run tiktok:normalize     # Normalise field names
npm run tiktok:aggregate     # Compute viral scores + hashtag leaderboard
```

---

## Backend

Hono REST API. Reads from `data/` via a 2-minute in-memory cache.

```bash
cd backend
cp .env.example .env
# ALLOWED_ORIGINS=http://localhost:3000
# DATA_DIR=../data     (relative to backend/, default)
# PORT=4000
npm install
npm run dev      # tsx watch
npm run build    # tsc → dist/
npm start        # node dist/index.js
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/videos` | Paginated, filtered, sorted video list |
| GET | `/api/hashtags` | Hashtag leaderboard |
| GET | `/api/stats` | Aggregated KPI metrics |
| GET | `/api/alerts` | Hockey-stick, resurgence, pipeline health |
| GET | `/health` | Liveness probe |
| POST | `/cache/reload` | Force-refresh in-memory cache |

---

## Frontend

Next.js 15 dashboard. All data via `src/lib/api-client.ts` — no filesystem access.

```bash
cd frontend
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > .env.local
npm install
npm run dev    # :3000
npm run build
npm start
```

---

## Running everything locally

```bash
# Terminal 1 — run a YouTube crawl flow to populate data/
npm run flow:google-search

# Terminal 2 — backend API
cd backend && npm run dev

# Terminal 3 — frontend dashboard
cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).
