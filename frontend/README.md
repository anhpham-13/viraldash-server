# ViralScope — Frontend Dashboard

Next.js 14 dashboard UI for the ViralScope monorepo. Reads data exclusively from the backend API (`/api/*`) — no direct MongoDB or filesystem access.

---

## Stack

- **Next.js 14** (App Router)
- **React 18** + TypeScript
- **Tailwind CSS v4**
- **shadcn/ui** component primitives (Card, Badge, Sheet, Select, etc.)
- **date-fns** for time formatting
- **Lucide React** icons

---

## Setup

```bash
# From project root — installs all workspace deps including frontend
npm install

# Create local env file
echo "NEXT_PUBLIC_API_URL=http://localhost:4000" > frontend/.env.local

# Dev server
npm run frontend:dev   # → http://localhost:3000
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes (prod) | Backend API base URL. In dev, requests are proxied via Next.js rewrites to avoid ngrok CORS. |

---

## Project Structure

```
frontend/src/
├── app/
│   ├── layout.tsx          Root layout (dark theme, font)
│   └── page.tsx            Main dashboard page
├── components/
│   ├── dashboard/
│   │   ├── DashboardClient.tsx   Client-side data container + platform filter
│   │   ├── KPIStrip.tsx          Top KPI cards strip
│   │   ├── ViralTable.tsx        Sortable/filterable video table
│   │   ├── VideoDrawer.tsx       Video detail side panel
│   │   └── AlertFeed.tsx         Hockey-stick & resurgence alerts
│   ├── charts/
│   │   ├── EarlySniper.tsx       Early velocity chart
│   │   ├── HashtagSurge.tsx      Trending hashtag surges
│   │   └── QuantileCurves.tsx    Score distribution curves
│   └── ui/                       shadcn primitives (card, badge, sheet, …)
├── hooks/
│   └── useTableState.ts    Table sort / filter / pagination state
└── lib/
    ├── api-client.ts       Typed HTTP client for all backend endpoints
    └── utils.ts            Utility helpers
```

---

## Key Components

### `KPIStrip`
Top strip of KPI cards. Fetches from `/api/stats`.
- Viral thresholds reference table (per-platform gate values)
- Total videos, new (snapshot_count = 1), accelerating, declining, active hashtags
- **Last Refresh** card — shows `last_refreshed_at` per platform (YouTube / TikTok / Instagram)

### `ViralTable`
Main data table. Fetches from `/api/videos` with server-side filtering and sorting.
- Columns: platform, status badge, views, likes, velocity (v/h), acceleration, viral score, age, snapshots
- Filter panel: platform, status, score/velocity/view/age/snapshot ranges, text search
- Sort on any metric column; pagination

### `VideoDrawer`
Side panel opened by clicking a table row. Fetches from `/api/videos/:id/snapshots?platform=`.
- Core metrics: views, likes, comments, saves
- Calculated analytics: engagement rate, viral velocity, acceleration, viral score
- **Snapshot Timeline** — roadmap of every data snapshot:
  - First snapshot: label "Start" + lifetime velocity at crawl time
  - Subsequent: "+Xh" elapsed since previous, delta views (green), rolling velocity, viral score
- Tags and sound info

### `AlertFeed`
Fetches from `/api/alerts`. Shows hockey-stick breakouts and resurgence signals.

### `api-client.ts`
Single source of truth for all API calls:
```typescript
api.videos(params)                       // GET /api/videos
api.videoSnapshots(platform, videoId)    // GET /api/videos/:id/snapshots
api.stats(platform?)                     // GET /api/stats
api.hashtags(platform?)                  // GET /api/hashtags
api.alerts()                             // GET /api/alerts
```

---

## Build & Deploy

```bash
npm run frontend:build   # Next.js production build
npm run frontend:start   # Start production server (:3000)
npm run frontend:lint    # ESLint check
```

For production, set `NEXT_PUBLIC_API_URL` to your deployed backend URL.
