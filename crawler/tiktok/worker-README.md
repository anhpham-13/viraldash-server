# TikTok Crawler — Worker Documentation

## Overview

The `crawler/tiktok/` module is the TikTok data-collection layer. It discovers TikTok video IDs from two independent sources, enriches each video with full engagement metrics, applies the shared viral scoring formula, and writes production data to `data/tiktok/` for consumption by the backend API.

The architecture is split into **two independent pipelines** that run in parallel and write to separate output trees. Only Pipeline 1 feeds the live backend.

---

## Architecture

### Pipeline 1 — Serper + Playwright *(production, feeds backend API)*

```
google.worker  ──[Serper API + Google Video Search]──▶  data/tiktok/raw_google_output_tt.jsonl
                                                                   │
                                              filter-google-ids-tt  (dedup against total + queue)
                                                                   │
                                                    data/tiktok/id_filter_tt.jsonl
                                                                   │
                                 process-id-filter-to-total-tt  (Playwright page scrape)
                                                    │                          │
                              data/tiktok/total_vids_tt.jsonl    data/tiktok/viral_vids_tt.jsonl
                                                                         ▲
                                                               ┌──────────┘
                                                        Backend API reads here
```

### Pipeline 2 — RapidAPI *(experimental, output_json/)*

```
rapid.worker  ──[RapidAPI trending endpoints]──▶  output_json/tiktok_rapid_raw.jsonl
                                                             │
                                            normalize  (cross-source parser + dedup)
                                                             │
                                             output_json/tiktok_candidates.jsonl
                                                             │
                                             aggregator  (viral scoring)
                                                             │
                                              output_json/tiktok_viral_tt.jsonl
```

> **Note:** `index.ts` orchestrates all four stages (RapidWorker → GoogleWorker → Normalize → Aggregator) as a combined experimental run. For production data collection that feeds the dashboard, run **Pipeline 1 steps individually** using the npm scripts documented below.

---

## Directory Structure

```
crawler/tiktok/
├── index.ts                           Full pipeline orchestrator (experimental)
├── config/
│   └── env.ts                         TikTok-specific environment variable loader
├── workers/
│   └── source.types.ts                IWorkerCollector<T> interface (future extension point)
│
│── Pipeline 1 (production)
├── google.worker.ts                   Serper API Google search → TikTok video seeds
├── filter-google-ids-tt.ts            Deduplicates raw seeds → pending enrichment queue
├── process-id-filter-to-total-tt.ts   Playwright enrichment + viral scoring
│
│── Pipeline 2 (experimental / RapidAPI)
├── rapid.worker.ts                    RapidAPI trending feed fetcher
├── normalize.ts                       Cross-source payload normalizer
└── aggregator.ts                      Viral score filter and final output writer
```

---

## Environment Variables

Set all variables in `.env` at the **project root**.

### Pipeline 1 — Serper + Playwright

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERPER_API_KEYS` | Yes | — | Comma-separated Serper.dev API keys. Rotated round-robin per request. |
| `SERPER_API_KEY` | Fallback | — | Single Serper key (used if `SERPER_API_KEYS` is not set). |
| `CRAWL_REGION` | No | `us` | ISO country code passed to Serper `gl` param. |
| `CRAWL_LANG` | No | `en` | Language code passed to Serper `hl` param. |
| `SERPER_NUM` | No | `100` | Results per page from Serper. |
| `SERPER_MAX_PAGES` | No | `2` | Pages fetched per query. |
| `SERPER_DELAY_MS` | No | `500` | Millisecond delay between Serper API calls. |
| `ENRICHER_CONCURRENCY` | No | `5` | Number of parallel Playwright browser workers for video enrichment. |
| `MAX_VIDEO_AGE_DAYS` | No | `1` | Videos older than this are excluded from `viral_vids_tt.jsonl`. |
| `VIRAL_SCORE_THRESHOLD` | No | `98` | Minimum viral score (0–100) to write to `viral_vids_tt.jsonl`. |

### Pipeline 2 — RapidAPI

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RAPID_API_HOST` | Yes | — | RapidAPI endpoint host (e.g. `tiktok-scraper7.p.rapidapi.com`). |
| `RAPID_API_KEYS` | Yes | — | Comma-separated RapidAPI keys. One key = one `RapidApiConfig` entry. |
| `CRAWL_REGIONS` | No | `US` | Comma-separated ISO region codes to crawl (e.g. `US,GB,AU`). |
| `RAPID_MAX_REQUESTS` | No | `150` | Hard cap on total API requests across all regions per run. |
| `RAPID_DELAY_MS` | No | `1500` | Milliseconds to wait between each RapidAPI request. |
| `VIRAL_SCORE_THRESHOLD` | No | `90` | Minimum viral score for aggregator output (TikTok uses 90, not 98). |
| `MAX_BROWSER_CONCURRENCY` | No | `3` | Loaded by `config/env.ts` — available for future Playwright pooling. |

