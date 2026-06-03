import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonLines, writeJsonLines } from "../src/core/jsonl.js";

const RAW_FILE = resolve(process.cwd(), "data/instagram/raw_google_output_ig.jsonl");
const ID_FILTER_FILE = resolve(process.cwd(), "data/instagram/id_filter_ig.jsonl");
const TOTAL_FILE = resolve(process.cwd(), "data/instagram/total_vids_ig.jsonl");

function extractPostId(row: any): string {
  return String(row?.data?.id ?? row?.id ?? "").trim();
}

async function loadExistingIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  if (!existsSync(TOTAL_FILE)) return ids;

  const rows = await readJsonLines<any>(TOTAL_FILE);
  for (const row of rows) {
    const id = String(row?.post_id ?? row?.id ?? "").trim();
    if (id) ids.add(id);
  }

  return ids;
}

async function loadExistingIdFilterIds(): Promise<Set<string>> {
  const ids = new Set<string>();

  if (!existsSync(ID_FILTER_FILE)) return ids;

  const rows = await readJsonLines<any>(ID_FILTER_FILE);
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    if (id) ids.add(id);
  }

  return ids;
}

async function loadExistingIdFilterRows(existingIds: Set<string>): Promise<Array<{ id: string; url: string }>> {
  const rows: Array<{ id: string; url: string }> = [];

  if (!existsSync(ID_FILTER_FILE)) return rows;

  const currentRows = await readJsonLines<any>(ID_FILTER_FILE);
  for (const row of currentRows) {
    const id = String(row?.id ?? "").trim();
    if (!id) continue;
    if (existingIds.has(id)) continue;
    rows.push({
      id,
      url: row?.url || `https://www.instagram.com/reel/${id}/`,
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

  const filtered = new Map<string, { url: string }>();

  for (const row of cleanedExistingFilterRows) {
    filtered.set(row.id, { url: row.url });
  }

  for (const row of rawRows) {
    const id = extractPostId(row);
    if (!id) continue;
    if (existingIds.has(id)) continue;
    if (existingFilterIds.has(id)) continue;

    if (!filtered.has(id)) {
      const url = row?.data?.url || row?.url || `https://www.instagram.com/reel/${id}/`;
      filtered.set(id, { url });
    }
  }

  const output = Array.from(filtered.entries()).map(([id, info]) => ({ id, url: info.url }));
  await writeJsonLines(ID_FILTER_FILE, output);

  console.log(`Loaded raw rows: ${rawRows.length}`);
  console.log(`Existing ids skipped: ${existingIds.size}`);
  console.log(`Already queued ids skipped: ${existingFilterIds.size}`);
  console.log(`Cleaned existing queued rows kept: ${cleanedExistingFilterRows.length}`);
  console.log(`Unique new ids written: ${output.length}`);
  console.log(`Output: ${ID_FILTER_FILE}`);
}

// ─── Entrypoint guard (standalone CLI) ───────────────────────────────────────

runFilterGoogleIds().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
