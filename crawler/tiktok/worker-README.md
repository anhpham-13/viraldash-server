# TikTok Crawler — Worker Documentation

## Overview

The `crawler/tiktok/` module is the TikTok data-collection layer of the ViralDash backend. It discovers TikTok video IDs from two independent sources — a REST API (Serper.dev) and a headless browser matrix scraper (Playwright + Google Advanced Search) — then enriches each discovered ID with full engagement metrics through either a Playwright page scraper or a direct RapidAPI call. A shared viral scoring formula filters final output before the backend API consumes it.

The module intentionally provides **interchangeable components** at both the discovery and enrichment layers: operators can swap strategies based on quota availability, IP reputation, and cost constraints without changing downstream consumers.

---

## Architecture

### Production Data Flow

```
Discovery Layer (choose one or both — both write to same raw output file)
│
├── google.worker.ts          REST API (Serper.dev → Google Video Search)
│                             No browser. Fast. API-quota limited.
│
└── gg-advanced-search-scraper.ts   Playwright + nocaptchaai extension
                              Browser-based. No API quota. CAPTCHA-tolerant.
                              Matrix of `site:tiktok.com/` queries via Google.
                              │
                              ▼
             data/tiktok/raw_google_output_tt.jsonl   { id, url, fetchedAt }
                              │
                     filter-google-ids-tt.ts
                     (dedup against total store + current queue)
                              │
                              ▼
             data/tiktok/id_filter_tt.jsonl   { id, url, author }
                              │
Enrichment Layer (choose one — both consume id_filter, write to same outputs)
│
├── process-id-filter-to-total-tt.ts    Playwright stealth browser scraping
│                                       Free. Requires browser binary.
│
└── rapid.worker.ts                     RapidAPI per-video lookup
                                        Paid API. No browser. Faster.
                                        Endpoint: /v1/post/{videoId}?region={region}
                              │
                              ▼
             data/tiktok/total_vids_tt.jsonl   (append-only, enriched records)
             data/tiktok/viral_vids_tt.jsonl   (append-only, viral threshold filter)
                              ▲
                    Backend API reads here
```

### Experimental Pipeline 2 (output_json/ tree)

```
rapid.worker (legacy role) ──▶  output_json/tiktok_rapid_raw.jsonl
google.worker (legacy role) ──▶  output_json/tiktok_google_raw.jsonl
                    │
              normalize.ts  (cross-source parser + dedup)
                    │
              output_json/tiktok_candidates.jsonl
                    │
              aggregator.ts  (viral score filter)
                    │
              output_json/tiktok_viral_tt.jsonl
```

> `index.ts` orchestrates this experimental four-stage sequence. It does **not** feed the live backend. For production data collection, run the Pipeline 1 steps individually via `npm run tiktok:*` scripts.

---

## Directory Structure

```
crawler/tiktok/
│
├── index.ts                             Experimental pipeline orchestrator
│
├── config/
│   └── env.ts                           TikTok-specific env variable loader + types
│
├── workers/
│   └── source.types.ts                  IWorkerCollector<T> interface (future extension)
│
│   ── Discovery ──
├── google.worker.ts                     Serper API → Google Video Search → TikTok seeds
├── gg-advanced-search-scraper.ts        Playwright browser → Google site: matrix scraper
│
│   ── Deduplication ──
├── filter-google-ids-tt.ts              Raw seed dedup → pending enrichment queue
│
│   ── Enrichment ──
├── process-id-filter-to-total-tt.ts     Playwright stealth → TikTok page scraper → upsertVideo()
├── rapid.worker.ts                      RapidAPI /v1/post/{id} → per-video enricher → upsertVideo()
│
│   ── Refresh loop ──
├── meta-refresh-tt.ts                   Re-fetch stats → pushSnapshot() (Loop 2)
├── refresh-viral-vids-tt.ts             DEAD — superseded by meta-refresh-tt.ts
│
│   ── Experimental normalization pipeline ──
├── normalize.ts                         Cross-source payload normalizer
└── aggregator.ts                        Viral score filter + final output writer
```

---

## Environment Variables

Place all variables in `.env` at the **project root**.

