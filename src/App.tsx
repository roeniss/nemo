import { useEffect, useMemo, useRef, useState } from "react";
import { kv, hydrate } from "./idb";
import {
  type MemoMeta,
  type Memo,
  type LoginResult,
  DRAFT,
  CONTENT_CACHE,
  TEMPS_KEY,
  LIST_CACHE,
  NEW_DOC,
  SAVE_DEBOUNCE,
  SAVE_MAX_WAIT,
  api,
  titleFrom,
  isBlank,
  hashId,
  readList,
  writeList,
  byRecent,
} from "./lib";
import { useToast, usePreview } from "./hooks";
import { useImport } from "./useImport";

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
  const [viewing, setViewing] = useState<Memo | null>(null); // trashed memo open in read-only view
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
  const focusOnOpen = useRef(false); // focus the editor after the next new memo opens
  const fileRef = useRef<HTMLInputElement>(null); // hidden file picker for text import
  const folderRef = useRef<HTMLInputElement>(null); // hidden folder picker (each file → a memo)
  const { notice, flash } = useToast();
  // file/folder import (each file → its own memo), image paste (base64 embed), and .md export
  const { importFile, importFolder, pasteImage, downloadMemo } =
    useImport({ content, currentIdRef, editorRef, onEdit, flash, setMemos });
  // always-latest openMemo, so the hashchange listener (registered once) never
  // calls a stale closure. Reassigned to openMemo synchronously on the first render
  // (below), before any listener can fire — so this placeholder is never invoked.
  /* v8 ignore next */
  const openMemoRef = useRef<(id: number) => void>(() => {});

  // background auth check + list — UI is already on screen; this fills it in
  useEffect(() => {
    const temps = readList(TEMPS_KEY);
    // load the IndexedDB content mirror before anything reads drafts/cache
    hydrate()
      .then(() => api("/memos"))
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
            kv.get(DRAFT + want) != null ||
            kv.get(CONTENT_CACHE + want) != null)
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
        kv.remove(DRAFT + id);
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
    if (id === currentIdRef.current) return; // already open — re-clicking it is a no-op (and would purge a fresh-blank current memo via leaveCurrent)
    await leaveCurrent();
    setViewing(null); // leaving any read-only trash view
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
    lastSaveAt.current = Date.now();
    setCurrentId(id);

    // stale-while-revalidate: show local content INSTANTLY (no network wait),
    // draft beats cache; then revalidate against the server in the background
    const draft = kv.get(DRAFT + id);
    const local = draft ?? (id < 0 ? "" : kv.get(CONTENT_CACHE + id) ?? "");
    setContent(local);
    loadedAt.current =
      (id < 0 ? readList(TEMPS_KEY) : readList(LIST_CACHE)).find((m) => m.id === id)?.updated_at ??
      0;

    if (id < 0) return; // temp memo — purely local

    try {
      const r = await api(`/memos/${id}`);
      if (!r.ok || currentIdRef.current !== id) return; // 404 / user moved on
      const memo = (await r.json()) as Memo;
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
  openMemoRef.current = openMemo;

  async function newMemo() {
    await leaveCurrent();
    setViewing(null); // leaving any read-only trash view
    conflictRef.current = false;
    setConflict(false);
    deletedRef.current = false;
    setDeleted(false);
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
      kv.set(DRAFT + id, NEW_DOC);
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
      kv.remove(DRAFT + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setContent("");
      }
      return;
    }
    // a never-used empty memo (created this session, never given content) — purge
    // it outright instead of sending an "Untitled" placeholder to the trash
    if (freshIds.current.has(id)) {
      freshIds.current.delete(id);
      if (currentId === id && timer.current) {
        clearTimeout(timer.current); // cancel any pending save that would resurrect it
        timer.current = null;
      }
      try {
        await api(`/memos/${id}?purge=1`, { method: "DELETE" });
      } catch {
        setOffline(true);
      }
      kv.remove(CONTENT_CACHE + id);
      kv.remove(DRAFT + id);
      setMemos((ms) => ms.filter((x) => x.id !== id));
      // a fresh memo is purged the moment you leave it, so one in the list is always
      // the open one — currentId !== id here is unreachable
      /* v8 ignore next */
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
    kv.remove(CONTENT_CACHE + id);
    kv.remove(DRAFT + id);
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
    // the Undo button only renders inside `{undo && …}`, so undoDelete can never
    // fire with undo === null — this guard is defensive and unreachable
    /* v8 ignore next */
    if (!undo) return;
    const id = undo.id;
    // undoDelete only runs while the undo toast is shown, which deleteMemo sets up
    // together with undoTimer — so the timer is always present here
    /* v8 ignore next */
    if (undoTimer.current) clearTimeout(undoTimer.current);
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
    // when currentId != null — so this guard is defensive and unreachable
    /* v8 ignore next */
    if (currentId == null) return;
    // local-first: persist to localStorage immediately, before any network call
    kv.set(DRAFT + currentId, value);
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

  async function save(id: number, value: string) {
    if (!isBlank(value)) freshIds.current.delete(id); // now has content — keep it
    kv.set(DRAFT + id, value); // local-first

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
      if (id == null || id < 0 || timer.current != null || conflictRef.current || deletedRef.current) return; // skip temp / mid-edit / conflict / deleted
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

  // flush pending save on tab close / reload (keepalive survives unload), and
  // warn the user (⌘W / reload) while a server save is still in flight so the
  // last edits aren't silently dropped if the keepalive request never lands
  useEffect(() => {
    function onUnload(e: BeforeUnloadEvent) {
      const id = currentIdRef.current;
      if (id == null || id < 0) return; // temp memos already live in localStorage
      if (freshIds.current.has(id) && isBlank(contentRef.current)) {
        fetch(`/api/memos/${id}?purge=1`, { method: "DELETE", keepalive: true });
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

  // debounced live markdown preview — renders the editor content, or the read-only
  // trash memo when one is open (the editor is hidden in that case)
  const { html } = usePreview(viewing ? viewing.content : content);
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
      // next is a clamped in-range index distinct from the current row, so target is
      // always a defined, different memo — the guard's false arm is unreachable
      /* v8 ignore next */
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
              onClick={() => {
                setView("memos");
                setViewing(null);
              }}
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
              className="ghost theme-toggle"
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
            >
              {themePref === "light" ? "☀️" : themePref === "dark" ? "🌙" : "🖥️"}
            </button>
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
              title="Import text files — each becomes its own memo"
            >
              ⬆ Files
            </button>
            <button
              className="import-folder"
              onClick={() => folderRef.current?.click()}
              title="Upload a folder — each file becomes its own memo"
            >
              ⬆ Folder
            </button>
            <button className="new-memo" onClick={newMemo} title="New memo (⌘K)">
              + New
            </button>
          </div>
          <input
            ref={folderRef}
            className="folder-input"
            type="file"
            multiple
            // webkitdirectory turns this into a directory picker; it's a non-standard
            // boolean prop missing from the JSX types, so spread it through. Must be
            // boolean `true` (not "") — the renderer maps it to the DOM property, and
            // an empty string would coerce to false.
            {...({ webkitdirectory: true } as Record<string, boolean>)}
            style={{ display: "none" }}
            onChange={(e) => {
              importFolder(e.currentTarget.files);
              e.currentTarget.value = ""; // allow re-picking the same folder
            }}
          />
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

        {viewing ? (
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
            {loading ? "Loading…" : "Select a memo on the left, or create a new one."}
          </div>
        ) : (
          <div className="pane">
            <textarea
              ref={editorRef}
              className="editor"
              value={content}
              onChange={(e) => onEdit(e.currentTarget.value)}
              onPaste={(e) => {
                // a pasted image is embedded inline as base64; everything else
                // falls through to the normal text paste
                if (pasteImage(e.clipboardData)) e.preventDefault();
              }}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); // allow drop
              }}
              onDrop={(e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length) {
                  e.preventDefault(); // don't let the browser navigate to the file
                  importFile(files); // each dropped file → its own new memo
                }
              }}
              placeholder="# Title&#10;&#10;Write in markdown…  (drop a file for a new memo · paste an image to embed)"
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
