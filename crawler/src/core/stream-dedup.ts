import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Streaming deduplication utility
 * Reads from input file, deduplicates by ID using a bloom-filter-like approach
 * or in-memory Set (for reasonable file sizes), writes to output file
 */
export async function deduplicateJsonlStream(
  inputFile: string,
  outputFile: string,
  getKeyFn: (record: any) => string | null = (r) => r.id || r.videoId || null,
  options?: {
    maxBufferSize?: number; // Max IDs to keep in memory (default 100k)
    batchFlushSize?: number; // Write every N records
  }
): Promise<{ unique: number; duplicates: number }> {
  const maxBufferSize = options?.maxBufferSize ?? 100_000;
  const batchFlushSize = options?.batchFlushSize ?? 1000;

  const seenIds = new Set<string>();
  let uniqueCount = 0;
  let duplicateCount = 0;
  let batchBuffer: string[] = [];

  const writeStream = createWriteStream(outputFile, { encoding: "utf8" });

  return new Promise((resolve, reject) => {
    const readline = createInterface({
      input: createReadStream(inputFile, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    readline.on("line", (line) => {
      if (!line.trim()) return;

      try {
        const record = JSON.parse(line);
        const key = getKeyFn(record);

        if (!key || seenIds.has(key)) {
          duplicateCount++;
          return;
        }

        seenIds.add(key);
        uniqueCount++;
        batchBuffer.push(line);

        // Periodically flush to disk and manage memory
        if (batchBuffer.length >= batchFlushSize) {
          writeStream.write(batchBuffer.join("\n") + "\n");
          batchBuffer = [];

          // Keep memory under control: if we've seen too many unique IDs,
          // clear the set and assume further duplicates won't occur (best effort)
          if (seenIds.size > maxBufferSize) {
            console.log(
              `[stream-dedup] Buffer limit reached (${seenIds.size}). Clearing seen IDs set to free memory.`
            );
            seenIds.clear();
          }
        }
      } catch (err) {
        console.error(`[stream-dedup] Parse error on line: ${line.substring(0, 50)}...`);
      }
    });

    readline.on("close", () => {
      // Flush remaining buffer
      if (batchBuffer.length > 0) {
        writeStream.write(batchBuffer.join("\n") + "\n");
      }

      writeStream.end();
      console.log(
        `[stream-dedup] Deduplication complete: ${uniqueCount} unique, ${duplicateCount} duplicates`
      );
      resolve({ unique: uniqueCount, duplicates: duplicateCount });
    });

    readline.on("error", reject);
    writeStream.on("error", reject);
  });
}

/**
 * Merge multiple JSONL files with deduplication
 * Reads from multiple input files, deduplicates, writes to single output
 */
export async function mergeJsonlFilesWithDedup(
  inputFiles: string[],
  outputFile: string,
  getKeyFn: (record: any) => string | null = (r) => r.id || r.videoId || null,
  options?: {
    maxBufferSize?: number;
    batchFlushSize?: number;
  }
): Promise<{ unique: number; duplicates: number }> {
  const maxBufferSize = options?.maxBufferSize ?? 100_000;
  const batchFlushSize = options?.batchFlushSize ?? 1000;

  const seenIds = new Set<string>();
  let uniqueCount = 0;
  let duplicateCount = 0;
  let batchBuffer: string[] = [];

  const writeStream = createWriteStream(outputFile, { encoding: "utf8" });

  return new Promise((resolve, reject) => {
    let fileIndex = 0;
    let currentReadline: any = null;

    const processNextFile = () => {
      if (fileIndex >= inputFiles.length) {
        // All files processed
        if (batchBuffer.length > 0) {
          writeStream.write(batchBuffer.join("\n") + "\n");
        }
        writeStream.end();
        return;
      }

      const filePath = inputFiles[fileIndex];
      if (!filePath) {
        fileIndex++;
        processNextFile();
        return;
      }
      
      console.log(`[merge-dedup] Processing file ${fileIndex + 1}/${inputFiles.length}: ${filePath}`);

      currentReadline = createInterface({
        input: createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      currentReadline.on("line", (line: string) => {
        if (!line.trim()) return;

        try {
          const record = JSON.parse(line);
          const key = getKeyFn(record);

          if (!key || seenIds.has(key)) {
            duplicateCount++;
            return;
          }

          seenIds.add(key);
          uniqueCount++;
          batchBuffer.push(line);

          if (batchBuffer.length >= batchFlushSize) {
            writeStream.write(batchBuffer.join("\n") + "\n");
            batchBuffer = [];

            if (seenIds.size > maxBufferSize) {
              console.log(
                `[merge-dedup] Buffer limit (${seenIds.size}). Clearing seen IDs.`
              );
              seenIds.clear();
            }
          }
        } catch (err) {
          console.error(`[merge-dedup] Parse error: ${line.substring(0, 50)}...`);
        }
      });

      currentReadline.on("close", () => {
        fileIndex++;
        processNextFile();
      });

      currentReadline.on("error", reject);
    };

    writeStream.on("error", reject);
    writeStream.on("finish", () => {
      console.log(
        `[merge-dedup] Complete: ${uniqueCount} unique, ${duplicateCount} duplicates`
      );
      resolve({ unique: uniqueCount, duplicates: duplicateCount });
    });

    processNextFile();
  });
}

/**
 * Filter JSONL by predicate (e.g., viral score >= threshold)
 * Streams input and outputs only matching records
 */
export async function filterJsonlStream(
  inputFile: string,
  outputFile: string,
  predicateFn: (record: any) => boolean
): Promise<{ total: number; matched: number }> {
  const readStream = createReadStream(inputFile, { encoding: "utf8" });
  const writeStream = createWriteStream(outputFile, { encoding: "utf8" });

  let totalCount = 0;
  let matchedCount = 0;

  return new Promise((resolve, reject) => {
    const readline = createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });

    readline.on("line", (line) => {
      if (!line.trim()) return;

      try {
        const record = JSON.parse(line);
        totalCount++;

        if (predicateFn(record)) {
          writeStream.write(line + "\n");
          matchedCount++;
        }
      } catch (err) {
        console.error(`[filter-stream] Parse error: ${line.substring(0, 50)}...`);
      }
    });

    readline.on("close", () => {
      writeStream.end();
    });

    readline.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", () => {
      console.log(`[filter-stream] Complete: ${matchedCount}/${totalCount} records matched`);
      resolve({ total: totalCount, matched: matchedCount });
    });
  });
}