---

## Data Files

All paths are relative to the **project root**.

### Pipeline 1 (production)

| File | Written by | Read by | Description |
|------|-----------|---------|-------------|
| `data/tiktok/raw_google_output_tt.jsonl` | `google.worker` | `filter-google-ids-tt` | Raw TikTok video seeds: `{ id, url, fetchedAt }`. Overwritten each run. |
| `data/tiktok/id_filter_tt.jsonl` | `filter-google-ids-tt` | `process-id-filter-to-total-tt` | Deduped pending enrichment queue: `{ id, url, author }`. Shrinks as videos are processed. |
| `data/tiktok/total_vids_tt.jsonl` | `process-id-filter-to-total-tt` | `filter-google-ids-tt`, backend | Append-only store of all Playwright-enriched TikTok records. |
| `data/tiktok/viral_vids_tt.jsonl` | `process-id-filter-to-total-tt` | **Backend API** | Filtered viral videos — append-only, written per enriched video that passes threshold. |

### Pipeline 2 (experimental)

| File | Written by | Read by | Description |
|------|-----------|---------|-------------|
| `output_json/tiktok_rapid_raw.jsonl` | `rapid.worker` | `normalize` | Raw RapidAPI response envelopes: `{ host, region, endpoint, fetchedAt, payload }`. Overwritten per run. |
| `output_json/tiktok_google_raw.jsonl` | *(google.worker legacy)* | `normalize` | Raw Google seed records for the experimental pipeline. |
| `output_json/tiktok_candidates.jsonl` | `normalize` | `aggregator` | Normalized `IVideoRecordCandidate` records, cross-source deduplicated. |
| `output_json/tiktok_viral_tt.jsonl` | `aggregator` | — | Final viral output from the RapidAPI pipeline. Not consumed by the backend API. |

---

## Component Reference

### `google.worker.ts` — Serper API Discovery

**Technical approach:** REST API (Serper.dev — Google Video Search proxy). No browser automation. Pure HTTPS calls using Node.js `node:https`.

**Purpose:** Builds a large, intent-diversified query pool and searches Google's video index for TikTok URLs published in the last 24 hours. Extracts and deduplicates canonical TikTok video seeds.

**Query strategy:** Combines 8 intent phrases × (6 freshness signals + 30 categories + 14 US geo signals + 26 alphabet chars + 6 numbers) plus 11 hashtag variants × 4 templates, producing **thousands of unique queries** that saturate the Google video index across topics, locales, and temporal signals. All queries include `tbs=qdr:d` (last 24 hours filter).

**ID extraction:** `VIDEO_URL_RE` = `tiktok.com/@(author)/video/(id)` — only canonical video URLs are accepted; profile pages and music URLs are discarded.

**Key behaviour:**
- Rotates through `SERPER_API_KEYS` round-robin (one key consumed per page)
- Deduplicates IDs in-memory via a `Set<string>` before writing
- Appends results immediately to disk — safe to interrupt and restart
- Output is overwritten fresh each run (`fs.writeFileSync(OUTPUT_FILE, "")` at start)

**Inputs:**
- `SERPER_API_KEYS` (required)
- `CRAWL_REGION`, `CRAWL_LANG`, `SERPER_NUM`, `SERPER_MAX_PAGES`, `SERPER_DELAY_MS`

**Outputs:** `data/tiktok/raw_google_output_tt.jsonl` — records shaped as `{ id, url, fetchedAt }`

**Run:**
```bash
npm run tiktok:google
```

---

### `filter-google-ids-tt.ts` — ID Deduplicator

**Technical approach:** File I/O only. No network calls.

