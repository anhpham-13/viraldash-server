# YouTube Crawler — Worker Documentation

## Overview

The `crawler/youtube/` module is the YouTube Shorts data-collection pipeline. It discovers, deduplicates, enriches, and scores YouTube Shorts videos, then writes the results to the shared `data/youtube/` directory consumed by the backend API.

The pipeline operates in three independent flows, each targeting a different discovery strategy:

| Flow | Strategy | API Cost | Best Use Case |
|------|-----------|----------|---------------|
| **Flow 1** | Google SERP scraping | Low (Playwright, no YT quota) | Cold start / broad daily discovery |
| **Flow 2** | Hashtag-driven YT Search API | Medium (Search API quota) | Topical expansion after Flow 1 has data |
| **Flow 3** | Channel RSS feeds | Zero (no API calls) | Cheapest daily refresh from known channels |

All three flows converge on the same enrichment step: calling the YouTube Data API v3 in batches of 50 IDs, storing raw enriched records in `total_vids_yt.jsonl`, and re-scoring to produce `viral_vids_yt.jsonl`.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     DISCOVERY (per flow)                           │
│                                                                    │
│  Flow 1: google-shorts-scout  (Playwright + alphabet-matrix)       │
│  Flow 2: crawl_api_v3_shorts  (YT Search API v3 + hashtags)        │
│  Flow 3: process_ssr          (Channel RSS feeds)                  │
│                                        │                           │
│                           raw_google_output_yt.jsonl               │
└────────────────────────────────────────────────────────────────────┘
                                         │
                            filter-google-ids.ts
                             (deduplicate IDs)
                                         │
                            id_filter_yt.jsonl  (queue)
                                         │
                       process-id-filter-to-total.ts
                     (YT Data API v3  ·  batch 50 IDs)
                                         │
                    ┌────────────────────┴─────────────────────┐
                    │                                          │
              total_vids_yt.jsonl                    viral_vids_yt.jsonl
              (all enriched records)          (scored ≥ threshold, ≤ 24h)
