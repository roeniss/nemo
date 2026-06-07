import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

type MemoMeta = { id: number; title: string; updated_at: number };
type Memo = MemoMeta & { content: string; created_at: number };
type LoginResult = { ok: boolean; status?: number };

const DRAFT = "qm-draft-"; // localStorage key prefix for unsynced edits
const CONTENT_CACHE = "qm-cache-"; // last-seen server content per memo (offline read)
// public site key (build-time). Empty = widget dormant until keys are configured.
const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || "";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }) => string;
      reset: (el: HTMLElement) => void;
    };
    __cfTurnstileOnload?: () => void;
    __NEMO_SYNC_MS__?: number; // e2e seam: override the background-sync cadence
  }
}

// how often to poll for multi-session changes; e2e can slow this so the timer
// doesn't re-render mid-assertion (the focus-triggered sync still runs)
const SYNC_MS = typeof window !== "undefined" && typeof window.__NEMO_SYNC_MS__ === "number"
  ? window.__NEMO_SYNC_MS__
  : 10_000;

const TEMPS_KEY = "qm-temps"; // local-only memos not yet pushed to the server
const LIST_CACHE = "qm-memos"; // cached server list for offline viewing
const NEW_DOC = "# "; // every new memo opens with the title heading ready to type
const SAVE_DEBOUNCE = 300; // save this long after the last keystroke (idle)
const SAVE_MAX_WAIT = 2000; // ...but at least this often during continuous typing

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return res;
}