### Discovery — Serper API (`google.worker.ts`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERPER_API_KEYS` | Yes | — | Comma-separated Serper.dev API keys. Rotated round-robin per request. |
| `SERPER_API_KEY` | Fallback | — | Single Serper key (used if `SERPER_API_KEYS` is absent). |
| `CRAWL_REGION` | No | `us` | ISO country code for Serper `gl` param. |
| `CRAWL_LANG` | No | `en` | Language code for Serper `hl` param. |
| `SERPER_NUM` | No | `100` | Results returned per Serper page. |
| `SERPER_MAX_PAGES` | No | `2` | Pages fetched per query. |
| `SERPER_DELAY_MS` | No | `500` | Milliseconds between Serper requests. |

### Enrichment — Playwright scraper (`process-id-filter-to-total-tt.ts`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENRICHER_CONCURRENCY` | No | `5` | Parallel Playwright browser workers. |
| `MAX_VIDEO_AGE_DAYS` | No | `1` | Videos older than this value (in days) are excluded from `viral_vids_tt.jsonl`. |
| `VIRAL_SCORE_THRESHOLD` | No | `98` | Minimum viral score to write to `viral_vids_tt.jsonl`. |

### Enrichment — RapidAPI (`rapid.worker.ts`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `RAPID_API_HOST` | Yes | — | RapidAPI endpoint host (e.g. `tokapi-mobile-version.p.rapidapi.com`). |
| `RAPID_API_KEYS` | Yes | — | Comma-separated RapidAPI keys. |
| `CRAWL_REGIONS` | No | `US` | Comma-separated ISO region codes for the `region` query param. |
| `RAPID_CONCURRENCY` | No | `1` | Parallel fetch workers (keep low — RapidAPI enforces rate limits). |
| `RAPID_DELAY_MS` | No | `2000` | Milliseconds between each RapidAPI request per worker. |
| `MAX_VIDEO_AGE_DAYS` | No | `1` | Same age filter as Playwright enricher. |
| `VIRAL_SCORE_THRESHOLD` | No | `98` | Same viral score gate as Playwright enricher. |

### Utility Scripts (`aggregator.ts`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VIRAL_SCORE_THRESHOLD` | No | `90` | Aggregator uses 90 as its hard fallback if not set. |
| `MAX_BROWSER_CONCURRENCY` | No | `3` | Loaded by `config/env.ts`; reserved for future Playwright pooling. |

---

## Data Files

All paths relative to the **project root**.

### Pipeline 1 — Production

| File | Written by | Read by | Description |
|---|---|---|---|
| `data/tiktok/raw_google_output_tt.jsonl` | `google.worker`, `gg-advanced-search-scraper` | `filter-google-ids-tt` | Raw seeds: `{ id, url, fetchedAt }`. Overwritten at each discovery run. |
| `data/tiktok/id_filter_tt.jsonl` | `filter-google-ids-tt` | `process-id-filter-to-total-tt`, `rapid.worker` | Pending enrichment queue: `{ id, url, author }`. Re-calculated per filter run. |
| `data/tiktok/total_vids_tt.jsonl` | `process-id-filter-to-total-tt`, `rapid.worker` | `filter-google-ids-tt`, backend | Append-only store of all enriched TikTok records. |
| `data/tiktok/viral_vids_tt.jsonl` | `process-id-filter-to-total-tt`, `rapid.worker` | **Backend API** | Append-only viral video records. Directly consumed by dashboard. |

### Pipeline 2 — Experimental

| File | Written by | Read by | Description |
|---|---|---|---|
| `output_json/tiktok_rapid_raw.jsonl` | `rapid.worker` (legacy) | `normalize` | Raw RapidAPI envelopes. Deprecated as rapid.worker is now in Pipeline 1. |
| `output_json/tiktok_google_raw.jsonl` | `google.worker` (legacy) | `normalize` | Raw Google seed records for the experimental path. |
| `output_json/tiktok_candidates.jsonl` | `normalize` | `aggregator` (legacy) | Normalized `IVideoRecordCandidate` records, cross-source deduplicated. |
| `data/tiktok/viral_vids_tt.jsonl` | `aggregator` | — | Final viral output. Aggregator now acts as a recalculator for total_vids_tt. |

---

## Component Reference

---

### `google.worker.ts` — Serper API Discovery Worker

**Technical approach:** Pure REST API calls via Node.js `node:https`. No browser automation.