**Purpose:** Filters raw seeds against two existing ID sets — `total_vids_tt.jsonl` (already enriched) and `id_filter_tt.jsonl` (already queued) — and produces a clean pending-enrichment queue.

**Key behaviour:**
- Checks `row?.data?.id ?? row?.id` to handle both wrapped (`{ data: { id } }`) and flat (`{ id }`) input shapes
- Preserves queue rows that exist in `id_filter_tt.jsonl` but not yet in `total_vids_tt.jsonl` (prevents losing the queue on re-run)
- Output shape: `{ id, url, author }` — `author` is required by the Playwright enricher to construct the video URL

**Inputs:**
- `data/tiktok/raw_google_output_tt.jsonl`
- `data/tiktok/total_vids_tt.jsonl` (existence optional)
- `data/tiktok/id_filter_tt.jsonl` (existence optional)

**Outputs:** `data/tiktok/id_filter_tt.jsonl` (overwritten with merged deduplicated queue)

**Run:**
```bash
npm run tiktok:filter-id
```

---

### `process-id-filter-to-total-tt.ts` — Playwright Video Enricher

**Technical approach:** Headless Chromium browser automation via `playwright-extra` + `puppeteer-extra-plugin-stealth`. Dual-strategy data extraction:
1. **Network interception (primary):** Registers a `page.on("response")` listener that captures TikTok's internal `/api/item/detail` and `/api/video/detail` XHR responses. These return the full `itemStruct` JSON — the most reliable, schema-stable data source.
2. **DOM scraping (fallback):** If no network intercept fires, parses the hydration blobs in `#__NEXT_DATA__` and `#__UNIVERSAL_DATA_FOR_REHYDRATION__` script tags which embed the full item data as serialized JSON within the initial HTML.

**Purpose:** For each video ID in the queue, opens the TikTok video page in a dedicated browser context, captures real-time engagement metrics (`diggCount`, `playCount`, `commentCount`, `shareCount`, `collectCount`), extracts `createTime`, `music`, `challenges` (hashtags), and immediately writes the enriched record and its viral score to the output files.

**Concurrency model:** Spawns `ENRICHER_CONCURRENCY` (default 5) async workers sharing a single ordered queue via a shared `index` counter. Each worker owns its full browser lifecycle (launch → context → page → close) — no shared browser state.

**Key behaviour:**
- Each browser context is configured with stealth plugin + a realistic Windows Chrome user agent + `en-US` locale
- `--disable-blink-features=AutomationControlled` suppresses the most common automation detection flag
- Retries each video **once** after a 2-second pause on failure
- Adds a randomized human delay (`1,000–3,000 ms`) between requests per worker
- Writes directly to `total_vids_tt.jsonl` and `viral_vids_tt.jsonl` via `appendFileSync` — **does NOT require a prior dedup pass**; new records are simply appended
- Viral scoring and age filtering happen inline: a record is written to `viral_vids_tt.jsonl` only if `age_hours ≤ MAX_VIDEO_AGE_DAYS * 24` AND `viral_score ≥ VIRAL_SCORE_THRESHOLD`
- Does **not** clean up `id_filter_tt.jsonl` after processing — re-runs will skip already-enriched IDs via `filter-google-ids-tt`

**Inputs:**
- `data/tiktok/id_filter_tt.jsonl`
- `ENRICHER_CONCURRENCY`, `MAX_VIDEO_AGE_DAYS`, `VIRAL_SCORE_THRESHOLD`

**Outputs:**
- `data/tiktok/total_vids_tt.jsonl` (append)
- `data/tiktok/viral_vids_tt.jsonl` (append, directly consumed by backend API)

**Run:**
```bash
npm run tiktok:process-total
```

---

### `rapid.worker.ts` — RapidAPI Trending Feed Fetcher

**Technical approach:** Direct REST API calls via native `fetch`. No browser. Adaptive endpoint discovery.

**Purpose:** Queries RapidAPI-hosted TikTok scraper services to retrieve trending video data by region. Because RapidAPI hosts multiple TikTok scraper services with different route schemas, the worker tries multiple endpoint paths per region and uses the first that succeeds.

**Endpoint strategy:** Detects the API host at runtime:
- If `host.includes("scraper7")`: uses Scraper7-specific paths (`/feed/search`, `/feed`, `/trending`)
- Otherwise: tries 8 generic paths (`/trending/{region}`, `/trending`, `/feed/trending`, `/search`, etc.)