function titleFrom(content: string): string {
  const line = content.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || "Untitled";
}
// a memo holding only a heading marker (the "# " we prefill) counts as empty,
// so an untouched new memo is still auto-purged on leave
const isBlank = (content: string) => content.replace(/^#+\s*/, "").trim() === "";
// memo id encoded in the URL hash (#123 / #-123 for temps); null when absent
function hashId(): number | null {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const n = Number(h);
  return Number.isInteger(n) && n !== 0 ? n : null;
}
function readList(key: string): MemoMeta[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function writeList(key: string, v: MemoMeta[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // metadata cache is best-effort; never crash a save over it
  }
}
const byRecent = (a: MemoMeta, b: MemoMeta) => b.updated_at - a.updated_at;

export default function App() {
  // optimistic: render immediately based on last-known auth (httpOnly cookie
  // can't be read by JS), then reconcile with the background check below.
  const [authed, setAuthed] = useState<boolean>(
    () => localStorage.getItem("qm-authed") === "1"
  );
  const [loading, setLoading] = useState(true);
  const [memos, setMemos] = useState<MemoMeta[]>([]);
  const [trash, setTrash] = useState<MemoMeta[]>([]);
  const [view, setView] = useState<"memos" | "trash">("memos");
  const [query, setQuery] = useState("");
  const [undo, setUndo] = useState<{ id: number; title: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedAt = useRef(0); // updated_at of the currently open memo (for sync)
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [deleted, setDeleted] = useState(false); // open memo was trashed elsewhere
  const deletedRef = useRef(false);
  // memos created this session that have never held content (auto-purged on leave)
  const freshIds = useRef<Set<number>>(new Set());
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 640); // closed by default on mobile
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveAt = useRef(0); // for the max-wait save guarantee
  const inFlight = useRef(false); // one server save at a time (avoids self-conflict)
  const pendingSave = useRef<{ id: number; value: string } | null>(null);
  const materializing = useRef(false); // guard against double-pushing temp memos
  // latest values for the beforeunload handler (avoids stale closure)
  const contentRef = useRef(content);
  contentRef.current = content;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const focusOnOpen = useRef(false); // focus the editor after the next new memo opens
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker for text import
  const [notice, setNotice] = useState<string | null>(null); // transient toast (import status)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // a large file held back for confirmation before loading it into the body
  const [pendingImport, setPendingImport] = useState<{ text: string; name: string; size: number } | null>(null);
  const quotaWarned = useRef(false); // dedupe the "localStorage full" toast
  // always-latest openMemo, so the hashchange listener (registered once) never
  // calls a stale closure
  const openMemoRef = useRef<(id: number) => void>(() => {});

  // background auth check + list — UI is already on screen; this fills it in
  useEffect(() => {
    const temps = readList(TEMPS_KEY);
    api("/memos")
      .then(async (r) => {
        if (r.status === 401) {
          localStorage.removeItem("qm-authed");
          setAuthed(false);
          setLoading(false);
          return;
        }
        localStorage.setItem("qm-authed", "1");
        setAuthed(true);
        const list = (await r.json()) as MemoMeta[];
        writeList(LIST_CACHE, list);
        const merged = [...temps, ...list].sort(byRecent);
        setMemos(merged);
        setLoading(false);
        materializeTemps();
        // a URL hash points at a memo → open it (bookmark / reload / back-forward);
        // a fresh visit with no hash defaults to a new document
        const want = hashId();
        if (want != null && merged.some((m) => m.id === want)) openMemo(want);
        else newMemo();
      })
      .catch(() => {
        // offline — render cached list + local temps so the app is usable
        const merged = [...temps, ...readList(LIST_CACHE)].sort(byRecent);
        setMemos(merged);
        setOffline(true);
        setLoading(false);
        // open the hashed memo if we have its content locally, else a new document
        const want = hashId();
        if (
          want != null &&
          merged.some((m) => m.id === want) &&
          (want < 0 ||
            localStorage.getItem(DRAFT + want) != null ||
            localStorage.getItem(CONTENT_CACHE + want) != null)
        ) {
          openMemo(want);
        } else {
          newMemo(); // creates a local temp while offline
        }
      });
  }, []);

  // reflect the open memo in the URL so each memo is its own page (bookmarkable,
  // reloadable, back/forward-navigable). Covers both openMemo and newMemo since
  // both set currentId; a no-op when the hash already matches (e.g. arriving here
  // via a hashchange) so it never pushes a duplicate history entry.
  const navStarted = useRef(false);
  useEffect(() => {
    // skip the initial mount: currentId is null here, but a boot hash (#id) must
    // survive for the async load effect to deep-link to it — don't strip it.
    if (!navStarted.current) {
      navStarted.current = true;
      return;
    }
    if (currentId == null) {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    } else if (hashId() !== currentId) {
      location.hash = String(currentId);
    }
  }, [currentId]);

  // back/forward (or an edited URL) → open that memo
  useEffect(() => {
    function onHash() {
      const id = hashId();
      if (id != null && id !== currentIdRef.current) openMemoRef.current(id);
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // when a new memo opens, drop the cursor right after the prefilled "# "
  useEffect(() => {
    if (focusOnOpen.current && editorRef.current) {
      focusOnOpen.current = false;
      const el = editorRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [currentId]);

  async function login(
    username: string,
    password: string,
    turnstileToken: string
  ): Promise<LoginResult> {
    const r = await api("/login", {
      method: "POST",
      body: JSON.stringify({ username, password, turnstileToken }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    localStorage.setItem("qm-authed", "1");
    setAuthed(true);
    const list = (await (await api("/memos")).json()) as MemoMeta[];
    setMemos(list);
    setLoading(false);
    newMemo(); // land in a fresh document, ready to write
    return { ok: true };
  }

  async function logout() {
    await leaveCurrent();
    await api("/logout", { method: "POST" });
    localStorage.removeItem("qm-authed");
    setAuthed(false);
    setMemos([]);
    setCurrentId(null);
    setContent("");
  }

  // run any pending debounced save immediately
  async function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      if (currentId != null) await save(currentId, content);
    }
  }

  // leaving the current memo: purge it if it's a never-used empty memo,
  // otherwise flush any pending save
  async function leaveCurrent() {
    const id = currentIdRef.current;
    if (id != null && freshIds.current.has(id) && isBlank(content)) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      freshIds.current.delete(id);
      if (id < 0) {
        // unsynced empty temp — drop it locally
        writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((t) => t.id !== id));
        localStorage.removeItem(DRAFT + id);
      } else {
        try {
          await api(`/memos/${id}?purge=1`, { method: "DELETE" });
        } catch {
          // offline — leave the empty row; it can be cleaned up later
        }
      }
      setMemos((ms) => ms.filter((x) => x.id !== id));
      return;
    }
    await flush();
  }

  async function openMemo(id: number) {
    await leaveCurrent();
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
    setPendingImport(null);
    lastSaveAt.current = Date.now();
    setCurrentId(id);

    // stale-while-revalidate: show local content INSTANTLY (no network wait),
    // draft beats cache; then revalidate against the server in the background
    const draft = localStorage.getItem(DRAFT + id);
    const local = draft ?? (id < 0 ? "" : localStorage.getItem(CONTENT_CACHE + id) ?? "");
    setContent(local);
    loadedAt.current =
      (id < 0 ? readList(TEMPS_KEY) : readList(LIST_CACHE)).find((m) => m.id === id)?.updated_at ??
      0;

    if (id < 0) return; // temp memo — purely local

    try {
      const r = await api(`/memos/${id}`);
      if (!r.ok || currentIdRef.current !== id) return; // 404 / user moved on
      const memo = (await r.json()) as Memo;
      safeSet(CONTENT_CACHE + id, memo.content);
      const d = localStorage.getItem(DRAFT + id);
      if (d != null && d !== memo.content) {
        // unsynced local edit — keep it and push
        loadedAt.current = memo.updated_at;
        save(id, d);
      } else {
        // adopt server content only if it changed and the user isn't mid-edit
        if (timer.current == null && d == null && memo.content !== local) {
          setContent(memo.content);
        }
        loadedAt.current = memo.updated_at;
      }
    } catch {
      setOffline(true); // offline — keep the instantly-shown local content
    }
  }
  openMemoRef.current = openMemo;

  async function newMemo() {
    await leaveCurrent();
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
    setPendingImport(null);
    lastSaveAt.current = Date.now();
    try {
      const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
      setMemos((m) => [{ id: memo.id, title: memo.title, updated_at: memo.updated_at }, ...m]);
      setCurrentId(memo.id);
      setContent(NEW_DOC);
      loadedAt.current = memo.updated_at;
      freshIds.current.add(memo.id);
      focusOnOpen.current = true;
    } catch {
      // offline — create a local temp memo (negative id) that syncs on reconnect
      const id = -Date.now();
      const meta = { id, title: "Untitled", updated_at: Date.now() };
      writeList(TEMPS_KEY, [meta, ...readList(TEMPS_KEY)]);
      localStorage.setItem(DRAFT + id, NEW_DOC);
      setMemos((m) => [meta, ...m]);
      setCurrentId(id);
      setContent(NEW_DOC);
      loadedAt.current = meta.updated_at;
      freshIds.current.add(id);
      focusOnOpen.current = true;
      setOffline(true);
    }
  }

  // push local temp memos to the server (on reconnect / focus / poll)
  async function materializeTemps() {
    if (materializing.current) return; // POSTs fail-fast if actually offline
    materializing.current = true;
    try {
      for (const t of readList(TEMPS_KEY)) {
        const body = localStorage.getItem(DRAFT + t.id) ?? "";
        if (isBlank(body)) continue; // skip empties (purged or filled later)
        try {
          const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
          await api(`/memos/${memo.id}`, {
            method: "PUT",
            body: JSON.stringify({ content: body }),
          });
          writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((x) => x.id !== t.id));
          localStorage.removeItem(DRAFT + t.id);
          safeSet(CONTENT_CACHE + memo.id, body); // cache for offline read
          const real = { id: memo.id, title: titleFrom(body), updated_at: Date.now() };
          setMemos((m) =>
            [real, ...m.filter((x) => x.id !== t.id && x.id !== memo.id)].sort(byRecent)
          );
          if (currentIdRef.current === t.id) {
            setCurrentId(memo.id);
            loadedAt.current = real.updated_at;
          }
        } catch {
          break; // still offline — try again later
        }
      }
    } finally {
      materializing.current = false;
    }
  }

  async function deleteMemo(id: number) {
    const m = memos.find((x) => x.id === id);
    if (id < 0) {
      // unsynced temp — drop locally, nothing to trash/undo
      writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((t) => t.id !== id));
      localStorage.removeItem(DRAFT + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setContent("");
      }
      return;
    }
    try {
      await api(`/memos/${id}`, { method: "DELETE" });
    } catch {
      setOffline(true);
    }
    localStorage.removeItem(CONTENT_CACHE + id);
    localStorage.removeItem(DRAFT + id);
    setMemos((ms) => ms.filter((x) => x.id !== id));
    if (currentId === id) {
      setCurrentId(null);
      setContent("");
    }
    setUndo({ id, title: m?.title || "Untitled" });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  }

  async function undoDelete() {
    if (!undo) return;
    const id = undo.id;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
    await api(`/memos/${id}/restore`, { method: "POST" });
    setMemos((await (await api("/memos")).json()) as MemoMeta[]);
  }

  async function loadTrash() {
    setTrash((await (await api("/trash")).json()) as MemoMeta[]);
  }

  async function restoreMemo(id: number) {
    await api(`/memos/${id}/restore`, { method: "POST" });
    setTrash((t) => t.filter((x) => x.id !== id));
    setMemos((await (await api("/memos")).json()) as MemoMeta[]);
  }

  // permanently hide a trashed memo from view — the row stays in the DB,
  // it's just excluded from the trash listing server-side
  async function hideTrash(id: number) {
    await api(`/memos/${id}/hide`, { method: "POST" });
    setTrash((t) => t.filter((x) => x.id !== id));
  }

  function onEdit(value: string) {
    setContent(value);
    if (currentId == null) return;
    // local-first: persist to localStorage immediately, before any network call
    safeSet(DRAFT + currentId, value);
    if (conflictRef.current || deletedRef.current) return; // resolve banner first; don't autosave
    if (timer.current) clearTimeout(timer.current);
    setSaving(true);
    // debounce on idle, but cap so a save still happens at least every SAVE_MAX_WAIT
    // even while typing non-stop
    const since = Date.now() - lastSaveAt.current;
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE, SAVE_MAX_WAIT - since));
    timer.current = setTimeout(() => {
      timer.current = null; // debounce fired — no edit pending (keeps the guard honest)
      save(currentId, value);
    }, delay);
  }

  // brief bottom toast, auto-dismissed
  function flash(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }

  // free localStorage space by dropping content caches — these are disposable
  // (the server holds the original; they only speed up offline reads). Never
  // touches qm-draft-* (unsynced edits) or the list/temp metadata.
  function evictCaches(keep?: string): number {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CONTENT_CACHE) && k !== keep) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
    return drop.length;
  }

  // localStorage.setItem that survives QuotaExceededError: evict disposable
  // caches and retry once; if it still won't fit (the value itself is too big),
  // give up gracefully — the content stays in memory and still saves to the
  // server, so nothing is lost while online.
  function safeSet(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      quotaWarned.current = false;
      return true;
    } catch {
      evictCaches(CONTENT_CACHE + currentIdRef.current); // keep the open memo's cache
      try {
        localStorage.setItem(key, value);
        quotaWarned.current = false;
        return true;
      } catch {
        if (!quotaWarned.current) {
          quotaWarned.current = true;
          flash("로컬 저장 공간이 가득 찼어요 — 서버에는 저장됩니다.");
        }
        return false;
      }
    }
  }

  // known text file extensions — used alongside the MIME type and a NUL-byte
  // sniff to keep binaries out
  const TEXT_EXT =
    /\.(txt|text|md|markdown|mdown|csv|tsv|json|jsonc|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|php|sh|bash|zsh|sql|svg|diff|patch|gitignore)$/i;

  const IMPORT_CONFIRM_BYTES = 100 * 1024; // ask before loading a file this big into the body

  // import a text file into the current memo. Files over IMPORT_CONFIRM_BYTES are
  // held back behind a confirmation banner first (pendingImport → confirmImport).
  async function importFile(file: File | null | undefined) {
    if (!file) return;
    const looksText =
      file.type.startsWith("text/") ||
      file.type === "application/json" ||
      file.type === "image/svg+xml" ||
      file.type === "" || // many text files report no MIME
      TEXT_EXT.test(file.name);
    let text: string;
    try {
      text = await file.text();
    } catch {
      flash("파일을 읽지 못했어요.");
      return;
    }
    if (!looksText || text.includes("\u0000")) {
      flash("텍스트 파일만 업로드할 수 있어요.");
      return;
    }
    if (currentIdRef.current == null) return; // a memo is always open (new-doc default)
    if (file.size > IMPORT_CONFIRM_BYTES) {
      setPendingImport({ text, name: file.name, size: file.size }); // confirm before loading
      return;
    }
    applyImport(text, file.name);
  }

  // load imported text: into a blank memo it becomes the body with the file name
  // as the title heading ("# tmp.txt"); otherwise it's inserted at the cursor
  function applyImport(text: string, name: string) {
    const el = editorRef.current;
    const blank = isBlank(content);
    let next: string;
    let caret: number;
    if (blank) {
      next = `# ${name}\n\n${text}`;
      caret = next.length;
    } else {
      const start = el ? el.selectionStart : content.length;
      const end = el ? el.selectionEnd : content.length;
      next = content.slice(0, start) + text + content.slice(end);
      caret = start + text.length;
    }
    onEdit(next); // same path as typing → autosave + localStorage (sets quotaWarned on overflow)
    requestAnimationFrame(() => {
      const e2 = editorRef.current;
      if (e2) {
        e2.focus();
        e2.setSelectionRange(caret, caret);
      }
    });
    // keep safeSet's "storage full" warning visible instead of masking it with success
    if (!quotaWarned.current) {
      const size = text.length < 1024 ? `${text.length} B` : `${Math.round(text.length / 1024)} KB`;
      flash(`Imported "${name}" (${size})`);
    }
  }

  // user accepted the large-import confirmation
  function confirmImport() {
    if (!pendingImport) return;
    const { text, name } = pendingImport;
    setPendingImport(null);
    applyImport(text, name);
  }

  // download the current memo as a .md file (named after its title)
  function downloadMemo() {
    if (currentId == null) return;
    const name = (titleFrom(content) || "memo").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function save(id: number, value: string) {
    if (!isBlank(value)) freshIds.current.delete(id); // now has content — keep it
    safeSet(DRAFT + id, value); // local-first

    if (id < 0) {
      // temp memo — local only, never hits the server until materialized
      const title = titleFrom(value);
      const now = Date.now();
      writeList(TEMPS_KEY, readList(TEMPS_KEY).map((t) => (t.id === id ? { ...t, title, updated_at: now } : t)));
      setMemos((m) => m.map((x) => (x.id === id ? { ...x, title, updated_at: now } : x)));
      if (id === currentIdRef.current) {
        loadedAt.current = now;
        lastSaveAt.current = now;
      }
      setSaving(false);
      return;
    }

    // serialize server saves: a second save while one is in flight would send a
    // stale base and the server would flag our own prior write as a conflict
    if (inFlight.current) {
      pendingSave.current = { id, value };
      return;
    }
    inFlight.current = true;
    try {
      const r = await api(`/memos/${id}`, {
        method: "PUT",
        body: JSON.stringify({ content: value, base: loadedAt.current }),
      });
      if (r.status === 409) {
        // genuinely changed in another session — let the user choose
        conflictRef.current = true;
        setConflict(true);
        setSaving(false);
        return;
      }
      if (r.status === 404) {
        // trashed in another session — DON'T drop the draft (returning early
        // skips the removeItem below); let the user recover or discard it
        deletedRef.current = true;
        setDeleted(true);
        setSaving(false);
        return;
      }
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      localStorage.removeItem(DRAFT + id); // synced — drop the local draft
      safeSet(CONTENT_CACHE + id, value); // cache for offline read
      setOffline(false);
      setMemos((m) => [{ id, title, updated_at }, ...m.filter((x) => x.id !== id)].sort(byRecent));
      if (id === currentIdRef.current) {
        loadedAt.current = updated_at;
        lastSaveAt.current = Date.now();
      }
      setSaving(false);
    } catch {
      // network failure — the draft in localStorage is the safety net; retry later
      setOffline(true);
      setSaving(false);
    } finally {
      inFlight.current = false;
      if (pendingSave.current) {
        const p = pendingSave.current;
        pendingSave.current = null;
        save(p.id, p.value); // now uses the freshly-updated base
      }
    }
  }

  // recover after a network blip: push unsynced work and clear the offline flag
  // the moment the server is reachable again — independent of the flaky `online`
  // event / navigator.onLine, and even when there is no draft to push
  async function recover() {
    if (conflictRef.current || deletedRef.current) return;
    await materializeTemps();
    const id = currentIdRef.current;
    if (id != null && id > 0) {
      const d = localStorage.getItem(DRAFT + id);
      if (d != null) {
        await save(id, d); // clears `offline` on success
        return;
      }
    }
    // nothing pending — confirm connectivity and clear the banner
    try {
      if ((await api("/me")).ok) setOffline(false);
    } catch {
      // still offline
    }
  }

  // conflict resolution
  async function reloadCurrent() {
    const id = currentIdRef.current;
    if (id == null) return;
    const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
    setContent(memo.content);
    loadedAt.current = memo.updated_at;
    conflictRef.current = false;
    setConflict(false);
  }

  async function overwrite() {
    const id = currentIdRef.current;
    if (id == null) return;
    conflictRef.current = false;
    setConflict(false);
    // no base → force overwrite
    const r = await api(`/memos/${id}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
    const { updated_at } = (await r.json()) as { updated_at: number };
    loadedAt.current = updated_at;
  }

  // memo was trashed elsewhere — save the on-screen content as a brand-new memo
  async function recoverAsNew() {
    const id = currentIdRef.current;
    if (id == null) return;
    const body = content;
    deletedRef.current = false;
    setDeleted(false);
    // drop the orphaned (trashed) memo locally and create a fresh one
    freshIds.current.delete(id);
    localStorage.removeItem(DRAFT + id);
    localStorage.removeItem(CONTENT_CACHE + id);
    setMemos((ms) => ms.filter((x) => x.id !== id));
    try {
      const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
      const r = await api(`/memos/${memo.id}`, { method: "PUT", body: JSON.stringify({ content: body }) });
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      safeSet(CONTENT_CACHE + memo.id, body);
      setMemos((m) => [{ id: memo.id, title, updated_at }, ...m.filter((x) => x.id !== memo.id)].sort(byRecent));
      setCurrentId(memo.id); // currentId → hash effect points the URL at the new memo
      setContent(body);
      loadedAt.current = updated_at;
    } catch {
      setOffline(true); // the draft for the new memo is the local safety net
    }
  }

  // memo was trashed elsewhere and the user doesn't want it back — drop it
  function discardDeleted() {
    const id = currentIdRef.current;
    deletedRef.current = false;
    setDeleted(false);
    if (id != null) {
      freshIds.current.delete(id);
      localStorage.removeItem(DRAFT + id);
      localStorage.removeItem(CONTENT_CACHE + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
    }
    setCurrentId(null); // currentId → hash effect clears the URL
    setContent("");
  }

  // periodic multi-session sync: refresh the list, and reload the open memo if
  // it was changed elsewhere (but never while the user has unsaved local edits)
  useEffect(() => {
    if (!authed) return;
    async function sync() {
      if (document.hidden) return;
      recover(); // push any unsynced offline edits / temp memos, clear offline
      const r = await api("/memos").catch(() => null);
      if (!r || !r.ok) return;
      setOffline(false); // reached the server — definitely online
      const list = (await r.json()) as MemoMeta[];
      writeList(LIST_CACHE, list);
      setMemos([...readList(TEMPS_KEY), ...list].sort(byRecent)); // keep local temps visible
      const id = currentIdRef.current;
      if (id == null || id < 0 || timer.current != null || conflictRef.current || deletedRef.current) return; // skip temp / mid-edit / conflict / deleted
      if (localStorage.getItem(DRAFT + id) != null) return; // unsynced local draft pending
      const cur = list.find((x) => x.id === id);
      if (cur && cur.updated_at > loadedAt.current) {
        const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
        safeSet(CONTENT_CACHE + id, memo.content);
        if (timer.current == null && currentIdRef.current === id) {
          setContent(memo.content);
          loadedAt.current = memo.updated_at;
        }
      } else if (!cur) {
        // the open memo dropped out of the list — it may have been trashed
        // elsewhere, or this list just predates a memo we created. Confirm with
        // a direct fetch (404 = really gone) before raising the banner, so a
        // freshly-created memo isn't mistaken for a deleted one.
        const probe = await api(`/memos/${id}`).catch(() => null);
        if (probe && probe.status === 404 && currentIdRef.current === id && timer.current == null) {
          deletedRef.current = true;
          setDeleted(true);
        }
      }
    }
    const iv = setInterval(sync, SYNC_MS);
    window.addEventListener("focus", sync);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", sync);
    };
  }, [authed]);

  // Cmd/Ctrl+S: flush pending debounce and save immediately
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (currentId != null) {
          setSaving(true);
          save(currentId, content);
        }
      } else if (k === "k") {
        // new memo — newMemo() flushes the in-progress memo first
        e.preventDefault();
        newMemo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, content]);

  // flush pending save on tab close / reload (keepalive survives unload)
  useEffect(() => {
    function onUnload() {
      const id = currentIdRef.current;
      if (id == null || id < 0) return; // temp memos already live in localStorage
      if (freshIds.current.has(id) && isBlank(contentRef.current)) {
        fetch(`/api/memos/${id}?purge=1`, { method: "DELETE", keepalive: true });
      } else if (timer.current) {
        fetch(`/api/memos/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: contentRef.current }),
          keepalive: true,
        });
      }
    }
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // recover the moment the browser reports the network is back
  useEffect(() => {
    window.addEventListener("online", recover);
    return () => window.removeEventListener("online", recover);
  }, []);

  // ...but don't trust that event: while offline, poll faster to auto-recover
  useEffect(() => {
    if (!offline) return;
    const iv = setInterval(recover, 3000);
    return () => clearInterval(iv);
  }, [offline]);

  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content) as string), [content]);
  const visibleMemos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? memos.filter((m) => m.title.toLowerCase().includes(q)) : memos;
  }, [memos, query]);
  const visibleMemosRef = useRef(visibleMemos);
  visibleMemosRef.current = visibleMemos;

  // Alt+K / Alt+J: jump to the previous / next memo in the visible list (vim-style).
  // Uses e.code (physical key) because macOS Option+letter composes a special
  // character into e.key; preventDefault also stops that character being typed.
  // Reads current id/list from refs (not effect deps) so a keypress right after a
  // jump never hits a stale handler before the effect re-registers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.code !== "KeyK" && e.code !== "KeyJ") return;
      e.preventDefault();
      const list = visibleMemosRef.current;
      if (!list.length) return;
      const down = e.code === "KeyJ"; // J = next (down the list), K = previous (up)
      const idx = list.findIndex((m) => m.id === currentIdRef.current);
      const next = idx === -1 ? (down ? 0 : list.length - 1) : idx + (down ? 1 : -1);
      if (next < 0 || next >= list.length) return; // clamp at the ends
      const target = list[next];
      if (target && target.id !== currentIdRef.current) openMemoRef.current(target.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!authed) return <Login onLogin={login} />;

  return (
    <div className="app">
      {sidebar && (
        <aside className="sidebar">
          <div className="side-head">
            <button onClick={newMemo}>+ New</button>
            <button className="ghost" onClick={logout}>
              Logout
            </button>
          </div>
          <div className="side-tabs">
            <button
              className={view === "memos" ? "tab active" : "tab"}
              onClick={() => setView("memos")}
            >
              Memos
            </button>
            <button
              className={view === "trash" ? "tab active" : "tab"}
              onClick={() => {
                setView("trash");
                loadTrash();
              }}
            >
              Trash
            </button>
          </div>

          {view === "memos" ? (
            <>
              <input
                className="search"
                placeholder="Search title…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              <ul className="memo-list">
                {visibleMemos.map((m) => (
                  <li
                    key={m.id}
                    className={m.id === currentId ? "active" : ""}
                    onClick={() => openMemo(m.id)}
                  >
                    <span className="memo-title">{m.title || "Untitled"}</span>
                    <button
                      className="del"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMemo(m.id);
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {visibleMemos.length === 0 && (
                  <li className="empty">
                    {loading ? "Loading…" : query ? "No matches" : "No memos"}
                  </li>
                )}
              </ul>
            </>
          ) : (
            <ul className="memo-list">
              {trash.map((m) => (
                <li key={m.id}>
                  <span className="memo-title">{m.title || "Untitled"}</span>
                  <button
                    className="restore"
                    title="Restore"
                    onClick={() => restoreMemo(m.id)}
                  >
                    ↩
                  </button>
                  <button
                    className="del"
                    title="Hide"
                    onClick={() => hideTrash(m.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
              {trash.length === 0 && <li className="empty">Trash is empty</li>}
            </ul>
          )}
        </aside>
      )}

      <div className="main">
        <div className="topbar">
          <button className="ghost" onClick={() => setSidebar((s) => !s)}>
            {sidebar ? "◀" : "▶"}
          </button>
          <span className={offline ? "status offline" : "status"}>
            {offline ? "Offline — saved locally" : saving ? "Saving…" : "Saved"}
          </span>
          <div className="topbar-actions">
            <button
              className="download"
              onClick={downloadMemo}
              disabled={currentId == null}
              title="Download this memo as .md"
            >
              ⬇ .md
            </button>
            <button
              className="import"
              onClick={() => fileRef.current?.click()}
              title="Import a text file into this memo"
            >
              ⬆ Import
            </button>
            <button className="new-memo" onClick={newMemo} title="New memo (⌘K)">
              + New
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,.log,.yml,.yaml,.xml,text/*,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              importFile(e.currentTarget.files?.[0]);
              e.currentTarget.value = ""; // allow re-picking the same file
            }}
          />
        </div>

        {conflict && (
          <div className="conflict">
            <span>This memo was changed in another session.</span>
            <button onClick={reloadCurrent}>Reload</button>
            <button onClick={overwrite}>Overwrite</button>
          </div>
        )}

        {deleted && (
          <div className="conflict">
            <span>이 메모는 다른 곳에서 삭제되었습니다.</span>
            <button onClick={recoverAsNew}>새 메모로 복구</button>
            <button onClick={discardDeleted}>버리기</button>
          </div>
        )}

        {pendingImport && (
          <div className="conflict">
            <span>
              "{pendingImport.name}" ({Math.round(pendingImport.size / 1024)} KB) — 본문에 불러올까요?
            </span>
            <button onClick={confirmImport}>불러오기</button>
            <button
              onClick={() => {
                setPendingImport(null);
                flash("가져오기 취소됨");
              }}
            >
              취소
            </button>
          </div>
        )}

        {currentId == null ? (
          <div className="center">
            {loading ? "Loading…" : "Select a memo on the left, or create a new one."}
          </div>
        ) : (
          <div className="pane">
            <textarea
              ref={editorRef}
              className="editor"
              value={content}
              onChange={(e) => onEdit(e.currentTarget.value)}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); // allow drop
              }}
              onDrop={(e) => {
                const f = e.dataTransfer?.files?.[0];
                if (f) {
                  e.preventDefault(); // don't let the browser navigate to the file
                  importFile(f);
                }
              }}
              placeholder="# Title&#10;&#10;Write in markdown…  (or drop/Import a .txt/.md file)"
              spellcheck={false}
            />
            <div className="preview markdown" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </div>

      {undo && (
        <div className="toast">
          <span>Deleted "{undo.title}"</span>
          <button onClick={undoDelete}>Undo</button>
        </div>
      )}

      {notice && !undo && (
        <div className="toast">
          <span>{notice}</span>
        </div>
      )}
    </div>
  );
}

function Login({
  onLogin,
}: {
  onLogin: (u: string, p: string, token: string) => Promise<LoginResult>;
}) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const widget = useRef<HTMLDivElement>(null);

  // load + render the Turnstile widget (only when a site key is configured)
  useEffect(() => {
    if (!TURNSTILE_SITEKEY) return;
    function renderWidget() {
      if (window.turnstile && widget.current && !widget.current.hasChildNodes()) {
        window.turnstile.render(widget.current, { sitekey: TURNSTILE_SITEKEY, callback: setToken });
      }
    }
    if (window.turnstile) {
      renderWidget();
      return;
    }
    window.__cfTurnstileOnload = renderWidget;
    const id = "cf-turnstile-script";
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cfTurnstileOnload&render=explicit";
      s.async = true;
      document.head.appendChild(s);
    }
  }, []);

  async function submit(e: Event) {
    e.preventDefault();
    const res = await onLogin(u, p, token);
    if (res.ok) return;
    setMsg(
      res.status === 403
        ? "Verification failed. Please try again."
        : "Invalid username or password."
    );
    if (window.turnstile && widget.current) {
      window.turnstile.reset(widget.current);
      setToken("");
    }
  }

  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <h1>nemo</h1>
        <input placeholder="id" value={u} onChange={(e) => setU(e.currentTarget.value)} autoFocus />
        <input
          type="password"
          placeholder="password"
          value={p}
          onChange={(e) => setP(e.currentTarget.value)}
        />
        {TURNSTILE_SITEKEY && <div ref={widget} className="turnstile" />}
        <button type="submit">Login</button>
        {msg && <p className="err">{msg}</p>}
      </form>
    </div>
  );
}