```

---

## Directory Structure

```
crawler/youtube/
├── flow1-google-search.ts          Flow 1 orchestrator
├── flow2-hashtag-expand.ts         Flow 2 orchestrator
├── flow3-channel-expand.ts         Flow 3 orchestrator
│
├── google-shorts-scout.ts          Playwright stealth scraper (Flow 1 step 1)
├── crawl_api_v3_shorts.ts          YT Search API v3 (Flow 2 step 2)
├── extract_hashtags.ts             Hashtag miner (Flow 2 step 1)
├── process_ssr.ts                  Channel RSS scraper (Flow 3 step 1)
│
├── filter-google-ids.ts            Shared dedup step (all flows)
├── process-id-filter-to-total.ts   Shared enrichment + scoring step (all flows)
├── recalculate_viral.ts            Standalone re-scoring utility
│
├── google-worker.ts                BaseWorker subclass (used by index.ts)
├── google-flow-orchestrator.ts     Legacy all-in-one orchestrator
├── index.ts                        Main entry point (starts google-worker)
└── polyfills.ts                    Node.js globalThis.File polyfill for Playwright
```

---

## Environment Variables

Set these in `.env` at the **project root** before running any script.

| Variable | Required by | Default | Description |
|----------|------------|---------|-------------|
| `YOUTUBE_DATA_API_KEY` / `YT_DATA_API_KEY` | `process-id-filter-to-total`, `google-worker`, `google-flow-orchestrator` | — | YouTube Data API v3 key for video enrichment (`videos.list`) |
| `API_V3_1` | `crawl_api_v3_shorts` | — | Primary YT Data API v3 key for search (`search.list`) |
| `API_V3_2` | `crawl_api_v3_shorts` | — | Secondary key (round-robin rotation to extend quota) |
| `NOCAPTCHAAI_API_KEY` | `google-shorts-scout`, `google-worker` | — | API key for the noCaptcha AI browser extension |
| `MAX_VIDEO_AGE_DAYS` | `process-id-filter-to-total`, `recalculate_viral`, `google-flow-orchestrator` | `1` | Videos older than this many days are excluded from `viral_vids_yt.jsonl` |
| `VIRAL_SCORE_THRESHOLD` | `process-id-filter-to-total`, `recalculate_viral` | `98` | Minimum viral score (0–100) to be written to `viral_vids_yt.jsonl` |
| `ENRICHER_CONCURRENCY` | `google-worker` | `5` | Parallel detail-fetch workers inside `google-worker.ts` |
| `RUN_PIPELINE` | `index.ts` | — | Must be `"true"` to trigger `index.ts` main pipeline execution |

**noCaptcha AI extension config:** The API key is also stored in  
`crawler/extensions/nocaptchaai-extension/defaultConfig.json`. Update both.

---

## Data Files

All paths are relative to the **project root** (where `npm run` commands execute).

| File | Written by | Read by | Description |
|------|-----------|---------|-------------|
| `data/youtube/raw_google_output_yt.jsonl` | `google-shorts-scout`, `crawl_api_v3_shorts`, `process_ssr` | `filter-google-ids`, `google-flow-orchestrator` | Raw discovered IDs from current run. Overwritten each run. |
| `data/youtube/id_filter_yt.jsonl` | `filter-google-ids` | `process-id-filter-to-total` | Deduped queue of video IDs pending enrichment. Shrinks as batches are processed. |
| `data/youtube/total_vids_yt.jsonl` | `process-id-filter-to-total`, `google-flow-orchestrator` | `filter-google-ids`, `process_ssr`, `recalculate_viral` | Persistent store of all enriched video records. Append-only. |
| `data/youtube/viral_vids_yt.jsonl` | `process-id-filter-to-total`, `recalculate_viral` | Backend API | Filtered output: videos within age window and above score threshold, sorted by score desc. |
| `data/youtube/hashtag_yt.json` | `extract_hashtags` | `crawl_api_v3_shorts` | Top-80 hashtag leaderboard with composite scores. JSON array. |
| `data/youtube/idChannels_yt.jsonl` | `process_ssr` | `process_ssr` (internal) | Unique channel IDs extracted from `total_vids_yt.jsonl`. Rebuilt each Flow 3 run. |
| `data/user_data_worker_google/` | Playwright | `google-worker` | Persistent browser profile for the `GoogleWorker` Playwright context. |
| `data/user_data_worker_N/` | Playwright | `google-shorts-scout` | Per-worker browser profiles (`N` = 1..CONCURRENCY). Prevents cookie/cache conflicts between parallel workers. |
| `data/seen_index_ssr/` | `process_ssr` (via `seenIndex`) | `process_ssr` | File-backed sharded seen-ID index. Prevents writing duplicate IDs to `raw_google_output_yt.jsonl` across runs. |

---

## Component Reference

### `flow1-google-search.ts` — Flow 1 Orchestrator

**Purpose:** Runs the three-step Google discovery → dedup → enrich pipeline in sequence. The primary daily crawl when no prior data exists.

**Pipeline:**
```
google-shorts-scout → filter-google-ids → process-id-filter-to-total
```

**Prerequisites:**
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`
- `NOCAPTCHAAI_API_KEY` (configured in extension `defaultConfig.json`)
- Chrome/Chromium installed (used by Playwright)
- The noCaptcha AI extension directory at `crawler/extensions/nocaptchaai-extension/`

**Outputs:** `total_vids_yt.jsonl`, `viral_vids_yt.jsonl`

**Run:**
```bash
# From project root
npm run flow:google-search
# alias
npm run yt:search
```

---

### `flow2-hashtag-expand.ts` — Flow 2 Orchestrator

**Purpose:** Mines the top hashtags from existing viral videos, then queries the YouTube Search API using those hashtags as search terms to discover more videos in the same topical space.

**Pipeline:**
```
extract_hashtags → crawl_api_v3_shorts → filter-google-ids → process-id-filter-to-total
```

