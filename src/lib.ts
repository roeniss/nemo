// Pure types, constants and helpers shared by the app (no React, no component state).

export type MemoMeta = { id: number; title: string; updated_at: number };
export type Memo = MemoMeta & { content: string; created_at: number };
export type LoginResult = { ok: boolean; status?: number };

// localStorage / IndexedDB key prefixes
export const DRAFT = "qm-draft-"; // unsynced edits (IndexedDB)
export const CONTENT_CACHE = "qm-cache-"; // last-seen server content per memo (IndexedDB, offline read)
export const TEMPS_KEY = "qm-temps"; // local-only memos not yet pushed to the server (localStorage)
export const LIST_CACHE = "qm-memos"; // cached server list for offline viewing (localStorage)

export const NEW_DOC = "# "; // every new memo opens with the title heading ready to type
export const PREVIEW_DEBOUNCE = 200; // recompute the rendered preview this long after a keystroke
export const PREVIEW_MAX = 200_000; // skip live preview above this size (too heavy to render per edit)
export const SAVE_DEBOUNCE = 300; // save this long after the last keystroke (idle)
export const SAVE_MAX_WAIT = 2000; // ...but at least this often during continuous typing

export async function api(path: string, init?: RequestInit) {
  return fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function titleFrom(content: string): string {
  const line = content.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || "Untitled";
}

// a memo holding only a heading marker (the "# " we prefill) counts as empty,
// so an untouched new memo is still auto-purged on leave
export const isBlank = (content: string) => content.replace(/^#+\s*/, "").trim() === "";

// memo id encoded in the URL hash (#123 / #-123 for temps); null when absent
export function hashId(): number | null {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const n = Number(h);
  return Number.isInteger(n) && n !== 0 ? n : null;
}

export function readList(key: string): MemoMeta[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

export function writeList(key: string, v: MemoMeta[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // metadata cache is best-effort; never crash a save over it
  }
}

export const byRecent = (a: MemoMeta, b: MemoMeta) => b.updated_at - a.updated_at;
