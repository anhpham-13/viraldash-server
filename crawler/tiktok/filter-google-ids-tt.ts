import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";
import { isMain } from "../src/core/is-main.js";

const RAW_FILE = resolve(process.cwd(), "data/tiktok/raw_google_output_tt.jsonl");
const ID_FILTER_FILE = resolve(process.cwd(), "data/tiktok/id_filter_tt.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/tiktok/total_vids_tt.jsonl");

function extractVideoId(row: any): string {
  // TikTok raw output structure: { source: "google", data: { id: "..." } }
  // So the id is in row?.data?.id
  return String(row?.data?.id ?? row?.id ?? "").trim();
}

async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const filePath of [TOTAL_FILE]) {
    if (!existsSync(filePath)) continue;

    const rows = await readJsonLines<any>(filePath);
    for (const row of rows) {
      const id = String(row?.video_id ?? row?.id ?? "").trim();
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
    const id = String(row?.id ?? "").trim();
    if (id) ids.add(id);
  }

  return ids;
}

async function loadExistingIdFilterRows(existingIds: Set<string>): Promise<Array<{ id: string; url: string; author: string }>> {
  const rows: Array<{ id: string; url: string; author: string }> = [];

  if (!existsSync(ID_FILTER_FILE)) {
    return rows;
  }

  const currentRows = await readJsonLines<any>(ID_FILTER_FILE);
  for (const row of currentRows) {
    const id = String(row?.id ?? "").trim();
    if (!id) continue;
    if (existingIds.has(id)) continue;
    rows.push({
      id,
      url: row?.url || `https://www.tiktok.com/@${row?.author || "user"}/video/${id}`,
      author: row?.author || ""
    });
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

  const filtered = new Map<string, { url: string; author: string }>();

  for (const row of cleanedExistingFilterRows) {
    filtered.set(row.id, { url: row.url, author: row.author });
  }

  for (const row of rawRows) {
    const id = extractVideoId(row);
    if (!id) continue;
    if (existingIds.has(id)) continue;
    if (existingFilterIds.has(id)) continue;

    if (!filtered.has(id)) {
      const author = row?.data?.author || row?.author || "";
      const url = row?.data?.url || row?.url || `https://www.tiktok.com/@${author || "user"}/video/${id}`;
      filtered.set(id, { url, author });
    }
  }

  const output = Array.from(filtered.entries()).map(([id, info]) => ({ id, url: info.url, author: info.author }));
  await writeJsonLines(ID_FILTER_FILE, output);

  console.log(`Loaded raw rows: ${rawRows.length}`);
  console.log(`Existing ids skipped: ${existingIds.size}`);
  console.log(`Already queued ids skipped: ${existingFilterIds.size}`);
  console.log(`Cleaned existing queued rows kept: ${cleanedExistingFilterRows.length}`);
  console.log(`Unique new ids written: ${output.length}`);
  console.log(`Output: ${ID_FILTER_FILE}`);
}

if (isMain(import.meta.url)) {
  runFilterGoogleIds().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