**Prerequisites:**
- `data/youtube/viral_vids_yt.jsonl` must exist (run Flow 1 or Flow 3 first)
- `API_V3_1` (and optionally `API_V3_2` for quota rotation)
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`

**Outputs:** `hashtag_yt.json`, `raw_google_output_yt.jsonl`, `total_vids_yt.jsonl`, `viral_vids_yt.jsonl`

**Run:**
```bash
npm run flow:hashtag-expand
# alias
npm run yt:hashtag
```

---

### `flow3-channel-expand.ts` — Flow 3 Orchestrator

**Purpose:** Extracts every channel ID already seen in `total_vids_yt.jsonl`, fetches each channel's YouTube RSS feed, and queues any Shorts published in the last 24 hours with ≥ 2,000 views. **Zero API quota consumed in discovery** — only `process-id-filter-to-total` uses the API.

**Pipeline:**
```
process_ssr → filter-google-ids → process-id-filter-to-total
```

**Prerequisites:**
- `data/youtube/total_vids_yt.jsonl` must exist (at least one prior Flow 1 or Flow 2 run)
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`

**Outputs:** `idChannels_yt.jsonl`, `raw_google_output_yt.jsonl`, `total_vids_yt.jsonl`, `viral_vids_yt.jsonl`

**Run:**
```bash
npm run flow:channel-expand
# alias
npm run yt:channel
```

---

### `google-shorts-scout.ts` — Playwright Stealth Scraper

**Purpose:** Generates a deterministic alphabet-matrix of Google search queries (e.g., `site:youtube.com/shorts/ "ab"`, `site:youtube.com/shorts/ intitle:"ac"` — ~2,000+ queries total) and scrapes Google SERPs for YouTube Shorts URLs using N parallel Playwright browser contexts.

**Key behaviour:**
- Each parallel worker gets its own persistent browser profile in `data/user_data_worker_N/` to isolate cookies and prevent context conflicts
- Queries are filtered to the **last 24 hours** (`tbs=qdr:d`) and 100 results per page
- CAPTCHAs are handled automatically by the noCaptcha AI extension (headless: false required)
- Results are written immediately to disk via `appendFileSync` — no in-memory buffer accumulation
- IDs already present in `total_vids_yt.jsonl` are pre-loaded and skipped

**Inputs:**
- `data/youtube/total_vids_yt.jsonl` (to build the pre-existing ID skip set)
- `CONCURRENCY` constant (default 5, edit in source)

**Outputs:** `data/youtube/raw_google_output_yt.jsonl` (overwritten fresh each run)

**Run standalone:**
```bash
npm run google-scout
```

**Run via Flow 1:**
```bash
npm run flow:google-search
```

---

### `crawl_api_v3_shorts.ts` — YouTube Search API v3 Crawler

**Purpose:** Uses the YouTube Data API v3 `search.list` endpoint to find Shorts by keyword. Reads top hashtags from the leaderboard, builds genre-aware query variants (gaming, sports, anime, food, animals, news…), and searches with `videoDuration=short`, `publishedAfter=24h ago`.

**Key behaviour:**
- Rotates between `API_V3_1` and `API_V3_2` keys round-robin per request to extend daily quota
- Generates query variants per base hashtag (e.g., `minecraft shorts`, `minecraft viral shorts`, `minecraft gameplay`)
- Shuffles the query pool, then caps it at `MAX_SEARCH_TERMS` (default 100)
- Paginates up to `MAX_PAGES_PER_QUERY` (default 2) result pages per query
- Adds `SLEEP_MS` (default 300 ms) between requests

**Inputs:**
- `data/youtube/hashtag_yt.json` (must exist — run `extract_hashtags` or Flow 2 step 1 first)
- `API_V3_1`, `API_V3_2` env vars

**Outputs:** `data/youtube/raw_google_output_yt.jsonl` (overwritten fresh each run)

**Run standalone:**
```bash
# Note: this script auto-executes on load — no named export needed
npx tsx crawler/youtube/crawl_api_v3_shorts.ts
```

---

### `extract_hashtags.ts` — Hashtag Miner

**Purpose:** Reads all records from `viral_vids_yt.jsonl`, aggregates per-tag statistics (view count, like count, comment count, occurrence count, viral score), computes a composite score, filters stop words and generic tags, applies similarity deduplication (≥ 80% word overlap), and writes the top 80 unique hashtags to `hashtag_yt.json`.

**Scoring formula:**
```
score = log10(totalViews+1)*35 + log10(totalLikes+1)*25 + log10(totalComments+1)*12
      + log10(count+1)*18 + avgLikeRate*100 + avgCommentRate*80 + avgViralScore*0.4
```

