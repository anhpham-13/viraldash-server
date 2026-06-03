"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export interface TableState {
  platform: string;
  page: number;
  limit: number;
  sort: string;
  dir: string;
  query: string;
}

// Partial update — only the keys you pass change; others are preserved in the URL.
type Patch = Partial<TableState>;

export function useTableState(): TableState & { update: (patch: Patch) => void } {
  const router = useRouter();
  const sp = useSearchParams();

  const state: TableState = {
    platform: sp.get("platform") ?? "all",
    page:     Number(sp.get("page")  ?? 1),
    limit:    Number(sp.get("limit") ?? 25),
    sort:     sp.get("sort")  ?? "viral_score",
    dir:      sp.get("dir")   ?? "desc",
    query:    sp.get("query") ?? "",
  };

  // router.replace keeps a single history entry — no back-button spam on filter changes.
  const update = useCallback(
    (patch: Patch) => {
      const params = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        // Drop keys whose value equals the default so the URL stays clean.
        if (v === "" || v === null || v === undefined) params.delete(k);
        else params.set(k, String(v));
      }
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, sp],
  );

  return { ...state, update };
}