**Target data:** Canonical TikTok video URLs indexed by Google's video search in the last 24 hours. Produces ID + URL seeds only — no engagement metrics.

**Query strategy:** Dynamically builds a diversified query pool from 8 intent phrases cross-combined with 6 freshness signals, 30 content categories, 14 US geo signals, 26 alphabet characters, and 6 numbers, plus 11 hashtag variants across 4 templates. All queries include `tbs=qdr:d` (last 24 hours). The pool deduplicated via `Set` typically yields hundreds of unique queries per run.

**ID extraction:** Regex `tiktok.com/@(author)/video/(id)` — only canonical video page URLs are accepted. Profile pages, music URLs, and redirects are discarded.

**Key behaviour:**
- Rotates through `SERPER_API_KEYS` round-robin (one key slot consumed per page request)
- In-memory `Set<string>` deduplicates IDs before writing to disk
- Output file overwritten fresh at run start — each execution produces a clean snapshot
- Safe to interrupt; restart re-generates from scratch

**Inputs:**
- `SERPER_API_KEYS` (required)
- `CRAWL_REGION`, `CRAWL_LANG`, `SERPER_NUM`, `SERPER_MAX_PAGES`, `SERPER_DELAY_MS`

**Output:** `data/tiktok/raw_google_output_tt.jsonl` — records: `{ id, url, fetchedAt }`

**Run:**
```bash
npm run tiktok:google
```

---

### `gg-advanced-search-scraper.ts` — Playwright Browser Matrix Scraper

**Technical approach:** Headed Chromium browser automation via Playwright with the bundled `nocaptchaai-extension` loaded. Scrapes Google Search SERPs directly. No API quota consumed.

**Target data:** Same as `google.worker.ts` — canonical TikTok video URLs from Google — but via a browser rather than an API. Provides an API-quota-free fallback and a broader index surface using Google Advanced Search operators.

**Query matrix:** Generates `site:tiktok.com/` queries using a 26 × 36 character grid (lowercase a–z × a–z + 0–9), each expressed in three operator forms:
```
site:tiktok.com/ "ab"
site:tiktok.com/ ab
site:tiktok.com/ intitle:"ab"
```
This produces approximately **2,808 unique queries** that systematically force Google to surface TikTok video pages across all textual namespaces. Queries are shuffled randomly before dispatch to avoid detectable sequential patterns. All searches include `&tbs=qdr:d` (24-hour recency filter) and `&num=100` (maximum results per SERP).

**Concurrency model:** Splits the full query list evenly across `CONCURRENCY = 5` parallel Playwright browser workers. Each worker owns an isolated persistent browser profile (`data/user_data_worker_{n}/`) to prevent cookie and session cross-contamination. The `nocaptchaai-extension` is loaded into every browser context via `--load-extension` and `--disable-extensions-except` launch flags.

**CAPTCHA handling:** Google's `/sorry` challenge page is detected by URL pattern. The worker pauses and waits up to 45 seconds for the extension to resolve the challenge automatically before continuing.

**ID extraction:** DOM evaluation via `page.evaluate()` queries all `<a>` elements, filters hrefs containing `tiktok.com/` and `/video/`, then applies the same `\/video\/([0-9]+)` regex as the API worker.

**Key behaviour:**
- Requires `headless: false` — the nocaptchaai extension must render to interact with CAPTCHAs
- Pre-loads existing IDs from `total_vids_tt.jsonl` and the legacy `total_video.jsonl` to skip already-enriched videos
- Appends new records immediately to `raw_google_output_tt.jsonl` (shared with `google.worker`)
- 2-second wait between queries per worker to avoid behaviour pattern detection

**Inputs:**
- `crawler/extensions/nocaptchaai-extension/` (bundled, no config needed)
- `data/tiktok/total_vids_tt.jsonl` (read for pre-seed dedup, optional)

**Output:** `data/tiktok/raw_google_output_tt.jsonl` — same schema as `google.worker`: `{ id, url, fetchedAt }`

**Run:**
```bash
npm run tiktok:google-browser
# (or invoke directly)
npx tsx crawler/tiktok/gg-advanced-search-scraper.ts
```

> **Note:** This script calls `runSearchPipeline()` at module load — it executes immediately when invoked via `tsx`. It does not have a dedicated `package.json` script entry yet; add one under `tiktok:google-browser` if needed.