**Inputs:**
- `data/youtube/viral_vids_yt.jsonl`

**Outputs:** `data/youtube/hashtag_yt.json`

**Run standalone:**
```bash
npx tsx crawler/youtube/extract_hashtags.ts
```

---

### `filter-google-ids.ts` — ID Deduplicator

**Purpose:** Filters `raw_google_output_yt.jsonl` against two existing ID sets — the full historical store (`total_vids_yt.jsonl`) and the current pending queue (`id_filter_yt.jsonl`) — and writes only net-new unique IDs to the queue file.

**Key behaviour:**
- Preserves existing queue rows that have not yet been enriched (they remain in `id_filter_yt.jsonl`)
- Skips IDs already present in either the total store or the current queue
- Output is a clean, deduplicated list with `{ id, url }` shape

**Inputs:**
- `data/youtube/raw_google_output_yt.jsonl`
- `data/youtube/total_vids_yt.jsonl` (existence optional)
- `data/youtube/id_filter_yt.jsonl` (existence optional)

**Outputs:** `data/youtube/id_filter_yt.jsonl` (overwrites with cleaned + new IDs)

**Run standalone:**
```bash
npm run filter-id
```

---

### `process-id-filter-to-total.ts` — Enrichment & Viral Scoring

**Purpose:** The core enrichment step. Reads pending IDs from `id_filter_yt.jsonl`, calls the YouTube Data API v3 `videos.list` endpoint in batches of 50, writes enriched records to `total_vids_yt.jsonl` (append), removes processed IDs from the queue, then re-runs the viral scoring pass and overwrites `viral_vids_yt.jsonl`.

**Key behaviour:**
- Uses `snippet`, `statistics`, and `contentDetails` parts — thumbnails, titles, descriptions are stripped to keep file sizes small
- Removes each processed batch from `id_filter_yt.jsonl` immediately after a successful API response, so an interrupted run can be safely restarted
- Waits 1,200 ms between API batches to stay within rate limits
- Viral scoring uses `withViralMetrics()` from `crawler/src/core/viral.calc.ts`
- Only videos within `MAX_VIDEO_AGE_DAYS * 24` hours and with `viral_score ≥ VIRAL_SCORE_THRESHOLD` are written to `viral_vids_yt.jsonl`

**Inputs:**
- `data/youtube/id_filter_yt.jsonl`
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`
- `MAX_VIDEO_AGE_DAYS` (default 1)
- `VIRAL_SCORE_THRESHOLD` (default 98)

**Outputs:**
- `data/youtube/total_vids_yt.jsonl` (append)
- `data/youtube/viral_vids_yt.jsonl` (overwrite, sorted by score desc)

**Run standalone:**
```bash
npm run process-total
```

---

### `process_ssr.ts` — Channel RSS Feed Scraper

**Purpose:** Extracts unique channel IDs from `total_vids_yt.jsonl`, fetches the YouTube Atom RSS feed for each channel, parses the XML without a dependency, and appends Shorts published in the last 24 hours with ≥ 2,000 views to `raw_google_output_yt.jsonl`.

**Key behaviour:**
- Runs up to 5 concurrent channel workers (`WORKER_COUNT = 5`)
- Uses a file-backed sharded seen-ID index (`data/seen_index_ssr/`, 16 shards) to prevent duplicate IDs across runs — the index is built once and reused
- Retries each channel feed up to 3 times with exponential back-off (1,500 ms × attempt)
- Uses `media:statistics views` attribute from the RSS Atom feed to pre-filter low-view content before queuing
- No API quota consumed

**Inputs:**
- `data/youtube/total_vids_yt.jsonl` (channel IDs are extracted from `snippet.channelId`)
- `data/youtube/raw_google_output_yt.jsonl` (used to build the seen index)

**Outputs:**
- `data/youtube/idChannels_yt.jsonl` (unique channels discovered)
- `data/youtube/raw_google_output_yt.jsonl` (appends new video IDs)
- `data/seen_index_ssr/` (sharded dedup index, persists across runs)

**Run standalone:**
```bash
npm run process-ssr
```

---

### `recalculate_viral.ts` — Offline Re-scorer

**Purpose:** Re-runs the viral scoring formula against the existing `total_vids_yt.jsonl` without making any API calls. Useful when `VIRAL_SCORE_THRESHOLD` or `MAX_VIDEO_AGE_DAYS` is changed and you want to regenerate `viral_vids_yt.jsonl` immediately.

**Inputs:**
- `data/youtube/total_vids_yt.jsonl`
- `MAX_VIDEO_AGE_DAYS`
- `VIRAL_SCORE_THRESHOLD`

**Outputs:** `data/youtube/viral_vids_yt.jsonl` (overwrite)

**Run:**
```bash
npx tsx crawler/youtube/recalculate_viral.ts
```

---

### `google-worker.ts` — BaseWorker Subclass

**Purpose:** A class-based alternative to the standalone `google-shorts-scout.ts`. Extends `BaseWorker` from `crawler/src/core/base.worker.ts`. Implements `collect()` using a private `GoogleStealthScraper` (Playwright) to discover IDs, then enriches each with the YouTube Data API before returning the record set to `BaseWorker.run()`.

**Used by:** `index.ts`

**Key difference from `google-shorts-scout.ts`:** Uses a single persistent browser profile (`data/user_data_worker_google/`) rather than N parallel profiles. Discovery is keyword-list-driven (from `data/keywords.json` or defaults) rather than alphabet-matrix.

**Inputs:**
- `data/keywords.json` (optional — defaults to `["fyp", "trending", "viral"]`)
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`
- `NOCAPTCHAAI_API_KEY`
- `ENRICHER_CONCURRENCY` (default 5)

