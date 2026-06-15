// Pure types, constants and helpers shared by the app (no React, no component state).

export type MemoMeta = { id: number; title: string; updated_at: number };
export type Memo = MemoMeta & { content: string; created_at: number };
export type LoginResult = { ok: boolean; status?: number };

// localStorage / IndexedDB key prefixes
export const DRAFT = "qm-draft-"; // unsynced edits (IndexedDB)
export const CONTENT_CACHE = "qm-cache-"; // last-seen server content per memo (IndexedDB, offline read)
export const TEMPS_KEY = "qm-temps"; // local-only memos not yet pushed to the server (localStorage)
export const LIST_CACHE = "qm-memos"; // cached server list for offline viewing (localStorage)

// the repo's pull-requests page — the GitHub icon in the top bar links straight here
export const GITHUB_PULLS_URL = "https://github.com/roeniss/nemo/pulls";

export const NEW_DOC = "# "; // every new memo opens with the title heading ready to type
export const PREVIEW_DEBOUNCE = 200; // recompute the rendered preview this long after a keystroke
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

// the filter-badge keyword for a title: its first word, lowercased. A "word" is
// the first run of letters/digits in any script (Korean, Latin, …); spaces,
// hyphens, underscores and other punctuation delimit it. "" when the title has
// no word characters at all (those memos get no badge).
//   "todo - 피아노 고르기"                 -> "todo"
//   "learning-rosetta-only-x86-to-arm.md" -> "learning"
//   "이희승 발표 - is java alive or dead"  -> "이희승"
export const keywordOf = (title: string): string =>
  title.match(/[\p{L}\p{N}]+/u)?.[0].toLowerCase() ?? "";

// distinct keywords across the given memos, alphabetically sorted (locale-aware
// so Korean and Latin interleave sensibly). Drives the badge bar. The
// "untitled" placeholder (blank/new memos) is excluded — it isn't a real tag.
export const keywordsOf = (memos: MemoMeta[]): string[] =>
  [...new Set(memos.map((m) => keywordOf(m.title)))]
    .filter((k) => k && k !== "untitled")
    .sort((a, b) => a.localeCompare(b));

// a memo holding only a heading marker (the "# " we prefill) counts as empty,
// so an untouched new memo is still auto-purged on leave
export const isBlank = (content: string) => content.replace(/^#+\s*/, "").trim() === "";

// 0-based source line of the caret, used to map the editor position onto the
// rendered block carrying the matching data-source-line.
export const caretLine = (value: string, caret: number) =>
  value.slice(0, caret).split("\n").length - 1;

// how far to scroll a viewport (of viewportH px) so a block at offset `top`
// within it, of height `blockH`, ends up vertically centered. Returns a delta
// to add to the current scrollTop; the browser clamps it into range.
export const centerDelta = (top: number, blockH: number, viewportH: number) =>
  top - (viewportH - blockH) / 2;

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