---

### `filter-google-ids-tt.ts` — ID Deduplicator / Queue Builder

**Technical approach:** File I/O only. No network calls.

**Purpose:** Merges the raw discovery output against two existing ID sets — `total_vids_tt.jsonl` (already enriched) and the current `id_filter_tt.jsonl` queue (already pending) — and produces a clean, non-redundant queue for the enrichment workers.

**Key behaviour:**
- Accepts both wrapped (`{ data: { id } }`) and flat (`{ id }`) row shapes from the raw file to handle both `google.worker` and legacy outputs
- Preserves queue rows already in `id_filter_tt.jsonl` that are not yet in `total_vids_tt.jsonl` — re-running filter does not lose the in-progress queue
- Output shape: `{ id, url, author }` — `author` is required by the Playwright enricher to construct the TikTok page URL

**Inputs:**
- `data/tiktok/raw_google_output_tt.jsonl` (required)
- `data/tiktok/total_vids_tt.jsonl` (read for dedup, optional)
- `data/tiktok/id_filter_tt.jsonl` (read to preserve queue, optional)

**Output:** `data/tiktok/id_filter_tt.jsonl` — overwritten with the merged deduplicated queue

**Run:**
```bash
npm run tiktok:filter-id
```

---

### `process-id-filter-to-total-tt.ts` — Playwright Video Enricher

**Technical approach:** Headless Chromium browser automation via `playwright-extra` + `puppeteer-extra-plugin-stealth`. Two-strategy data extraction:

1. **Network interception (primary):** `page.on("response")` captures TikTok's internal XHR responses to `/api/item/detail` and `/api/video/detail`. These endpoints return a complete `itemStruct` JSON object — schema-stable and the most reliable data source. Fires before the page finishes rendering.

2. **DOM scraping (fallback):** If no network XHR fires within the page load window, the worker parses the server-side hydration blobs embedded in the page HTML:
   ```
   #__NEXT_DATA__                        → props.pageProps.itemInfo.itemStruct
   #__NEXT_DATA__                        → props.pageProps.videoData.itemInfo.itemStruct
   #__UNIVERSAL_DATA_FOR_REHYDRATION__   → __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
   ```

**Target data:** For each queued video ID: `diggCount` (likes), `playCount` (views), `commentCount`, `shareCount`, `collectCount` (saves), `createTime`, `music` (sound attribution), `challenges` (hashtag list), and `author.uniqueId`.

**Concurrency model:** `ENRICHER_CONCURRENCY` (default 5) async workers share a single ordered queue via a shared `index` counter. Each worker owns its full browser lifecycle per video (launch → context → page → close) — no shared browser process or session state.

**Viral scoring:** Inline, immediately after enrichment. A record is appended to `viral_vids_tt.jsonl` only if `age_hours ≤ MAX_VIDEO_AGE_DAYS × 24` AND `viral_score ≥ VIRAL_SCORE_THRESHOLD`. Uses the shared `withViralMetrics()` from `crawler/src/core/viral.calc.ts`.

**Key behaviour:**
- `puppeteer-extra-plugin-stealth` patches all known `navigator.webdriver` exposure points
- `--disable-blink-features=AutomationControlled` suppresses Chrome's automation flag
- Windows 10 Chrome/124 user agent + `en-US` locale + `1280×720` viewport
- Retries each video once after a 2-second pause on failure
- Randomized per-worker inter-request delay: `1,000–3,000 ms`
- Writes directly via `appendFileSync` — safe to interrupt and resume

**Inputs:**
- `data/tiktok/id_filter_tt.jsonl` (required)
- `ENRICHER_CONCURRENCY`, `MAX_VIDEO_AGE_DAYS`, `VIRAL_SCORE_THRESHOLD`

**Outputs:**
- `data/tiktok/total_vids_tt.jsonl` (append)
- `data/tiktok/viral_vids_tt.jsonl` (append — consumed by backend API)

**Run:**
```bash
npm run tiktok:process-total
```

---

### `rapid.worker.ts` — RapidAPI Per-Video Enricher

**Technical approach:** Direct REST API calls via native `fetch`. No browser. Reads the same `id_filter_tt.jsonl` queue as the Playwright enricher and writes to the same output files — it is a **drop-in API-based alternative** to `process-id-filter-to-total-tt.ts`.

