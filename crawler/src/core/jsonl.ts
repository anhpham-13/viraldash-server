import { createReadStream, promises as fs } from "node:fs";
import { dirname } from "node:path";
import * as readline from "node:readline/promises";
import type { IYouTubeVideoRaw } from "./types.js";

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

export async function appendJsonLine(filePath: string, record: IYouTubeVideoRaw): Promise<void> {
  await ensureParentDirectory(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function appendJsonLines<T>(filePath: string, records: T[]): Promise<void> {
  await ensureParentDirectory(filePath);
  const content = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  await fs.appendFile(filePath, content, "utf8");
}

export async function readJsonLines<T = unknown>(filePath: string): Promise<T[]> {
  const records: T[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      records.push(JSON.parse(trimmedLine) as T);
    }
  } finally {
    reader.close();
    stream.close();
  }

  return records;
}

export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureParentDirectory(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function writeJsonLines<T>(filePath: string, records: T[]): Promise<void> {
  await ensureParentDirectory(filePath);
  const content = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  await fs.writeFile(filePath, content, "utf8");
}
