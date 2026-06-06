import { MongoClient, type Db, type Collection, type Document } from "mongodb";
import { env } from "../config/env.js";

// ─── Singleton state ──────────────────────────────────────────────────────────

let _client: MongoClient | null = null;
let _db:     Db | null          = null;

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Returns the shared Db instance, connecting on first call.
 * Safe to call from multiple places — connection is created only once.
 */
export async function getDb(): Promise<Db> {
  if (_db) return _db;

  _client = new MongoClient(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS:         10_000,
    socketTimeoutMS:          45_000,
    maxPoolSize:              10,
    minPoolSize:              1,
  });

  await _client.connect();
  _db = _client.db(env.mongoDb);

  // Graceful shutdown — đăng ký một lần, tránh listener leak
  process.once("SIGINT",  () => void closeDb());
  process.once("SIGTERM", () => void closeDb());

  console.log(`[db] Connected → ${env.mongoUri}/${env.mongoDb}`);
  return _db;
}

/**
 * Closes the connection. Safe to call even if not connected.
 * Called automatically on SIGINT / SIGTERM.
 */
export async function closeDb(): Promise<void> {
  if (!_client) return;
  try {
    await _client.close();
    console.log("[db] Connection closed");
  } finally {
    _client = null;
    _db     = null;
  }
}

/**
 * Returns a typed collection from the shared Db.
 * T must match the document shape stored in MongoDB.
 *
 * @example
 *   const videos = await getCollection<VideoDocument>(COL.VIDEOS);
 */
export async function getCollection<T extends Document = Document>(
  name: string,
): Promise<Collection<T>> {
  const db = await getDb();
  return db.collection<T>(name);
}