**API endpoint:** `https://tokapi-mobile-version.p.rapidapi.com/v1/post/{videoId}?region={region}`

**Target data:** `aweme_detail` object from the response: `statistics` (play/digg/comment/share/collect counts), `create_time`, `music` (title + author/owner_nickname), `text_extra[].hashtag_name` (hashtags), `author.unique_id`.

**Concurrency model:** `RAPID_CONCURRENCY` (default 2) async workers sharing a shared index counter — deliberately low to respect RapidAPI rate limits.

**Viral scoring:** Identical inline logic to `process-id-filter-to-total-tt.ts` — records passing the age and viral score thresholds are immediately appended to `viral_vids_tt.jsonl`.

**Key behaviour:**
- Uses the first key from `rapidApiConfigs` (loaded from `RAPID_API_HOST` + `RAPID_API_KEYS` via `config/env.ts`)
- `CRAWL_REGIONS[0]` (default `US`) is passed as the `region` query parameter
- Retries each video once after a 2-second pause on `null` or missing `aweme_detail`
- `RAPID_DELAY_MS` (default 1,000 ms) applied after each video regardless of success
- Logs progress as `[RapidEnricher] Enriching [n/total] video ID: {id}`

**When to prefer over Playwright enricher:**
- IP is rate-limited or flagged by TikTok
- Browser binary unavailable in the deployment environment
- Faster throughput needed (no browser launch overhead per video)

**Inputs:**
- `data/tiktok/id_filter_tt.jsonl` (required)
- `RAPID_API_HOST`, `RAPID_API_KEYS`, `CRAWL_REGIONS`
- `RAPID_CONCURRENCY`, `RAPID_DELAY_MS`, `MAX_VIDEO_AGE_DAYS`, `VIRAL_SCORE_THRESHOLD`

**Outputs:**
- `data/tiktok/total_vids_tt.jsonl` (append)
- `data/tiktok/viral_vids_tt.jsonl` (append — consumed by backend API)

**Run:**
```bash
npm run tiktok:rapid
```

---

### `normalize.ts` — Cross-Source Payload Normalizer

**Technical approach:** Streaming file I/O via Node.js `readline`. No network calls. Contains two format-specific parsers for the experimental pipeline's raw files.

**Purpose:** Reads raw payloads from `tiktok_rapid_raw.jsonl` and `tiktok_google_raw.jsonl`, parses them through host-specific logic, cross-deduplicates by video ID, and writes a uniform `IVideoRecordCandidate` stream.

**Parser 1 — `collectFromRapidPayload`** (standard RapidAPI format):
- Traverses `root.data / root.result / root.response / root` to find the video list (`list / items / data / item_list`)
- Extracts IDs from `aweme_id / id / video_id`
- Maps engagement from `statistics.play_count / digg_count / comment_count / share_count / collect_count`
- Hashtag extraction from 4 locations: `desc`, `original_client_text.markup_text`, `text_extra[type=1].hashtag_name`, `cha_list[].cha_name`
- Music from `music.title + music.author / owner_nickname / owner_handle`
- Converts `create_time` (Unix seconds) to ISO 8601

**Parser 2 — `collectFromScraper7Payload`** (Scraper7 host format):
- Navigates `payload.data.videos[]`
- Maps `play_count`, `digg_count`, `comment_count`, `share_count`, `collect_count` directly
- Hashtags extracted from `title` field only
- Music from `music_info.title + music_info.author`

**`normalizeNumber`:** Handles abbreviated strings — `"1.2K"` → 1,200; `"3.5M"` → 3,500,000; `"2B"` → 2,000,000,000.

**`toIsoDate`:** Handles Unix seconds (< 1,000,000,000,000), Unix milliseconds, and ISO string inputs. Falls back to `fetchedAt`.

**Inputs:**
- `output_json/tiktok_rapid_raw.jsonl`
- `output_json/tiktok_google_raw.jsonl`

**Output:** `output_json/tiktok_candidates.jsonl` (overwritten per run)

**Run:**
```bash
npm run tiktok:normalize
```

---

### `aggregator.ts` — Viral Score Recalculator