**Key behaviour:**
- Iterates over all `RAPID_API_KEYS` (each key is a separate `RapidApiConfig`)
- For each config: iterates over regions, tries endpoint candidates in order, writes the **first successful payload** per region and moves on (`break` after first success)
- On any failure: retries once after 1,000 ms, then aborts the entire worker for that API config
- Writes raw response envelopes: `{ host, region, endpoint, fetchedAt, payload }` — preserves the full response for parsing flexibility in `normalize.ts`
- `RAPID_MAX_REQUESTS` acts as a hard safety cap across all regions and configs

**Inputs:**
- `RAPID_API_HOST`, `RAPID_API_KEYS`, `CRAWL_REGIONS`
- `RAPID_MAX_REQUESTS` (default 150), `RAPID_DELAY_MS` (default 1,500 ms)

**Outputs:** `output_json/tiktok_rapid_raw.jsonl` (overwritten per run)

**Run standalone:**
```bash
npm run tiktok:rapid
```

---

### `normalize.ts` — Cross-Source Payload Normalizer

**Technical approach:** Streaming file I/O (`readline` interface). No network calls. Contains two format-specific parsers.

**Purpose:** Reads raw payloads from both the RapidAPI and Google discovery workers, runs format-specific parsing logic, cross-deduplicates by video ID, and produces a uniform `IVideoRecordCandidate` stream.

**Parser 1 — `collectFromRapidPayload`** (standard RapidAPI format):
- Navigates `root.data / root.result / root.response / root` to find the video list (`list / items / data / item_list`)
- Extracts IDs from `aweme_id / id / video_id`
- Maps engagement from `statistics.play_count / digg_count / comment_count / share_count / collect_count`
- Extracts hashtags from 4 locations: `desc`, `original_client_text.markup_text`, `text_extra[type=1].hashtag_name`, `cha_list[].cha_name`
- Reconstructs music string from `music.title + music.author`
- Converts `create_time` (Unix seconds) to ISO 8601

**Parser 2 — `collectFromScraper7Payload`** (Scraper7 host format):
- Navigates `payload.data.videos[]`
- Maps `play_count`, `digg_count`, `comment_count`, `share_count`, `collect_count` directly
- Extracts hashtags from video `title` field only
- Handles `music_info.title + music_info.author`

**Number normalization (`normalizeNumber`):** Handles abbreviated strings — `"1.2K"` → 1200, `"3.5M"` → 3,500,000, `"2B"` → 2,000,000,000.

**Date normalization (`toIsoDate`):** Handles Unix seconds (< 1,000,000,000,000), Unix milliseconds (≥ that), and ISO string inputs. Falls back to `fetchedAt`.

**Deduplication:** Single in-memory `Set<string>` covers both input files — a video ID seen in the Rapid file will be skipped when the Google file is processed.

**Inputs:**
- `output_json/tiktok_rapid_raw.jsonl`
- `output_json/tiktok_google_raw.jsonl`

**Outputs:** `output_json/tiktok_candidates.jsonl` (overwritten per run)

**Run standalone:**
```bash
npm run tiktok:normalize
```

---

### `aggregator.ts` — Viral Score Filter

**Technical approach:** Streaming file I/O. Uses shared `withViralMetrics()` from `crawler/src/core/viral.calc.ts`.

**Purpose:** Final stage of Pipeline 2. Reads normalized candidates, applies the full PRD viral metrics formula (engagement rate, viral velocity, viral score), and writes only videos that exceed `VIRAL_SCORE_THRESHOLD`.

**Key behaviour:**
- Uses `VIRAL_SCORE_THRESHOLD` from `config/env.ts` with a hard fallback of **90** (lower than the YouTube pipeline's 98 — TikTok's distribution is broader)
- Streams input and writes output simultaneously — memory-efficient for large candidate sets
- Does not apply an age filter — age gating is handled upstream or by the consumer

**Inputs:**
- `output_json/tiktok_candidates.jsonl`
- `VIRAL_SCORE_THRESHOLD`

**Outputs:** `output_json/tiktok_viral_tt.jsonl` (overwritten per run)

**Run standalone:**
```bash
npm run tiktok:aggregate
```

---

### `index.ts` — Full Pipeline Orchestrator

