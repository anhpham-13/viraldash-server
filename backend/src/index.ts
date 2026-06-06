import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getDb, ensureIndexes } from '../../shared/db/index.js';
import { videosRouter }   from './routes/videos.js';
import { hashtagsRouter } from './routes/hashtags.js';
import { statsRouter }    from './routes/stats.js';
import { alertsRouter }   from './routes/alerts.js';

// ─── CORS ─────────────────────────────────────────────────────────────────────

const envOrigins = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = Array.from(
  new Set([...envOrigins, 'http://localhost:3000', 'http://localhost:3001']),
);

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use('*', logger());

app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return origin;
      return ALLOWED_ORIGINS.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    credentials:  true,
    maxAge:       86_400,
  }),
);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.route('/api/videos',   videosRouter);
app.route('/api/hashtags', hashtagsRouter);
app.route('/api/stats',    statsRouter);
app.route('/api/alerts',   alertsRouter);

// Health
app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() }),
);

// 404 catch-all
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

console.log(`[backend] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);

// Start server immediately — MongoDB errors surface per-request as 503
serve({ fetch: app.fetch, port: PORT });
console.log(`[backend] Listening on http://localhost:${PORT}`);

// MongoDB init in background — logs success or warning
getDb()
  .then(db => ensureIndexes(db))
  .then(() => console.log('[backend] MongoDB ready'))
  .catch((err: Error) => console.warn(`[backend] MongoDB unavailable: ${err.message} — routes will return 503`));