**Technical approach:** Streaming file I/O. Applies the shared `withViralMetrics()` formula from `crawler/src/core/viral.calc.ts`.

**Purpose:** A utility to re-evaluate the enriched video database. Reads all records from `total_vids_tt.jsonl`, re-applies the age filter (`MAX_VIDEO_AGE_DAYS`) and computes the viral score. Overwrites `viral_vids_tt.jsonl` with records that meet `VIRAL_SCORE_THRESHOLD`. Useful if you change the scoring formula or threshold and want to retroactively apply it to existing data.

**Key behaviour:**
- Hard fallback threshold: **90**
- Streams input and writes output simultaneously — memory-efficient for large candidate sets
- Evaluates `postDate` against the current time. Videos older than `MAX_VIDEO_AGE_DAYS` are excluded.

**Inputs:**
- `data/tiktok/total_vids_tt.jsonl`
- `VIRAL_SCORE_THRESHOLD`
- `MAX_VIDEO_AGE_DAYS`

**Output:** `data/tiktok/viral_vids_tt.jsonl` (overwritten per run)

**Run:**
```bash
npx tsx crawler/tiktok/aggregator.ts
```

---

### `index.ts` — Experimental Pipeline Orchestrator

**Purpose:** Runs RapidWorker → GoogleWorker → Normalize → Aggregator as a single sequential end-to-end experimental run via the `output_json/` tree.

> **Production note:** This orchestrator targets the experimental `output_json/` pipeline and does **not** feed the backend dashboard. For live data, run the Pipeline 1 steps individually.

**Run:**
```bash
npm run tiktok:all
```

---

### `config/env.ts` — TikTok Environment Loader

**Purpose:** Parses and validates TikTok-specific environment variables independently from the shared `crawler/src/config/env.ts`. Produces a typed `TiktokAppEnv` singleton consumed by `rapid.worker` and `aggregator`.

**Key parsing logic:**
- `RAPID_API_HOST` + `RAPID_API_KEYS` → expands into `RapidApiConfig[]` (one entry per key, all sharing the same host)
- `CRAWL_REGIONS` → comma-split, trimmed, empty entries filtered
- All numeric variables fall back to safe production defaults if absent or non-parseable

**Exports:** Singleton `env` object evaluated once at module load time.

---

### `workers/source.types.ts` — Collector Interface

**Purpose:** Defines the `IWorkerCollector<TInput>` contract for pluggable data source adapters. `createUnsupportedCollector` provides a typed placeholder that throws a descriptive error if called before a concrete adapter is wired.

**Status:** Not yet connected to a live collector. Reserved for future source-agnostic worker abstraction.

---

## Prerequisites & Setup

```bash
# 1. Install Node.js dependencies (from project root)
npm install

# 2. Install Playwright Chromium binary (required for browser-based workers)
npx playwright install chromium

# 3. Create and configure the environment file
cp .env.example .env   # or create .env manually
```

**Minimum `.env` for Pipeline 1 (Serper API discovery + Playwright enrichment):**
```bash
# Discovery
SERPER_API_KEYS=your_key_1,your_key_2

# Enrichment tuning (optional — these are the defaults)
CRAWL_REGION=us
CRAWL_LANG=en
SERPER_NUM=100
SERPER_MAX_PAGES=2
SERPER_DELAY_MS=500
ENRICHER_CONCURRENCY=5
MAX_VIDEO_AGE_DAYS=1
VIRAL_SCORE_THRESHOLD=98
```

**Additional variables for RapidAPI enrichment:**
```bash
RAPID_API_HOST=tokapi-mobile-version.p.rapidapi.com
RAPID_API_KEYS=your_rapid_key_1,your_rapid_key_2
CRAWL_REGIONS=US
RAPID_CONCURRENCY=2
RAPID_DELAY_MS=1000
```

---

## Execution Guide

### Pipeline 1 — Production Run (Serper API Discovery)

```bash
# Step 1 — Discover TikTok video IDs via Serper API + Google Video Search
npm run tiktok:google

# Step 2 — Deduplicate raw IDs → clean pending enrichment queue
npm run tiktok:filter-id

# Step 3a — Enrich via Playwright (free, needs Chromium)
npm run tiktok:process-total

# Step 3b — Enrich via RapidAPI (paid, no browser required)
npm run tiktok:rapid
```