**Outputs:** Calls `appendJsonLine` from `crawler/src/core/jsonl.ts` — writes to `data/raw/youtube-shorts-google-1.jsonl`

---

### `index.ts` — Main Entry Point

**Purpose:** Starts the `GoogleWorker` pipeline. Validates that `YOUTUBE_DATA_API_KEY` is present and that `RUN_PIPELINE=true` before executing; otherwise prints a status summary and exits cleanly.

**Inputs:**
- `YOUTUBE_DATA_API_KEY` or `YT_DATA_API_KEY`
- `RUN_PIPELINE=true` (required to execute)
- `MAX_VIDEO_AGE_DAYS`, `VIRAL_SCORE_THRESHOLD`, `ENRICHER_CONCURRENCY`

**Run:**
```bash
# Dry-run (prints status, does nothing)
npm run yt:dev

# Execute the pipeline
RUN_PIPELINE=true npm run yt:dev
```

---

### `google-flow-orchestrator.ts` — Legacy Orchestrator

**Purpose:** An older all-in-one script that runs `google-shorts-scout` via `spawnSync`, deduplicates IDs in memory, calls the YouTube Data API in batches, and writes viral videos. Predates the modular flow architecture.

> **Note:** Prefer `flow1-google-search.ts` for new runs. This file is kept for reference and backward compatibility.

**Run:**
```bash
npm run google-flow
```

---

### `polyfills.ts` — Node.js Polyfills

**Purpose:** Patches `globalThis.File` with the `File` implementation from `node:buffer`. Required by Playwright in some Node.js versions where the Web `File` API is not available on `globalThis`.

Imported automatically by `index.ts` before any Playwright code runs.

---

## Execution Guide

### Prerequisites

```bash
# 1. Install dependencies (from project root)
npm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Configure environment
cp .env.example .env
# Then edit .env:
# YOUTUBE_DATA_API_KEY=AIza...
# API_V3_1=AIza...
# API_V3_2=AIza...           # optional, for quota rotation
# NOCAPTCHAAI_API_KEY=...
# MAX_VIDEO_AGE_DAYS=1       # optional, default 1
# VIRAL_SCORE_THRESHOLD=98   # optional, default 98

# 4. Configure noCaptcha AI extension
# Edit: crawler/extensions/nocaptchaai-extension/defaultConfig.json
# Set "apiKey" to your NOCAPTCHAAI_API_KEY value
```

### Recommended Daily Run Order