**Purpose:** Runs all four Pipeline 2 stages in sequence for a single end-to-end experimental run: `runRapidWorker → runGoogleWorker → runNormalize → runAggregator`.

> **Production note:** This orchestrator targets the `output_json/` pipeline. For data that reaches the backend dashboard, run Pipeline 1 steps individually.

**Run:**
```bash
npm run tiktok:all
```

---

### `config/env.ts` — TikTok Environment Loader

**Purpose:** Parses and validates TikTok-specific environment variables independently from the shared `crawler/src/config/env.ts`. Produces a typed `TiktokAppEnv` object consumed by `rapid.worker` and `aggregator`.

**Key parsing logic:**
- `RAPID_API_HOST` + `RAPID_API_KEYS` → expands into `RapidApiConfig[]` — one object per key, all sharing the same host
- `CRAWL_REGIONS` → splits on comma, trims whitespace, filters empty strings

**Exports:** Singleton `env` object evaluated once at module load time.

---

### `workers/source.types.ts` — Collector Interface

**Purpose:** Defines the `IWorkerCollector<TInput>` contract for pluggable data source adapters. `createUnsupportedCollector` provides a placeholder that throws with a clear message if called before a real adapter is wired.

**Status:** Not yet connected to a live collector. Reserved for future extension.

---

## Execution Guide

### Prerequisites

```bash
# 1. Install Node.js dependencies (from project root)
npm install

# 2. Install Playwright browser binaries
npx playwright install chromium

# 3. Configure environment
cp .env.example .env
```

Edit `.env` with:
```bash
# Pipeline 1 — required
SERPER_API_KEYS=your_serper_key_1,your_serper_key_2

# Pipeline 1 — optional tuning
CRAWL_REGION=us
CRAWL_LANG=en
SERPER_NUM=100
SERPER_MAX_PAGES=2
SERPER_DELAY_MS=500
ENRICHER_CONCURRENCY=5
MAX_VIDEO_AGE_DAYS=1
VIRAL_SCORE_THRESHOLD=98

# Pipeline 2 — required if using RapidAPI
RAPID_API_HOST=tiktok-scraper7.p.rapidapi.com
RAPID_API_KEYS=your_rapid_key_1,your_rapid_key_2
CRAWL_REGIONS=US,GB
RAPID_MAX_REQUESTS=150
RAPID_DELAY_MS=1500
```

### Running Pipeline 1 (Production)

```bash
# Step 1 — Discover TikTok video IDs via Google (Serper API)
npm run tiktok:google

# Step 2 — Deduplicate raw IDs → pending enrichment queue
npm run tiktok:filter-id

# Step 3 — Playwright enrichment + viral scoring → feeds backend API
npm run tiktok:process-total
```

### Running Pipeline 2 (RapidAPI Experimental)

```bash
# Step 1 — Fetch trending feeds from RapidAPI
npm run tiktok:rapid

# Step 2 — Normalize cross-source payloads
npm run tiktok:normalize

# Step 3 — Apply viral scoring
npm run tiktok:aggregate

# Or: run all 4 stages sequentially
npm run tiktok:all
```

### Checking Progress Mid-Run

`process-id-filter-to-total-tt.ts` logs enrichment progress inline:
```
[TikTokEnricher] Enriching [12/340] video ID: 7312345678901234567
Wrote 11 new records to data/tiktok/total_vids_tt.jsonl
```

Monitor queue depth to estimate remaining work:
```bash
wc -l data/tiktok/id_filter_tt.jsonl
```

---

## Scraping Challenges & Resilience

### TikTok Anti-Bot Fingerprinting

**Challenge:** TikTok's frontend detects headless browsers via `navigator.webdriver`, missing Chrome extension APIs, and timing anomalies.

**Mitigations applied in `process-id-filter-to-total-tt.ts`:**
- `puppeteer-extra-plugin-stealth` patches all known `navigator.webdriver` exposure points
- `--disable-blink-features=AutomationControlled` suppresses the Chrome automation flag
- Realistic Windows 10 user agent string (`Chrome/124.0.0.0`)
- `en-US` locale and `1280×720` viewport match a real desktop browser
- Randomized inter-request delay (1–3 s) prevents machine-regular timing patterns
- Isolated browser contexts per worker prevent cookie-state cross-contamination