> Run either Step 3a **or** Step 3b depending on your environment. Both consume `id_filter_tt.jsonl` and write to the same output files.

### Pipeline 1 — Production Run (Browser Matrix Discovery)

```bash
# Step 1 — Discover TikTok video IDs via Playwright + Google Advanced Search
npx tsx crawler/tiktok/gg-advanced-search-scraper.ts

# Step 2 — Deduplicate
npm run tiktok:filter-id

# Step 3a or 3b — Enrich (same as above)
npm run tiktok:process-total
# or
npm run tiktok:rapid
```

### Pipeline 2 — Experimental Run

```bash
npm run tiktok:rapid      # Fetch raw data into output_json/
npm run tiktok:normalize  # Parse and cross-deduplicate
npm run tiktok:aggregate  # Score and filter viral records

# Or run all four stages sequentially:
npm run tiktok:all
```

### Monitoring Progress Mid-Run

The enrichment workers log inline progress:
```
[TikTokEnricher] Enriching [12/340] video ID: 7312345678901234567
[RapidEnricher]  Enriching [12/340] video ID: 7312345678901234567
```

Check queue depth to estimate remaining work (requires `wc` — use Git Bash on Windows):
```bash
wc -l data/tiktok/id_filter_tt.jsonl
```

Persist logs for post-run inspection:
```bash
npm run tiktok:process-total 2>&1 | tee logs/tiktok-enrich-$(date +%Y%m%d-%H%M%S).log
```

### Safe Restart After Interruption

All Pipeline 1 steps are idempotent and safe to restart:

| Step | Safe to re-run? | Reason |
|---|---|---|
| `tiktok:google` | Yes | Overwrites `raw_google_output_tt.jsonl` fresh each run |
| `gg-advanced-search-scraper` | Yes | Overwrites `raw_google_output_tt.jsonl`; pre-seeds already-enriched IDs |
| `tiktok:filter-id` | Yes | Reads live state of both files; recalculates the pending delta |
| `tiktok:process-total` | Yes | Appends to output files; filter step skips already-enriched IDs on next pass |
| `tiktok:rapid` | Yes | Same append-safe behaviour as Playwright enricher |

**After an interrupted enrichment run:**
```bash
# Re-dedup to remove any IDs that were written to total_vids before the crash
npm run tiktok:filter-id

# Resume enrichment from where the queue left off
npm run tiktok:process-total
# or
npm run tiktok:rapid
```

---

## Scraping Challenges & Resilience

### TikTok Anti-Bot Fingerprinting

**Challenge:** TikTok's frontend detects headless browsers via `navigator.webdriver`, absent Chrome extension APIs, Canvas fingerprint anomalies, and timing regularity.

**Mitigations in `process-id-filter-to-total-tt.ts`:**
- `puppeteer-extra-plugin-stealth` patches all known `navigator.webdriver` and automation exposure points across 10+ evasion modules
- `--disable-blink-features=AutomationControlled` suppresses the most commonly checked Chrome flag
- Realistic Windows 10 user agent: `Chrome/124.0.0.0`
- `en-US` locale + `1280×720` viewport matches a real desktop session
- Randomized inter-request delay (1,000–3,000 ms per worker) prevents machine-regular timing
- Isolated browser contexts per worker prevent shared cookie state

**If detections increase:** Reduce `ENRICHER_CONCURRENCY` to `2` or `3` and increase the randomized delay floor by editing the `humanDelay` calculation in `process-id-filter-to-total-tt.ts`.

---

### TikTok Rate Limiting (429 / Challenge Page)

**Challenge:** Repeated requests to TikTok video pages from a single IP trigger progressive throttling. At high concurrency, TikTok may serve an interstitial challenge instead of the video.

**Mitigations:**
- Default concurrency capped at **5** — tunable via `ENRICHER_CONCURRENCY`
- Network interception fires before full page render — the scraper only needs the XHR response, not the full DOM
- One retry per video after a 2-second back-off

**Escalation:** If more than 20% of videos log `Enrichment failed`:
1. Stop the enrichment run
2. Switch to the RapidAPI enricher (`npm run tiktok:rapid`) which bypasses IP reputation issues
3. Or wait 30–60 minutes then restart (`npm run tiktok:filter-id && npm run tiktok:process-total`)