```bash
# Day 1 (cold start — no existing data)
npm run flow:google-search     # Discovers broad set via Google SERPs

# Day 2+ (incremental runs — all three flows)
npm run flow:google-search     # Broad discovery
npm run flow:hashtag-expand    # Topical expansion (requires prior viral_vids_yt.jsonl)
npm run flow:channel-expand    # Zero-quota channel refresh (requires prior total_vids_yt.jsonl)
```

### Running Individual Steps

```bash
# Discovery steps only
npm run google-scout           # Playwright scraper (produces raw_google_output_yt.jsonl)
npm run process-ssr            # Channel RSS scraper (produces raw_google_output_yt.jsonl)
npx tsx crawler/youtube/crawl_api_v3_shorts.ts   # YT Search API (requires hashtag_yt.json)

# Dedup + enrich (runs after any discovery step)
npm run filter-id              # Dedup → id_filter_yt.jsonl
npm run process-total          # Enrich + score → total_vids + viral_vids

# Utilities
npx tsx crawler/youtube/recalculate_viral.ts    # Re-score without API calls
npx tsx crawler/youtube/extract_hashtags.ts     # Rebuild hashtag_yt.json
```

### Force Re-score After Threshold Change

```bash
# Change VIRAL_SCORE_THRESHOLD in .env, then:
VIRAL_SCORE_THRESHOLD=90 npx tsx crawler/youtube/recalculate_viral.ts
```

---

## Error Handling & Logs

### CAPTCHA Detected

**Symptom:** Console prints `🚨 Gặp CAPTCHA! Đang chờ noCaptcha AI Extension...` and the browser pauses.

**Resolution:**
1. Verify `NOCAPTCHAAI_API_KEY` is set correctly in both `.env` and `defaultConfig.json`
2. The extension will attempt to auto-solve — allow up to 45 seconds
3. If it times out repeatedly, check your noCaptcha AI account balance
4. Reduce `CONCURRENCY` in `google-shorts-scout.ts` (more workers = higher CAPTCHA rate)

### YouTube API Quota Exhausted

**Symptom:** `process-id-filter-to-total` logs `YouTube API error: 403` or similar.

**Resolution:**
1. Add a second key as `API_V3_2` (for `crawl_api_v3_shorts`) or rotate `YOUTUBE_DATA_API_KEY`
2. Wait until quota resets at midnight Pacific Time
3. Run `flow:channel-expand` instead — it uses zero discovery quota
4. Reduce `MAX_SEARCH_TERMS` in `crawl_api_v3_shorts.ts` (default 100)

### Enrichment Interrupted Mid-Run

**Symptom:** Process killed partway through `process-id-filter-to-total`. Some IDs may remain in `id_filter_yt.jsonl`.

**Resolution:** Safe to re-run — processed batches are removed from `id_filter_yt.jsonl` immediately after each successful API call. Re-running picks up where it left off.

```bash
npm run process-total
```

### `raw_google_output_yt.jsonl` Is Empty

**Symptom:** `filter-google-ids` logs `Loaded raw rows: 0`.

**Cause:** The discovery step (scout / API search / SSR) found nothing or was not run.

**Resolution:**
```bash
# Verify the file exists and has content
wc -l data/youtube/raw_google_output_yt.jsonl

# Re-run the relevant discovery step
npm run google-scout    # or process-ssr / crawl_api_v3_shorts
```

### Seen-Index Out of Sync (`process_ssr`)

**Symptom:** `process_ssr` reports `Seen index exists at data/seen_index_ssr; skipping rebuild` but IDs seem to be missing.

**Resolution:** Delete the index to force a rebuild on the next run:
```bash
rm -rf data/seen_index_ssr/
npm run process-ssr
```

### Checking Logs

All scripts write structured logs to stdout with prefixed worker IDs:

```
[Worker 3] 🔍 Google Search: site:youtube.com/shorts/ "ab"
[process_ssr][worker 2] UCxxxxxx: appended 3 records
Batch 4/12 wrote 47 records to data/youtube/total_vids_yt.jsonl
Wrote 312 viral records to data/youtube/viral_vids_yt.jsonl
```

To persist logs to a file:
```bash
npm run flow:google-search 2>&1 | tee logs/flow1-$(date +%Y%m%d-%H%M%S).log
```
