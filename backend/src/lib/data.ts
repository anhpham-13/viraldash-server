import fs from 'fs/promises';
import path from 'path';

// DATA_DIR env lets ops point at any absolute path (Docker volume, symlink, etc.).
// Default: the sibling data/ directory when running from backend/ with `npm run dev/start`.
const DATA_DIR = path.resolve(process.env['DATA_DIR'] ?? path.join(process.cwd(), '../data'));

/**
 * Two crawler pipelines produce different field names for the same concepts:
 *
 *   Google/YouTube pipeline   │  Rapid-API/aggregator pipeline
 *   ──────────────────────────┼──────────────────────────────
 *   video_id                  │  id
 *   published_at              │  postDate
 *   view_count                │  views
 *   tags          (string[])  │  hashtags  (string[])
 *   favorites                 │  saves
 *
 * normalizeRecord resolves all aliases so every route can read a single
 * canonical field name without branching.
 */
export function normalizeRecord(v: Record<string, unknown>): Record<string, unknown> {
  return {
    ...v,
    video_id: v['video_id'] ?? v['id'] ?? null,
    published_at: v['published_at'] ?? v['postDate'] ?? null,
    view_count: v['view_count'] ?? v['views'] ?? 0,
    tags: v['tags'] ?? v['hashtags'] ?? [],
    favorites: v['favorites'] ?? v['saves'] ?? 0,
  };
}

export async function readJsonLines(fileName: string): Promise<Record<string, unknown>[]> {
  try {
    const filePath = path.join(DATA_DIR, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .reduce<Record<string, unknown>[]>((acc, line) => {
        try {
          acc.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip malformed lines silently
        }
        return acc;
      }, []);
  } catch (error) {
    console.error(`[data] readJsonLines("${fileName}") failed:`, error);
    return [];
  }
}

export async function readJson(fileName: string): Promise<unknown> {
  try {
    const filePath = path.join(DATA_DIR, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as unknown;
  } catch (error) {
    console.error(`[data] readJson("${fileName}") failed:`, error);
    return null;
  }
}

export function getAgeHours(published_at?: unknown): number {
  if (typeof published_at !== 'string' || !published_at) return 0;
  const postMs = new Date(published_at).getTime();
  const nowMs = Date.now();
  if (!Number.isFinite(postMs) || nowMs < postMs) return 0;
  return (nowMs - postMs) / 3_600_000;
}
