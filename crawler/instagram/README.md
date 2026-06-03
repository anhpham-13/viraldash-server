# Instagram Crawler

A multi-phase pipeline for discovering and enriching trending Instagram Reels metadata. It surfaces viral content by combining Google-based discovery with Instagram's private web API.

---

## Overview

The pipeline runs in four sequential phases:

```
Phase 1 ─ Discovery      Google scraping → raw post IDs & URLs
Phase 2 ─ Filtering      Deduplication → id_filter_ig.jsonl
Phase 3 ─ Enrichment     Instagram API / RapidAPI → full metadata
Phase 4 ─ Analysis       Hashtag scoring → hashtag_ig.json
```

Each phase reads from and writes to the shared `data/instagram/` directory so phases can be run independently or restarted without losing progress.

---

## Key Features

- **Dual discovery strategies** — browser-based Google scraping (no API key) and Serper API scraping, both targeting `instagram.com/reel/` and `/p/` URLs indexed within the last 24 hours.
- **Parallel workers** — up to 5 Playwright browser contexts run concurrently during both discovery and enrichment, each with its own isolated Chrome profile to avoid cookie/cache collisions.
- **Two enrichment paths** — the primary path uses Instagram's private `/api/v1/media/<id>/info/` endpoint authenticated with a real Playwright-captured session; the fallback uses RapidAPI for environments where direct session auth is unavailable.
- **Viral scoring** — posts are scored and written to `viral_posts_ig.jsonl` when they exceed the `VIRAL_SCORE_THRESHOLD` configured in `.env`.
- **Hashtag analytics** — a weighted scorer (views, likes, comments, viral score) ranks hashtags from viral posts and deduplicates near-duplicates using word-overlap similarity.
- **Automatic CAPTCHA handling** — the Google scraper integrates the noCaptcha AI browser extension and waits for it to resolve Google's `/sorry` page automatically.
- **Graceful shutdown** — `crawl_instagram_via_private_api.ts` catches `SIGINT` and runs the filter step before exit so the queue stays clean.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM) + TypeScript via `tsx` |
| Browser automation | [Playwright](https://playwright.dev/) (Chromium) |
| HTTP client | Native `fetch` (Node 18+) + `node:https` |
| Search APIs | [Serper](https://serper.dev/) (Google Search API) |
| Enrichment API | [RapidAPI — instagram-scraper-api2](https://rapidapi.com/) |
| Env config | `dotenv` |
| Data format | JSONL (one JSON object per line) |

---

## Directory Structure

```
crawler/instagram/
├── get_instagram_cookie.ts          # Step 0 — capture a live session cookie
├── gg-advanced-search-scraper.ts    # Phase 1a — Playwright Google scraper
├── serper-search.ts                 # Phase 1b — Serper API Google scraper
├── filter-google-ids-ig.ts          # Phase 2 — deduplication & queue builder
├── crawl_instagram_via_private_api.ts  # Phase 3a — native fetch enricher
├── detail-playwright.ts             # Phase 3b — Playwright browser enricher
├── rapid-instagram.ts               # Phase 3c — RapidAPI enricher
├── extract_hashtags.ts              # Phase 4 — hashtag scorer
└── debug-network.ts                 # Dev tool — network response inspector
```

### Data files (written to `data/instagram/`, git-ignored)

| File | Written by | Read by |
|---|---|---|
| `cookie.json` | `get_instagram_cookie.ts` | Phase 3a, 3b, debug |
| `raw_google_output_ig.jsonl` | Phase 1a / 1b | Phase 2 |
| `id_filter_ig.jsonl` | Phase 2 | Phase 3a / 3b / 3c |
| `total_vids_ig.jsonl` | Phase 3 | Phase 2 (dedup), Phase 4 |
| `viral_posts_ig.jsonl` | Phase 3 (scored posts) | Phase 4 |
| `hashtag_ig.json` | Phase 4 | Dashboard / frontend |

---

## Installation & Setup

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9 (workspaces)

### Install

```bash
# From the monorepo root
npm install

# Install Playwright browsers (one-time)
npx playwright install chromium
```

### Environment variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Key variables for the Instagram pipeline:

```dotenv
# Viral scoring thresholds
MAX_VIDEO_AGE_DAYS=1
VIRAL_SCORE_THRESHOLD=90

# Phase 1b — Serper Google search (comma-separated keys for rotation)
SERPER_API_KEYS=your_key_1,your_key_2

# Phase 3c — RapidAPI Instagram enricher
RAPID_API_IG_HOST=instagram-scraper-api2.p.rapidapi.com
RAPID_API_IG_KEYS=your_rapidapi_key
```

---

## Usage

### Step 0 — Capture an Instagram session cookie

Run once before Phase 3a/3b. A real Chromium window will open; log in manually, then press Enter in the terminal.

```bash
npx tsx crawler/instagram/get_instagram_cookie.ts
```

The session is saved to `data/instagram/cookie.json`.

---

### Phase 1 — Discover Instagram Reel IDs

**Option A — Playwright Google scraper** (no API key, uses browser automation + noCaptcha AI extension):

```bash
npx tsx crawler/instagram/gg-advanced-search-scraper.ts
```

**Option B — Serper API** (requires `SERPER_API_KEYS` in `.env`):

```bash
npx tsx crawler/instagram/serper-search.ts
```

Both write discovered IDs to `data/instagram/raw_google_output_ig.jsonl`.

---

### Phase 2 — Filter & deduplicate

Removes IDs already present in `total_vids_ig.jsonl` and writes the remaining queue:

```bash
npx tsx crawler/instagram/filter-google-ids-ig.ts
```

Output: `data/instagram/id_filter_ig.jsonl`

---

### Phase 3 — Enrich with full metadata

Choose one enrichment strategy:

**3a — Native fetch (fastest, requires `cookie.json`):**

```bash
# Optional: control concurrency
CONCURRENCY=3 npx tsx crawler/instagram/crawl_instagram_via_private_api.ts
```

**3b — Playwright browsers (most reliable, uses 5 parallel browser workers):**

```bash
npx tsx crawler/instagram/detail-playwright.ts
```

**3c — RapidAPI (no session cookie needed, requires `RAPID_API_IG_KEYS`):**

```bash
npx tsx crawler/instagram/rapid-instagram.ts
```

All three write to `data/instagram/total_vids_ig.jsonl` and `viral_posts_ig.jsonl`.

---

### Phase 4 — Extract trending hashtags

```bash
npx tsx crawler/instagram/extract_hashtags.ts
```

Output: `data/instagram/hashtag_ig.json` — up to 80 ranked, deduplicated hashtags.

---

### Debug tool

Navigates to a single reel and logs every JSON response from Instagram to help identify which API endpoint carries which fields:

```bash
npx tsx crawler/instagram/debug-network.ts
```

Edit the `TEST_SHORTCODE` constant inside the file to target a different reel.

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `MAX_VIDEO_AGE_DAYS` | `1` | Maximum post age (days) to be considered for viral scoring |
| `VIRAL_SCORE_THRESHOLD` | `90` | Minimum score (0–100) to write to `viral_posts_ig.jsonl` |
| `SERPER_API_KEYS` | — | Comma-separated Serper API keys (key rotation supported) |
| `SERPER_NUM` | `100` | Results per Serper page |
| `SERPER_DELAY_MS` | `500` | Delay between Serper requests (ms) |
| `SERPER_MAX_PAGES` | `2` | Pages to fetch per query |
| `RAPID_API_IG_HOST` | `instagram-scraper-api2.p.rapidapi.com` | RapidAPI host |
| `RAPID_API_IG_KEYS` | — | Comma-separated RapidAPI keys |
| `RAPID_CONCURRENCY` | `1` | Concurrent RapidAPI workers |
| `RAPID_DELAY_MS` | `2000` | Delay between RapidAPI calls (ms) |
| `CONCURRENCY` | `1` | Workers for the native fetch enricher (Phase 3a) |

---

## Notes

- **`saves` and `shares` fields** are always `0` — Instagram's API does not expose these metrics to third-party sessions.
- **Session cookies expire** — re-run `get_instagram_cookie.ts` when enrichment starts returning 401/403 errors.
- **Rate limiting** — all enrichment scripts include random delays between requests to avoid triggering Instagram's anti-bot systems. Do not remove these delays.
- **Browser profiles** — each Playwright worker uses an isolated persistent profile under `data/user_data_ig_worker_<N>/`. These directories are git-ignored and can be deleted to reset browser state.
