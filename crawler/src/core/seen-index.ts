import { existsSync, promises as fs, createReadStream, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

export type SeenIndex = {
  hasOrRegister(id: string): Promise<boolean>;
  has(id: string): Promise<boolean>;
  register(id: string): Promise<void>;
  buildFromExistingFiles(filePaths: string[]): Promise<void>;
};

const MAX_SEEN_SHARDS_IN_MEMORY = Number(process.env.PHASE2_MAX_SEEN_SHARDS_IN_MEMORY ?? 16);

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export function stableShardForId(id: string, shardCount: number): number {
  const digest = createHash("sha1").update(id).digest();
  return digest.readUInt32BE(0) % shardCount;
}

export function createFileBackedSeenIndex(indexDir: string, shardCount: number, maxCachedShards = MAX_SEEN_SHARDS_IN_MEMORY): SeenIndex {
  const memoryCache = new Map<number, Set<string>>();
  const shardAccessOrder: number[] = [];

  const shardPath = (shard: number) => resolve(indexDir, `${String(shard).padStart(4, "0")}.ids`);

  function touchShard(shard: number): void {
    const existingIndex = shardAccessOrder.indexOf(shard);
    if (existingIndex >= 0) shardAccessOrder.splice(existingIndex, 1);
    shardAccessOrder.push(shard);

    while (shardAccessOrder.length > maxCachedShards) {
      const evicted = shardAccessOrder.shift();
      if (evicted !== undefined) memoryCache.delete(evicted);
    }
  }

  async function loadShard(shard: number): Promise<Set<string>> {
    const cached = memoryCache.get(shard);
    if (cached) {
      touchShard(shard);
      return cached;
    }

    const ids = new Set<string>();
    const filePath = shardPath(shard);

    if (existsSync(filePath)) {
      const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        const id = line.trim();
        if (id) ids.add(id);
      }
    }

    memoryCache.set(shard, ids);
    touchShard(shard);
    return ids;
  }

  async function appendIdToShard(shard: number, id: string): Promise<void> {
    await ensureDir(indexDir);
    await fs.appendFile(shardPath(shard), id + "\n", "utf8");
  }

  return {
    async hasOrRegister(id: string): Promise<boolean> {
      const cleanId = String(id || "").trim();
      if (!cleanId) return false;

      const shard = stableShardForId(cleanId, shardCount);
      const ids = await loadShard(shard);
      if (ids.has(cleanId)) return false;

      ids.add(cleanId);
      await appendIdToShard(shard, cleanId);
      return true;
    },

    async has(id: string): Promise<boolean> {
      const cleanId = String(id || "").trim();
      if (!cleanId) return false;
      const shard = stableShardForId(cleanId, shardCount);
      const ids = await loadShard(shard);
      return ids.has(cleanId);
    },

    async register(id: string): Promise<void> {
      const cleanId = String(id || "").trim();
      if (!cleanId) return;
      const shard = stableShardForId(cleanId, shardCount);
      const ids = await loadShard(shard);
      if (!ids.has(cleanId)) {
        ids.add(cleanId);
        await appendIdToShard(shard, cleanId);
      }
    },

    async buildFromExistingFiles(filePaths: string[]): Promise<void> {
      await ensureDir(indexDir);
      const markerPath = resolve(indexDir, ".built");
      if (existsSync(markerPath)) {
        console.log(`[seen-index] Seen index exists at ${indexDir}; skipping rebuild.`);
        return;
      }

      console.log(`[seen-index] Building file-backed seen index at ${indexDir}. This is one-time and streaming-safe.`);
      const shardStreams = new Map<number, ReturnType<typeof createWriteStream>>();
      let totalIndexed = 0;

      const getStream = (shard: number) => {
        let stream = shardStreams.get(shard);
        if (!stream) {
          stream = createWriteStream(shardPath(shard), { flags: "a", encoding: "utf8" });
          shardStreams.set(shard, stream);
        }
        return stream;
      };

      try {
        for (const filePath of filePaths) {
          if (!existsSync(filePath)) continue;
          console.log(`[seen-index] Indexing IDs from ${filePath}`);
          const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

          for await (const line of rl) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              const id = String(record.id || record.videoId || "").trim();
              if (!id) continue;

              const shard = stableShardForId(id, shardCount);
              const stream = getStream(shard);
              if (!stream.write(id + "\n")) {
                await new Promise<void>((resolve) => stream.once("drain", resolve));
              }
              totalIndexed++;
            } catch {
              // Ignore malformed historical JSONL rows while indexing IDs.
            }
          }
        }
      } finally {
        await Promise.all(Array.from(shardStreams.values()).map((stream) => new Promise<void>((resolve, reject) => {
          stream.end();
          stream.on("finish", resolve);
          stream.on("error", reject);
        })));
      }

      await fs.writeFile(markerPath, JSON.stringify({ builtAt: new Date().toISOString(), totalIndexed }) + "\n", "utf8");
      memoryCache.clear();
      shardAccessOrder.length = 0;
      console.log(`[seen-index] Seen index built. Indexed approx ${totalIndexed} IDs.`);
    },
  };
}