---

### Google CAPTCHA (`/sorry` Page) in Browser Workers

**Challenge:** `gg-advanced-search-scraper.ts` opens many Google Search pages in rapid succession, which triggers Google's anti-bot challenge (the `/sorry` URL pattern).

**Mitigation:** The bundled `nocaptchaai-extension` automatically detects and resolves Google CAPTCHAs via an AI-powered solver. The worker detects the challenge URL and waits up to 45 seconds for the extension to complete resolution before continuing.

**If the extension fails to resolve:** The worker logs `❌ AI giải CAPTCHA quá thời gian (Timeout)` and proceeds to the next query. The browser profile at `data/user_data_worker_{n}/` retains the post-challenge cookie state, which reduces re-challenge frequency on subsequent queries within the same session.

**Configuration:** The `nocaptchaai-extension` requires a valid API key configured inside the extension itself (via its popup). Without a key, CAPTCHA resolution will not work.

---

### Serper API Quota Exhaustion

**Challenge:** Serper.dev enforces monthly request quotas per API key.

**Mitigations:**
- Add multiple keys to `SERPER_API_KEYS` — rotated round-robin
- Reduce `SERPER_MAX_PAGES` from `2` to `1` to halve quota use with minimal coverage impact
- Switch to the browser-based `gg-advanced-search-scraper.ts` which requires no API key

**Symptom:** `google.worker` logs `[Serper] HTTP 429` or `[Serper] HTTP 403`.

---

### RapidAPI Quota and Host Changes

**Challenge:** RapidAPI enforces per-minute and per-month request limits. TikTok scraper services on RapidAPI also periodically change their endpoint schemas without notice.

**Mitigations:**
- `RAPID_CONCURRENCY` defaults to **2** — the lowest safe throughput for most RapidAPI plans
- `RAPID_DELAY_MS` adds a fixed inter-request gap per worker
- If the current host stops working, update `RAPID_API_HOST` to an alternative RapidAPI-hosted TikTok scraper

**Symptom:** Worker logs `[RapidEnricher] API call failed: 429` or `aweme_detail` is consistently `null`.

---

### TikTok Schema Changes

**Challenge:** TikTok periodically changes the JSON path structure of its server-side hydration blobs (`__NEXT_DATA__`, `__UNIVERSAL_DATA_FOR_REHYDRATION__`).

**Current DOM paths probed in `process-id-filter-to-total-tt.ts`:**
```
#__NEXT_DATA__                        → props.pageProps.itemInfo.itemStruct
#__NEXT_DATA__                        → props.pageProps.videoData.itemInfo.itemStruct
#__UNIVERSAL_DATA_FOR_REHYDRATION__   → __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct
```

**Detection:** If both the network intercept and the DOM fallback fail, `detail` is `null` and the worker logs `[TikTokEnricher] Enrichment failed for video ID {id}`.

**Recovery:** Open the failing TikTok URL in a real browser and inspect the contents of `#__NEXT_DATA__` or `#__UNIVERSAL_DATA_FOR_REHYDRATION__`. Update the `??` chain in the `page.evaluate` block in `process-id-filter-to-total-tt.ts` to reflect the new path.

The network intercept path (`/api/item/detail`) is typically more stable than the DOM structure — if it fires consistently, DOM path breakage has no impact.

---

## Log Reference

All scripts emit structured log lines with bracketed component tags:

```
[GoogleWorker] Query: "tiktok viral us today" | page=1
[GoogleWorker] Added: 12 | Total unique seeds: 487

[Worker 3] [Query 45/560] 🔍 Google Search: site:tiktok.com/ "bz"
[Worker 3] 🚨 Gặp CAPTCHA! Đang chờ noCaptcha AI Extension tự động giải quyết...
[Worker 3] 🎉 Vượt CAPTCHA thành công!
[Worker 3] 💾 Đã bóc được 8 TikTok videos

[TikTokEnricher] Enriching [45/340] video ID: 7312345678901234567
[RapidEnricher] Enriching [45/340] video ID: 7312345678901234567

[normalize] Rapid total: 1500
[normalize] Google total: 340
[normalize] Unique candidates saved: 1724

[aggregator] Total candidates evaluated: 1724
[aggregator] Viral videos found: 214 (threshold: 90)
```
