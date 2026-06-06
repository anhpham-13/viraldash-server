import { resolve } from "node:path";

// ─── MongoDB collection names ────────────────────────────────────────────────

export const COL = {
  VIDEOS:   "videos",
  HASHTAGS: "hashtags",
} as const;

export type CollectionName = typeof COL[keyof typeof COL];

// ─── JSONL audit log paths (append-only, không đọc lại bởi backend) ──────────
//
// Mỗi lần upsert MongoDB thành công → append 1 dòng vào audit JSONL tương ứng.
// Dùng để debug, recovery, hoặc offline analysis. Backend không đọc các file này.

const DATA_ROOT = resolve(process.cwd(), "data");

export const AUDIT = {
  YT: resolve(DATA_ROOT, "youtube/audit_yt.jsonl"),
  TT: resolve(DATA_ROOT, "tiktok/audit_tt.jsonl"),
  IG: resolve(DATA_ROOT, "instagram/audit_ig.jsonl"),
} as const;