### TikTok Rate Limiting (429 / CAPTCHA)

**Challenge:** Repeated requests from a single IP to TikTok video pages trigger progressive rate limiting. At high concurrency, TikTok may serve a CAPTCHA challenge page instead of the video.

**Mitigations:**
- Default concurrency capped at **5** (`ENRICHER_CONCURRENCY`) — tunable downward
- Network interception (Primary Strategy) means the page only needs to reach the XHR endpoint — the full page does not need to render, reducing request surface
- One retry per video with a 2-second back-off before giving up
- If the rate limit is persistent, reduce `ENRICHER_CONCURRENCY` to `2` or `3` in `.env`

**Escalation:** If >20% of videos log `Enrichment failed`, stop the run, wait 30–60 minutes, then restart from where the queue left off (it is safe to re-run `process-id-filter-to-total-tt` — already-enriched IDs are permanently written to `total_vids_tt.jsonl` and will be skipped by `filter-google-ids-tt` on the next run).

### Serper API Quota Exhaustion

**Challenge:** Serper.dev enforces monthly request quotas per API key.

**Mitigations:**
- Add multiple keys to `SERPER_API_KEYS` — they are rotated round-robin across queries
- Reduce `SERPER_MAX_PAGES` from 2 to 1 to halve quota consumption while maintaining broad coverage
- Tune `SERPER_NUM` (default 100) — lower values use the same quota per page but return fewer results

**Symptom:** `google.worker` logs `[Serper] HTTP 429` or `[Serper] HTTP 403`.

### RapidAPI Quota / Host Changes

**Challenge:** RapidAPI TikTok scrapers change their endpoint schemas without notice. A host that previously accepted `/trending` may switch to `/feed/search`.

**Mitigations built in:**
- `buildRapidEndpointCandidates` tries 8 endpoint paths per region per config — the first successful response wins
- The worker aborts cleanly for a failing host after one retry rather than hanging

**Symptom:** `[rapid] Retry failed. Aborting worker {host}` — add a second key pointing to an alternate RapidAPI host.

### TikTok Schema Changes (`__NEXT_DATA__` / `__UNIVERSAL_DATA_FOR_REHYDRATION__`)

**Challenge:** TikTok periodically changes the structure of its server-side hydration blobs.

**Current paths probed in DOM fallback:**
```
__NEXT_DATA__ → props.pageProps.itemInfo.itemStruct
__NEXT_DATA__ → props.pageProps.videoData.itemInfo.itemStruct
__UNIVERSAL_DATA_FOR_REHYDRATION__ → __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
```

**Detection:** If `detail` is `null` after both the network intercept and the DOM fallback, the log line `[TikTokEnricher] Enrichment failed for video ID {id}` appears.

**Recovery:** Check the actual page response in a real browser. If the JSON path has changed, update the `page.evaluate` block in `process-id-filter-to-total-tt.ts` → the two `??` chains that read from the DOM elements.

### Interrupted Runs and Safe Restarts

All three Pipeline 1 steps are idempotent and safe to restart:

| Step | Safe to re-run? | Reason |
|------|----------------|--------|
| `tiktok:google` | Yes | Overwrites `raw_google_output_tt.jsonl` fresh each run |
| `tiktok:filter-id` | Yes | Reads live state of `total_vids_tt.jsonl` and `id_filter_tt.jsonl`; recalculates the delta |
| `tiktok:process-total` | Yes | Appends to output files; `filter-google-ids-tt` will skip already-enriched IDs on the next pass |

**After an interrupted enrichment run:**
```bash
# Re-dedup the queue to remove any IDs that made it to total_vids before the crash
npm run tiktok:filter-id

# Resume enrichment
npm run tiktok:process-total
```

### Checking Logs

All scripts log to stdout with `[tag]` prefixes:

```
[GoogleWorker] Query: "tiktok viral us today" | page=1
[GoogleWorker] Added: 12 | Total unique seeds: 487
[rapid] [req #23/150] Fetching US (/trending)
[TikTokEnricher] Enriching [45/340] video ID: 7312345678901234567
[aggregator] Viral videos found: 214 (threshold: 90)
```

Persist logs to file for post-run inspection:
```bash
npm run tiktok:all 2>&1 | tee logs/tiktok-$(date +%Y%m%d-%H%M%S).log
```
