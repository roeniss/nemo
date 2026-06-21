import { useEffect, useMemo, useRef, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON, PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { kv, hydrate } from "./idb";
import {
  type MemoMeta,
  type Memo,
  type LoginResult,
  DRAFT,
  CONTENT_CACHE,
  TEMPS_KEY,
  LIST_CACHE,
  GITHUB_PULLS_URL,
  NEW_DOC,
  SAVE_DEBOUNCE,
  SAVE_MAX_WAIT,
  SEARCH_DEBOUNCE,
  api,
  titleFrom,
  isBlank,
  hashId,
  readList,
  writeList,
  byRecent,
  caretLine,
  centerDelta,
  keywordOf,
  keywordsOf,
} from "./lib";
import { useToast, usePreview } from "./hooks";
import { Settings } from "./Settings";
import { useImport } from "./useImport";

// public site key (build-time). Empty = widget dormant until keys are configured.
const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || "";

// resizable sidebar bounds (px); the drag clamps to this range
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;

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

export default function App() {
  // optimistic: render immediately based on last-known auth (httpOnly cookie
  // can't be read by JS), then reconcile with the background check below.
  const [authed, setAuthed] = useState<boolean>(
    () => localStorage.getItem("qm-authed") === "1"
  );
  const [loading, setLoading] = useState(true);
  const [memos, setMemos] = useState<MemoMeta[]>([]);
  const [trash, setTrash] = useState<MemoMeta[]>([]);
  const [view, setView] = useState<"memos" | "trash" | "settings">(() => {
    const h = location.hash.replace(/^#/, "");
    if (h === "settings") return "settings";
    if (h === "trash") return "trash";
    return "memos";
  });
  const [viewing, setViewing] = useState<Memo | null>(null); // trashed memo open in read-only view
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState<string | null>(null); // selected filter badge
  // server-side body-search hits, keyed by the query they belong to so a response
  // that lands after the box has moved on is simply ignored (its `q` won't match)
  const [bodyHits, setBodyHits] = useState<{ q: string; ids: Set<number> }>(
    { q: "", ids: new Set() }
  );
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
  const [published, setPublished] = useState(false); // current memo's public /p/:id state
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 640); // closed by default on mobile
  // sidebar width, drag-resizable via the handle on its right edge and persisted
  // across reloads (qm-sidebar-width). Clamp on read so a stale/garbage value
  // can't wedge the layout.
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("qm-sidebar-width"));
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT;
  });
  // a file dragged anywhere over the window shows a full-screen drop overlay so
  // it's obvious a drop will be accepted (the drop itself is handled at window level)
  const [dragging, setDragging] = useState(false);
  // theme preference: "light" | "dark" follow the explicit choice, "system"
  // tracks the OS. Stored in qm-theme; the boot script in index.html already
  // resolved it to data-theme before paint.
  const [themePref, setThemePref] = useState<"light" | "dark" | "system">(
    () => {
      const saved = localStorage.getItem("qm-theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    }
  );
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  );
  const theme: "light" | "dark" =
    themePref === "system" ? (systemDark ? "dark" : "light") : themePref;
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);
  const [admin, setAdmin] = useState(false); // surfaces the Settings admin panel (issue #66)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveAt = useRef(0); // for the max-wait save guarantee
  const inFlight = useRef(false); // one server save at a time (avoids self-conflict)
  const pendingSave = useRef<{ id: number; value: string } | null>(null);
  // a write the server may have committed but whose ack we never saw (keepalive
  // ⌘W flush, or a save whose response was lost on a flaky connection). It leaves
  // loadedAt stale, so the next save 409s against our OWN edit — this lets us tell
  // that apart from a real other-session change.
  const unacked = useRef<{ id: number; value: string } | null>(null);
  const materializing = useRef(false); // guard against double-pushing temp memos
  // latest values for the beforeunload handler (avoids stale closure)
  const contentRef = useRef(content);
  contentRef.current = content;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Scroll the desktop preview so the rendered block under the editor caret is
  // vertically centered — the preview then follows wherever you're typing,
  // instead of leaving the rendered text stranded out of view. Maps the caret's
  // source line onto the last rendered block at or before that line (tagged with
  // data-source-line by usePreview). Desktop-only: the preview is hidden on
  // mobile, where the querySelectorAll finds nothing and this is a no-op.
  function syncPreviewToCaret() {
    const ed = editorRef.current;
    const pv = previewRef.current;
    if (!ed || !pv) return;
    const line = caretLine(ed.value, ed.selectionStart);
    let target: HTMLElement | null = null;
    for (const el of pv.querySelectorAll<HTMLElement>("[data-source-line]")) {
      if (Number(el.dataset.sourceLine) <= line) target = el;
      else break;
    }
    if (!target) return;
    const top = target.getBoundingClientRect().top - pv.getBoundingClientRect().top;
    pv.scrollTop += centerDelta(top, target.clientHeight, pv.clientHeight);
  }
  const focusOnOpen = useRef(false); // focus the editor after the next new memo opens
  const didInitialFocus = useRef(false); // focus the editor once when it first mounts (#143)
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker for text import
  const { notice, flash } = useToast();
  // file import (each file → its own memo), image paste (base64 embed), and .md export
  const { importFile, pasteImage, downloadMemo } =
    useImport({ content, currentIdRef, editorRef, onEdit, flash, setMemos });
  // latest importFile for the once-registered window drop listener (same
  // ref-for-latest pattern as openMemo below)
  const importFileRef = useRef(importFile);
  importFileRef.current = importFile;
  const dragDepth = useRef(0); // nested dragenter/dragleave depth for the drop overlay
  // always-latest openMemo, so the hashchange listener (registered once) never
  // calls a stale closure. Assigned to openMemo synchronously on every render
  // (below), before any listener can fire — so .current is always set by the
  // time a listener invokes it (asserted with ! at the call sites).
  const openMemoRef = useRef<(id: number) => void>();

  // navigate to a named view, syncing both React state and the URL hash
  function navigateTo(v: "memos" | "trash" | "settings") {
    setView(v);
    if (v === "memos") {
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      location.hash = v;
    }
  }

  // background auth check + list — UI is already on screen; this fills it in
  useEffect(() => {
    let temps: MemoMeta[] = [];
    // load the IndexedDB content mirror before anything reads drafts/cache
    hydrate()
      .then(() => {
        // drop never-typed temps left by a previous session (a new memo created,
        // then the tab closed/crashed before it got any content) so blank
        // "Untitled" rows don't pile up locally
        temps = readList(TEMPS_KEY).filter((t) => !isBlank(kv.get(DRAFT + t.id) ?? ""));
        writeList(TEMPS_KEY, temps);
        return api("/memos");
      })
      .then(async (r) => {
        if (r.status === 401) {
          localStorage.removeItem("qm-authed");
          setAuthed(false);
          setLoading(false);
          return;
        }
        localStorage.setItem("qm-authed", "1");
        setAuthed(true);
        // surface whether this session is an admin so Settings can show the
        // user-management panel; failures just leave it off.
        api("/me")
          .then((me) =>
            me.ok ? (me.json() as Promise<{ uid?: number; username?: string; admin?: boolean }>) : null,
          )
          .then((d) => setAdmin(!!d?.admin))
          .catch(() => {});
        const list = (await r.json()) as MemoMeta[];
        writeList(LIST_CACHE, list);
        const merged = [...temps, ...list].sort(byRecent);
        setMemos(merged);
        setLoading(false);
        materializeTemps();
        // a URL hash points at a memo → open it (bookmark / reload / back-forward);
        // a named hash (#settings, #trash) just keeps the already-initialised view;
        // a fresh visit with no hash defaults to a new document
        const h = location.hash.replace(/^#/, "");
        const want = hashId();
        if (want != null && merged.some((m) => m.id === want)) openMemo(want);
        else if (h === "settings" || h === "trash") { /* view already set by initialiser */ }
        else newMemo();
      })
      .catch(() => {
        // offline — render cached list + local temps so the app is usable
        const merged = [...temps, ...readList(LIST_CACHE)].sort(byRecent);
        setMemos(merged);
        setOffline(true);
        setLoading(false);
        // open the hashed memo if we have its content locally, else a new document
        const hOffline = location.hash.replace(/^#/, "");
        const want = hashId();
        if (
          want != null &&
          merged.some((m) => m.id === want) &&
          (want < 0 ||
            kv.get(DRAFT + want) != null ||
            kv.get(CONTENT_CACHE + want) != null)
        ) {
          openMemo(want);
        } else if (hOffline === "settings" || hOffline === "trash") {
          // named view — keep the already-initialised view, nothing to open
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
    const h = location.hash.replace(/^#/, "");
    const isNamedView = h === "settings" || h === "trash";
    if (currentId == null) {
      // don't clear the hash when a named view (#settings / #trash) owns it
      if (location.hash && !isNamedView) history.replaceState(null, "", location.pathname + location.search);
    } else if (hashId() !== currentId) {
      location.hash = String(currentId);
    }
  }, [currentId]);

  // back/forward (or an edited URL) → open that memo or switch to a named view
  useEffect(() => {
    function onHash() {
      const h = location.hash.replace(/^#/, "");
      if (h === "settings") { setView("settings"); setViewing(null); return; }
      if (h === "trash") { setView("trash"); loadTrash(); return; }
      if (!h) { setView("memos"); setViewing(null); return; }
      const id = hashId();
      if (id != null && id !== currentIdRef.current) openMemoRef.current!(id);
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // drop the cursor in the editor with the caret at end: after each new memo opens,
  // and once when the editor first mounts — so entering the homepage (login / boot /
  // deep-linked memo) always lands ready to type (#143). The once-flag keeps later
  // sidebar clicks from stealing focus.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || (!focusOnOpen.current && didInitialFocus.current)) return;
    focusOnOpen.current = false;
    didInitialFocus.current = true;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [currentId]);

  // shared post-login setup (used by both password login and passkey login)
  async function afterLogin() {
    localStorage.setItem("qm-authed", "1");
    setAuthed(true);
    const list = (await (await api("/memos")).json()) as MemoMeta[];
    setMemos(list);
    setLoading(false);
    newMemo(); // land in a fresh document, ready to write
  }

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
    await afterLogin();
    return { ok: true };
  }

  async function passkeyLogin(): Promise<void> {
    const optRes = await api("/passkey/auth/options", { method: "POST" });
    if (!optRes.ok) throw new Error("options failed");
    const options = await optRes.json() as PublicKeyCredentialRequestOptionsJSON;
    const authResp = await startAuthentication({ optionsJSON: options });
    const verRes = await api("/passkey/auth/verify", {
      method: "POST",
      body: JSON.stringify({ response: authResp, challenge: options.challenge }),
    });
    if (!verRes.ok) throw new Error("verify failed");
    await afterLogin();
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

  // leaving the current memo: drop it if it's a never-used empty memo,
  // otherwise flush any pending save
  async function leaveCurrent() {
    const id = currentIdRef.current;
    // a never-used new memo is always a local temp (it only reaches the server
    // once it has content) — so leaving it just drops it locally; there is no
    // server row to purge
    if (id != null && freshIds.current.has(id) && isBlank(content)) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      freshIds.current.delete(id);
      writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((t) => t.id !== id));
      kv.remove(DRAFT + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
      return;
    }
    await flush();
  }

  async function openMemo(id: number) {
    if (id === currentIdRef.current) return; // already open — re-clicking it is a no-op (and would purge a fresh-blank current memo via leaveCurrent)
    await leaveCurrent();
    await loadMemo(id);
  }
  openMemoRef.current = openMemo;

  // Load a memo into the editor WITHOUT leaving the current one. openMemo runs
  // leaveCurrent first (flush/purge the memo being left); deleteMemo reuses this
  // directly to open a neighbour, where the memo being "left" is the one we just
  // deleted — there is nothing to flush or purge.
  async function loadMemo(id: number) {
    setViewing(null); // leaving any read-only trash view
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
    lastSaveAt.current = Date.now();
    setCurrentId(id);
    setPublished(false); // unknown until the server row loads (temps are never public)

    // stale-while-revalidate: show local content INSTANTLY (no network wait),
    // draft beats cache; then revalidate against the server in the background
    const draft = kv.get(DRAFT + id);
    // draft beats cache; a temp (id<0) is never in CONTENT_CACHE, so this still
    // yields "" for a contentless temp
    const local = draft ?? kv.get(CONTENT_CACHE + id) ?? "";
    setContent(local);
    loadedAt.current =
      (id < 0 ? readList(TEMPS_KEY) : readList(LIST_CACHE)).find((m) => m.id === id)?.updated_at ??
      0;

    if (id < 0) return; // temp memo — purely local

    try {
      const r = await api(`/memos/${id}`);
      if (!r.ok || currentIdRef.current !== id) return; // 404 / user moved on
      const memo = (await r.json()) as Memo;
      setPublished(memo.published_at != null);
      kv.set(CONTENT_CACHE + id, memo.content);
      const d = kv.get(DRAFT + id);
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

  // publish / unpublish the current memo. On publish, copy its public link to the
  // clipboard; on unpublish, just flash. No-op for temps (id<0, never on server).
  async function togglePublish() {
    const id = currentId!; // the button is disabled when id is null / a temp (id<0)
    if (published) {
      await api(`/memos/${id}/publish`, { method: "DELETE" });
      setPublished(false);
      flash("Unpublished");
    } else {
      const r = await api(`/memos/${id}/publish`, { method: "POST" });
      if (!r.ok) return flash("Publish failed");
      setPublished(true);
      const url = `${location.origin}/p/${id}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      flash("Public link copied");
    }
  }

  // user-initiated "new memo" (toolbar button / ⌘K): unlike the boot-time
  // newMemo() calls, this also leaves the Settings/Trash views so the fresh memo
  // is actually shown. Kept separate so boot doesn't force the view (which would
  // race with restoring the Trash/Settings tab on load).
  function newMemoFromUI() {
    navigateTo("memos");
    newMemo();
  }

  async function newMemo() {
    await leaveCurrent();
    setViewing(null); // leaving any read-only trash view
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
    lastSaveAt.current = Date.now();
    // A new memo starts life as a LOCAL temp (negative id). It is pushed to the
    // server only once it actually has content (materializeTemps skips blanks), so
    // an untouched "Untitled" never reaches the server and can't pile up across
    // sessions (#51). Same behaviour online or offline — creating a memo no longer
    // touches the network.
    const now = Date.now();
    const id = -now;
    const meta = { id, title: "Untitled", updated_at: now };
    writeList(TEMPS_KEY, [meta, ...readList(TEMPS_KEY)]);
    kv.set(DRAFT + id, NEW_DOC);
    setMemos((m) => [meta, ...m]);
    setCurrentId(id);
    setContent(NEW_DOC);
    loadedAt.current = meta.updated_at;
    freshIds.current.add(id);
    focusOnOpen.current = true;
  }

  // push local temp memos to the server (on reconnect / focus / poll)
  async function materializeTemps() {
    if (materializing.current) return; // POSTs fail-fast if actually offline
    materializing.current = true;
    try {
      for (const t of readList(TEMPS_KEY)) {
        const body = kv.get(DRAFT + t.id) ?? "";
        if (isBlank(body)) continue; // skip empties (purged or filled later)
        try {
          const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
          await api(`/memos/${memo.id}`, {
            method: "PUT",
            body: JSON.stringify({ content: body }),
          });
          writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((x) => x.id !== t.id));
          kv.remove(DRAFT + t.id);
          kv.set(CONTENT_CACHE + memo.id, body); // cache for offline read
          const real = { id: memo.id, title: titleFrom(body), updated_at: Date.now() };
          setMemos((m) =>
            [real, ...m.filter((x) => x.id !== t.id && x.id !== memo.id)].sort(byRecent)
          );
          if (currentIdRef.current === t.id) {
            setCurrentId(memo.id);
            loadedAt.current = real.updated_at;
          }
        } catch {
          setOffline(true); // the push failed — we're offline; surface it
          break; // try again on the next reconnect / focus / poll
        }
      }
    } finally {
      materializing.current = false;
    }
  }

  // After deleting the currently-open memo, open the memo right below it in the
  // visible list; if there is none below, the one right above; if the list is now
  // empty, fall back to the empty-centre placeholder. visibleMemosRef still holds
  // the to-be-deleted row here (setMemos is async), so its neighbours are intact.
  function openNeighbourOrClear(id: number) {
    const list = visibleMemosRef.current;
    const idx = list.findIndex((x) => x.id === id);
    // the deleted memo is the open one, which is always present in the visible list
    // here (setMemos is async, so its row is still intact), so idx is never -1.
    const next = list[idx + 1] ?? list[idx - 1];
    if (next) {
      loadMemo(next.id);
    } else {
      setCurrentId(null);
      setContent("");
    }
  }

  async function deleteMemo(id: number) {
    const m = memos.find((x) => x.id === id);
    if (id < 0) {
      // unsynced temp — drop locally, nothing to trash/undo. It may be a fresh
      // never-typed memo (with a pending save) or one with content that hasn't
      // materialized yet; either way cancel any pending save so it can't resurrect
      // the row, and clear its fresh mark.
      freshIds.current.delete(id);
      if (currentId === id && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((t) => t.id !== id));
      kv.remove(DRAFT + id);
      kv.remove(CONTENT_CACHE + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
      if (currentId === id) {
        openNeighbourOrClear(id);
      }
      return;
    }
    // local-first: drop it from the UI immediately, fire the delete in the background
    kv.remove(CONTENT_CACHE + id);
    kv.remove(DRAFT + id);
    setMemos((ms) => ms.filter((x) => x.id !== id));
    if (currentId === id) {
      openNeighbourOrClear(id);
    }
    setUndo({ id, title: m?.title || "Untitled" });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
    api(`/memos/${id}`, { method: "DELETE" }).catch(() => setOffline(true));
  }

  async function undoDelete() {
    // the Undo button only renders inside `{undo && …}`, so undoDelete only ever
    // fires while undo is set; deleteMemo sets undoTimer alongside it, so the timer
    // is always present here too.
    const id = undo!.id;
    clearTimeout(undoTimer.current!);
    setUndo(null);
    await api(`/memos/${id}/restore`, { method: "POST" });
    setMemos((await (await api("/memos")).json()) as MemoMeta[]);
  }

  async function loadTrash() {
    setTrash((await (await api("/trash")).json()) as MemoMeta[]);
  }

  // open a trashed memo read-only so its content can be inspected before
  // deciding to restore or hide it
  async function viewTrash(id: number) {
    const r = await api(`/trash/${id}`);
    if (!r.ok) {
      // already restored/hidden in another session — refresh the list
      setViewing((v) => (v?.id === id ? null : v));
      loadTrash();
      return;
    }
    setViewing((await r.json()) as Memo);
  }

  async function restoreMemo(id: number) {
    await api(`/memos/${id}/restore`, { method: "POST" });
    setViewing((v) => (v?.id === id ? null : v));
    setTrash((t) => t.filter((x) => x.id !== id));
    setMemos((await (await api("/memos")).json()) as MemoMeta[]);
  }

  // permanently hide a trashed memo from view — the row stays in the DB,
  // it's just excluded from the trash listing server-side
  async function hideTrash(id: number) {
    await api(`/memos/${id}/hide`, { method: "POST" });
    setViewing((v) => (v?.id === id ? null : v));
    setTrash((t) => t.filter((x) => x.id !== id));
  }

  function onEdit(value: string) {
    setContent(value);
    // onEdit only fires from the editor textarea / paste-insert, which mount only
    // when currentId != null — so currentId is always a number here.
    const id = currentId!;
    // local-first: persist to localStorage immediately, before any network call
    kv.set(DRAFT + id, value);
    if (conflictRef.current || deletedRef.current) return; // resolve banner first; don't autosave
    if (timer.current) clearTimeout(timer.current);
    setSaving(true);
    // debounce on idle, but cap so a save still happens at least every SAVE_MAX_WAIT
    // even while typing non-stop
    const since = Date.now() - lastSaveAt.current;
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE, SAVE_MAX_WAIT - since));
    timer.current = setTimeout(() => {
      timer.current = null; // debounce fired — no edit pending (keeps the guard honest)
      save(id, value);
    }, delay);
  }

  async function save(id: number, value: string) {
    if (!isBlank(value)) freshIds.current.delete(id); // now has content — keep it
    kv.set(DRAFT + id, value); // local-first

    if (id < 0) {
      // temp memo — local only, never hits the server until materialized
      const title = titleFrom(value);
      const now = Date.now();
      writeList(TEMPS_KEY, readList(TEMPS_KEY).map((t) => (t.id === id ? { ...t, title, updated_at: now } : t)));
      setMemos((m) => m.map((x) => (x.id === id ? { ...x, title, updated_at: now } : x)));
      // leaveCurrent() flushes a temp's pending save before currentId changes, so a
      // temp save always runs while it is still the current memo (id === currentIdRef.current).
      loadedAt.current = now;
      lastSaveAt.current = now;
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
      let r = await api(`/memos/${id}`, {
        method: "PUT",
        body: JSON.stringify({ content: value, base: loadedAt.current }),
      });
      if (r.status === 409) {
        // not necessarily another session: our own last write may have reached
        // the server while we never saw the ack (a keepalive ⌘W flush, or a save
        // whose response was lost on a flaky connection), leaving loadedAt stale.
        // If the server's current content is exactly that un-acked write, re-base
        // to its updated_at and retry — don't accuse the user of a phantom conflict.
        const pending = unacked.current;
        if (pending && pending.id === id) {
          const srv = await api(`/memos/${id}`)
            .then((x) => (x.ok ? (x.json() as Promise<Memo>) : null))
            .catch(() => null);
          if (srv && srv.content === pending.value) {
            loadedAt.current = srv.updated_at;
            unacked.current = null;
            r = await api(`/memos/${id}`, {
              method: "PUT",
              body: JSON.stringify({ content: value, base: loadedAt.current }),
            });
          }
        }
      }
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
      unacked.current = null; // confirmed landed — no longer un-acked
      kv.remove(DRAFT + id); // synced — drop the local draft
      kv.set(CONTENT_CACHE + id, value); // cache for offline read
      setOffline(false);
      setMemos((m) => [{ id, title, updated_at }, ...m.filter((x) => x.id !== id)].sort(byRecent));
      if (id === currentIdRef.current) {
        loadedAt.current = updated_at;
        lastSaveAt.current = Date.now();
      }
      setSaving(false);
    } catch {
      // network failure — the server MAY have committed this write before the
      // response was lost, so remember it: a later 409 against this content is
      // our own edit, not a foreign conflict. The localStorage draft is the
      // safety net for retry.
      unacked.current = { id, value };
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
      const d = kv.get(DRAFT + id);
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
    unacked.current = null;
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
    unacked.current = null;
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
    kv.remove(DRAFT + id);
    kv.remove(CONTENT_CACHE + id);
    setMemos((ms) => ms.filter((x) => x.id !== id));
    try {
      const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
      const r = await api(`/memos/${memo.id}`, { method: "PUT", body: JSON.stringify({ content: body }) });
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      kv.set(CONTENT_CACHE + memo.id, body);
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
      kv.remove(DRAFT + id);
      kv.remove(CONTENT_CACHE + id);
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
      // Merge rather than blindly replace: the server list governs existence (so
      // elsewhere-deletions disappear), but for a row present in both keep whichever
      // updated_at is newer — otherwise a sync whose fetch predates a local save would
      // briefly revert the just-saved title. Local temps (id < 0) stay visible.
      setMemos((curMemos) => {
        const localById = new Map(curMemos.filter((m) => m.id > 0).map((m) => [m.id, m]));
        const reconciled = list.map((s) => {
          const l = localById.get(s.id);
          return l && l.updated_at > s.updated_at ? l : s;
        });
        return [...readList(TEMPS_KEY), ...reconciled].sort(byRecent);
      });
      const id = currentIdRef.current;
      // skip temp / mid-edit / in-flight save / pending save / conflict / deleted.
      // inFlight is checked because the debounce sets timer.current to null before
      // save() completes, so during an in-flight save the base (loadedAt) hasn't been
      // updated yet — sync fetching and updating loadedAt would race with the write and
      // raise a false "changed in another session" conflict.
      if (id == null || id < 0 || timer.current != null || inFlight.current || pendingSave.current != null || conflictRef.current || deletedRef.current) return;
      if (kv.get(DRAFT + id) != null) return; // unsynced local draft pending
      const cur = list.find((x) => x.id === id);
      if (cur && cur.updated_at > loadedAt.current) {
        const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
        kv.set(CONTENT_CACHE + id, memo.content);
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

  // Keyboard shortcuts that need fresh state/handlers (so they live here, with
  // currentId/content/undo/view/viewing as deps, rather than in the ref-based
  // Alt+J/K effect below):
  //   Cmd/Ctrl+S — flush the pending debounce and save immediately
  //   Alt+N — new memo (newMemo flushes the in-progress one first)
  //   Alt+D — trash the current memo (with the 6s undo)
  //   Alt+U — undo the last delete, or restore the trashed memo being viewed
  // The Alt branch uses e.code (physical key) because macOS Option+letter composes
  // a special character into e.key; preventDefault also stops that character.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (e.key.toLowerCase() !== "s") return;
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (currentId != null) {
          setSaving(true);
          save(currentId, content);
        }
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.code === "KeyN") {
        e.preventDefault();
        newMemoFromUI();
      } else if (e.code === "KeyD") {
        // delete the open memo (memos view only; trash rows aren't "current")
        if (view === "memos" && currentId != null) {
          e.preventDefault();
          deleteMemo(currentId);
        }
      } else if (e.code === "KeyU") {
        // undo the last delete if one is pending, else restore the viewed trash memo
        if (undo) {
          e.preventDefault();
          undoDelete();
        } else if (view === "trash" && viewing) {
          e.preventDefault();
          restoreMemo(viewing.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, content, undo, view, viewing]);

  // flush pending save on tab close / reload (keepalive survives unload), and
  // warn the user (⌘W / reload) while a server save is still in flight so the
  // last edits aren't silently dropped if the keepalive request never lands
  useEffect(() => {
    function onUnload(e: BeforeUnloadEvent) {
      const id = currentIdRef.current;
      if (id == null) return;
      if (id < 0) {
        // a never-typed new memo (local temp) — drop it from the list so a blank
        // "Untitled" doesn't linger across reloads. A temp WITH content already
        // lives in localStorage and materializes on the next load. Either way
        // nothing was ever sent to the server, so there's nothing to flush.
        if (freshIds.current.has(id) && isBlank(contentRef.current)) {
          writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((t) => t.id !== id));
          kv.remove(DRAFT + id);
        }
        return;
      }
      // a debounced edit hasn't fired yet, or a save is mid-flight / queued —
      // best-effort push it now and prompt before leaving
      if (timer.current != null || inFlight.current || pendingSave.current != null) {
        fetch(`/api/memos/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: contentRef.current }),
          keepalive: true,
        });
        // this keepalive write has no base (force-overwrite) and we'll never see
        // its ack — record it so that if the user chooses to STAY, the next save
        // recognises the bumped server version as our own, not a phantom conflict.
        unacked.current = { id, value: contentRef.current };
        e.preventDefault();
        e.returnValue = ""; // triggers the browser's native "Leave site?" confirm
      }
    }
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // apply the resolved theme; keep the browser chrome (theme-color) in sync
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#1a1a1a" : "#ffffff");
  }, [theme]);

  // persist the preference (the resolved theme is derived from it)
  useEffect(() => {
    localStorage.setItem("qm-theme", themePref);
  }, [themePref]);

  // persist the sidebar width across reloads
  useEffect(() => {
    localStorage.setItem("qm-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // drag a file anywhere over the window → show the drop overlay and accept the
  // drop (registered once; reads the latest importFile via the ref). Centralised
  // here rather than on the editor so the whole window is a drop target. A depth
  // counter absorbs the nested dragenter/dragleave pairs that fire as the pointer
  // crosses child elements, so the overlay doesn't flicker mid-drag.
  useEffect(() => {
    const isFiles = (e: DragEvent) => e.dataTransfer?.types?.includes("Files");
    function onEnter(e: DragEvent) {
      if (!isFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    }
    function onOver(e: DragEvent) {
      if (isFiles(e)) e.preventDefault(); // required, or the browser won't fire `drop`
    }
    function onLeave(e: DragEvent) {
      if (!isFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragging(false);
      }
    }
    function onDrop(e: DragEvent) {
      dragDepth.current = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        e.preventDefault(); // don't let the browser navigate to the file
        importFileRef.current(files);
      }
    }
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // drag the sidebar's right edge: track the pointer until mouseup, clamping the
  // width to [SIDEBAR_MIN, SIDEBAR_MAX]. The sidebar starts at x=0, so clientX is
  // the width.
  function startSidebarResize(e: { preventDefault: () => void }) {
    e.preventDefault();
    function onMove(ev: MouseEvent) {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // when following the system, react to OS theme changes live
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
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

  // Feature 1: clicking a checkbox in the preview toggles [ ]/[x] in the editor source.
  // The Nth checkbox in the preview maps to the Nth checkbox pattern in the raw content.
  // We expose the toggle logic as a function for testability, and wire it to click events
  // via a native listener on the preview container (Preact's JSX onClick delegation doesn't
  // fire for elements created via dangerouslySetInnerHTML after a debounced state update).
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  // Pure toggle logic: given a source string, Nth checkbox index, return the toggled string.
  // Exported-via-ref for unit testing; not needed for the real user interaction.
  function toggleNthCheckbox(src: string, idx: number): string | null {
    const checkboxPattern = /- \[[ xX]\]/g;
    let match: RegExpExecArray | null;
    let count = 0;
    let matchStart = -1;
    while ((match = checkboxPattern.exec(src)) !== null) {
      if (count === idx) { matchStart = match.index; break; }
      count++;
    }
    if (matchStart === -1) return null;
    const isChecked = src[matchStart + 3].toLowerCase() === "x";
    return src.slice(0, matchStart + 3) + (isChecked ? " " : "x") + src.slice(matchStart + 4);
  }

  useEffect(() => {
    const pv = previewRef.current;
    if (!pv) return;
    function handlePreviewClick(e: Event) {
      const target = e.target as HTMLElement;
      if (target.tagName !== "INPUT" || (target as HTMLInputElement).type !== "checkbox") return;
      // the listener is only attached to the editor-mode preview (a memo is open and
      // not in read-only trash view), so viewingRef is null and currentIdRef is set here.
      e.preventDefault();
      const allBoxes = Array.from(pv!.querySelectorAll('input[type="checkbox"]'));
      // target is one of the queried boxes, so indexOf always finds it.
      const idx = allBoxes.indexOf(target);
      const toggled = toggleNthCheckbox(contentRef.current, idx);
      if (toggled != null) onEdit(toggled);
    }
    pv.addEventListener("click", handlePreviewClick);
    return () => pv.removeEventListener("click", handlePreviewClick);
  // Re-attach when currentId changes (mounting/unmounting the preview pane).
  }, [currentId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Feature 2: auto-continue checkbox list on Enter
  function handleEditorKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // the handler is bound to the editor textarea, so its ref is always set here.
    const el = editorRef.current!;
    const pos = el.selectionStart;
    const val = el.value;
    // Find current line start
    const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
    const lineEnd = val.indexOf("\n", pos);
    const line = val.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const checkboxMatch = line.match(/^(\s*)-\s+\[[ xX]\]\s*/i);
    if (checkboxMatch) {
      e.preventDefault();
      const prefix = checkboxMatch[0];
      const indent = checkboxMatch[1];
      const afterPrefix = line.slice(prefix.length);
      if (afterPrefix.length === 0) {
        // Empty checkbox item — collapse to plain newline (remove the checkbox prefix)
        // Remove the entire current line content, leaving only the preceding newline,
        // then insert a plain newline for the cursor position
        const removeLineContent = val.slice(0, lineStart) + "\n" + val.slice(lineEnd === -1 ? val.length : lineEnd);
        onEdit(removeLineContent);
        requestAnimationFrame(() => {
          if (editorRef.current) {
            const newPos = lineStart + 1;
            editorRef.current.setSelectionRange(newPos, newPos);
          }
        });
      } else {
        // Continue with new checkbox
        const insertion = "\n" + indent + "- [ ] ";
        const newContent = val.slice(0, pos) + insertion + val.slice(pos);
        onEdit(newContent);
        requestAnimationFrame(() => {
          if (editorRef.current) {
            const newPos = pos + insertion.length;
            editorRef.current.setSelectionRange(newPos, newPos);
          }
        });
      }
      return;
    }

    // Plain list item (- text), but not checkbox
    const plainListMatch = line.match(/^(\s*)-\s+/);
    if (!plainListMatch) return;
    e.preventDefault();
    const plainPrefix = plainListMatch[0];
    const plainIndent = plainListMatch[1];
    const afterPlainPrefix = line.slice(plainPrefix.length);
    if (afterPlainPrefix.length === 0) {
      // Empty plain list item — collapse to plain newline
      const removeLineContent = val.slice(0, lineStart) + "\n" + val.slice(lineEnd === -1 ? val.length : lineEnd);
      onEdit(removeLineContent);
      requestAnimationFrame(() => {
        if (editorRef.current) {
          const newPos = lineStart + 1;
          editorRef.current.setSelectionRange(newPos, newPos);
        }
      });
    } else {
      // Continue with new plain list item
      const insertion = "\n" + plainIndent + "- ";
      const newContent = val.slice(0, pos) + insertion + val.slice(pos);
      onEdit(newContent);
      requestAnimationFrame(() => {
        // the editor is still mounted when this rAF runs.
        const newPos = pos + insertion.length;
        editorRef.current!.setSelectionRange(newPos, newPos);
      });
    }
  }

  // debounced live markdown preview — renders the editor content, or the read-only
  // trash memo when one is open (the editor is hidden in that case)
  const { html } = usePreview(viewing ? viewing.content : content);
  // the preview is debounced, so by the time the new html (and its
  // data-source-line blocks) lands, the caret has usually moved on. Re-center on
  // every render so the preview catches up to where the caret now is.
  useEffect(syncPreviewToCaret, [html]);
  // debounced server-side body search: the sidebar list only holds titles, so
  // matching memo *content* has to ask the server. Title matching stays local and
  // instant below; this just folds in the extra body hits once they arrive.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const t = setTimeout(() => {
      api(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? (r.json() as Promise<MemoMeta[]>) : []))
        .catch(() => []) // offline — local title matching below still applies
        .then((rows) => setBodyHits({ q, ids: new Set(rows.map((m) => m.id)) }));
    }, SEARCH_DEBOUNCE);
    return () => clearTimeout(t);
  }, [query]);

  // memos surviving the search text — also the population the badge bar is built
  // from, so every keyword stays visible/clickable even once one is selected.
  const searchMatched = useMemo(() => {
    const q = query.trim();
    if (!q) return memos;
    const ql = q.toLowerCase();
    // only trust body hits fetched for THIS exact query (else a stale/in-flight
    // response would filter against the wrong term)
    const ids = bodyHits.q === q ? bodyHits.ids : null;
    return memos.filter(
      (m) => m.title.toLowerCase().includes(ql) || (ids != null && ids.has(m.id))
    );
  }, [memos, query, bodyHits]);
  const badges = useMemo(() => keywordsOf(searchMatched), [searchMatched]);
  // ignore a selected badge that the current search has filtered away, so the
  // list never dead-ends to empty; the badge re-applies if the search widens.
  const activeKeyword = keyword && badges.includes(keyword) ? keyword : null;
  const visibleMemos = useMemo(
    () => (activeKeyword ? searchMatched.filter((m) => keywordOf(m.title) === activeKeyword) : searchMatched),
    [searchMatched, activeKeyword]
  );
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
      // next is a clamped in-range index distinct from the current row, so list[next]
      // is always a defined memo with an id different from the current one.
      openMemoRef.current!(list[next].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!authed) return <Login onLogin={login} onPasskeyLogin={passkeyLogin} />;

  return (
    <div className="app">
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop files to create memos</span>
        </div>
      )}
      {sidebar && (
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div className="side-tabs">
            <button
              className={view === "memos" ? "tab active" : "tab"}
              onClick={() => {
                navigateTo("memos");
                setViewing(null);
              }}
            >
              Memos
            </button>
            <button
              className={view === "trash" ? "tab active" : "tab"}
              onClick={() => {
                navigateTo("trash");
                loadTrash();
              }}
            >
              Trash
            </button>
          </div>

          {view === "settings" ? null : view === "memos" ? (
            <>
              <input
                className="search"
                placeholder="Search title & body…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {badges.length > 0 && (
                <div className="badges">
                  {badges.map((k) => (
                    <button
                      key={k}
                      className={k === activeKeyword ? "badge active" : "badge"}
                      onClick={() => setKeyword((cur) => (cur === k ? null : k))}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              )}
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
              <p className="shortcut-hint">Alt+J / Alt+K to navigate · Alt+N new · Alt+D delete</p>
            </>
          ) : (
            <ul className="memo-list">
              {trash.map((m) => (
                <li
                  key={m.id}
                  className={m.id === viewing?.id ? "active" : ""}
                  onClick={() => viewTrash(m.id)}
                >
                  <span className="memo-title">{m.title || "Untitled"}</span>
                  <button
                    className="restore"
                    title="Restore"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreMemo(m.id);
                    }}
                  >
                    ↩
                  </button>
                  <button
                    className="del"
                    title="Hide"
                    onClick={(e) => {
                      e.stopPropagation();
                      hideTrash(m.id);
                    }}
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
      {sidebar && (
        <div
          className="sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={startSidebarResize}
        />
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
              className={`ghost settings-toggle icon-btn${view === "settings" ? " active" : ""}`}
              aria-label="Settings"
              onClick={() => {
                navigateTo(view === "settings" ? "memos" : "settings");
                setViewing(null);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button
              className="ghost theme-toggle icon-btn"
              onClick={() =>
                setThemePref((p) =>
                  p === "light" ? "dark" : p === "dark" ? "system" : "light"
                )
              }
              title={
                themePref === "light"
                  ? "Light mode (click for dark)"
                  : themePref === "dark"
                    ? "Dark mode (click to follow system)"
                    : "Following system (click for light)"
              }
              aria-label={
                themePref === "light"
                  ? "Light mode"
                  : themePref === "dark"
                    ? "Dark mode"
                    : "System theme"
              }
            >
              {themePref === "light" ? (
                /* sun */
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : themePref === "dark" ? (
                /* moon */
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              ) : (
                /* monitor */
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              )}
            </button>
            <a
              className="github-link"
              href={GITHUB_PULLS_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub pull requests"
              aria-label="GitHub pull requests"
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.02-1.49-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
            <button
              className={`publish icon-btn${published ? " active" : ""}`}
              onClick={togglePublish}
              disabled={currentId == null || currentId < 0}
              title={published ? "Published — click to unpublish (copy link)" : "Publish this memo to a public link"}
              aria-label={published ? "Unpublish memo" : "Publish memo"}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            </button>
            <button
              className="download icon-btn"
              onClick={downloadMemo}
              disabled={currentId == null}
              title="Download this memo as .md"
              aria-label="Download memo as markdown"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              className="import icon-btn"
              onClick={() => fileRef.current?.click()}
              title="Import text files — each becomes its own memo"
              aria-label="Import files"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            <button className="new-memo icon-btn" onClick={newMemoFromUI} title="New memo (⌘K)" aria-label="New memo">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.log,.yml,.yaml,.xml,text/*,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              importFile(e.currentTarget.files);
              e.currentTarget.value = ""; // allow re-picking the same file(s)
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

        {viewing && (
          <div className="conflict">
            <span>휴지통의 메모입니다 (읽기 전용).</span>
            <button onClick={() => restoreMemo(viewing.id)}>복구</button>
            <button onClick={() => hideTrash(viewing.id)}>숨기기</button>
          </div>
        )}

        {view === "settings" ? (
          <Settings flash={flash} onLogout={logout} admin={admin} />
        ) : viewing ? (
          <div className="pane">
            <textarea
              className="editor"
              value={viewing.content}
              readOnly
              spellcheck={false}
            />
            <div className="preview markdown" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : currentId == null ? (
          <div className="center">
            {loading ? "Loading…" : (
              <>
                <img src="/onigiri.png" alt="" className="mascot" />
                <p>Select a memo on the left, or create a new one.</p>
              </>
            )}
          </div>
        ) : (
          <div className="pane">
            <textarea
              ref={editorRef}
              className="editor"
              value={content}
              onChange={(e) => onEdit(e.currentTarget.value)}
              onSelect={syncPreviewToCaret}
              onKeyDown={handleEditorKeyDown}
              onPaste={(e) => {
                // a pasted image is embedded inline as base64; everything else
                // falls through to the normal text paste
                if (pasteImage(e.clipboardData)) e.preventDefault();
              }}
              placeholder="# Title&#10;&#10;Write in markdown…  (drop a file for a new memo · paste an image to embed)"
              spellcheck={false}
            />
            <div
              ref={previewRef}
              className="preview markdown"
              dangerouslySetInnerHTML={{ __html: html }}
            />
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
  onPasskeyLogin,
}: {
  onLogin: (u: string, p: string, token: string) => Promise<LoginResult>;
  onPasskeyLogin: () => Promise<void>;
}) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const widget = useRef<HTMLDivElement>(null);

  // Immediately show the passkey picker modal on mount — but only when the device
  // actually has a platform authenticator, so browsers/devices without one don't
  // get a pointless popup. (We can't tell whether a passkey is registered for THIS
  // site without prompting — that's a privacy boundary — so a user with an
  // authenticator but no nemo passkey may still see it; the manual button covers
  // the rest.) Silently ignored if the user cancels.
  useEffect(() => {
    const PK = window.PublicKeyCredential;
    if (!PK?.isUserVerifyingPlatformAuthenticatorAvailable) return;
    PK.isUserVerifyingPlatformAuthenticatorAvailable()
      .then((available) => {
        if (available) return onPasskeyLogin();
      })
      .catch(() => {});
  }, []);

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

  async function loginWithPasskey() {
    setMsg(null);
    try {
      await onPasskeyLogin();
    } catch {
      setMsg("Passkey login failed or was cancelled.");
    }
  }

  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <img src="/onigiri.png" alt="" className="mascot" />
        <h1>nemo</h1>
        <input placeholder="id" value={u} onChange={(e) => setU(e.currentTarget.value)} autoFocus autoComplete="username webauthn" />
        <input
          type="password"
          placeholder="password"
          value={p}
          onChange={(e) => setP(e.currentTarget.value)}
        />
        {TURNSTILE_SITEKEY && <div ref={widget} className="turnstile" />}
        <button type="submit">Login</button>
        <button type="button" onClick={loginWithPasskey}>Passkey로 로그인</button>
        {msg && <p className="err">{msg}</p>}
      </form>
    </div>
  );
}
