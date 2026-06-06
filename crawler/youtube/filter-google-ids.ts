import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";

const RAW_FILE = resolve(process.cwd(), "data/youtube/raw_google_output_yt.jsonl");
const ID_FILTER_FILE = resolve(process.cwd(), "data/youtube/id_filter_yt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/youtube/total_vids_yt.jsonl");
const LEGACY_TOTAL_FILE = resolve(process.cwd(), "data/total_video.jsonl");

function extractVideoId(row: any): string {
  return String(row?.id ?? row?.videoId ?? row?.video_id ?? "").trim();
}

async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const filePath of [TOTAL_FILE, LEGACY_TOTAL_FILE]) {
    if (!existsSync(filePath)) continue;

    const rows = await readJsonLines<any>(filePath);
    for (const row of rows) {
      const id = extractVideoId(row);
      if (id) ids.add(id);
    }
  }

  return ids;
}

async function loadExistingIdFilterIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  if (!existsSync(ID_FILTER_FILE)) {
    return ids;
  }

  const rows = await readJsonLines<any>(ID_FILTER_FILE);
  for (const row of rows) {
    const id = extractVideoId(row);
    if (id) ids.add(id);
  }

  return ids;
}

async function loadExistingIdFilterRows(existingIds: Set<string>): Promise<Array<{ id: string; url: string }>> {
  const rows: Array<{ id: string; url: string }> = [];

  if (!existsSync(ID_FILTER_FILE)) {
    return rows;
  }

  const currentRows = await readJsonLines<any>(ID_FILTER_FILE);
  for (const row of currentRows) {
    const id = extractVideoId(row);
    if (!id) continue;
    if (existingIds.has(id)) continue;
    rows.push({ id, url: row?.url || `https://www.youtube.com/shorts/${id}` });
  }

  return rows;
}

export async function runFilterGoogleIds(): Promise<void> {
  if (!existsSync(RAW_FILE)) {
    throw new Error(`Raw file not found: ${RAW_FILE}`);
  }

  const existingIds = await loadExistingIds();
  const existingFilterIds = await loadExistingIdFilterIds();
  const cleanedExistingFilterRows = await loadExistingIdFilterRows(existingIds);
  const rawRows = await readJsonLines<any>(RAW_FILE);

  const filtered = new Map<string, string>();

  for (const row of cleanedExistingFilterRows) {
    filtered.set(row.id, row.url);
  }

  for (const row of rawRows) {
    const id = extractVideoId(row);
    if (!id) continue;
    if (existingIds.has(id)) continue;
    if (existingFilterIds.has(id)) continue;
    if (!filtered.has(id)) {
      filtered.set(id, row?.url || `https://www.youtube.com/shorts/${id}`);
    }
  }

  const output = Array.from(filtered.entries()).map(([id, url]) => ({ id, url }));
  await writeJsonLines(ID_FILTER_FILE, output);

  console.log(`Loaded raw rows: ${rawRows.length}`);
  console.log(`Existing ids skipped: ${existingIds.size}`);
  console.log(`Already queued ids skipped: ${existingFilterIds.size}`);
  console.log(`Cleaned existing queued rows kept: ${cleanedExistingFilterRows.length}`);
  console.log(`Unique new ids written: ${output.length}`);
  console.log(`Output: ${ID_FILTER_FILE}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("filter-google-ids.ts")) {
  runFilterGoogleIds().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

