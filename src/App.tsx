import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

type MemoMeta = { id: number; title: string; updated_at: number };
type Memo = MemoMeta & { content: string; created_at: number };
type LoginResult = { ok: boolean; status?: number };

const DRAFT = "qm-draft-"; // localStorage key prefix for unsynced edits
// public site key (build-time). Empty = widget dormant until keys are configured.
const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || "";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }) => string;
      reset: (el: HTMLElement) => void;
    };
    __cfTurnstileOnload?: () => void;
  }
}

const TEMPS_KEY = "qm-temps"; // local-only memos not yet pushed to the server
const LIST_CACHE = "qm-memos"; // cached server list for offline viewing
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
function readList(key: string): MemoMeta[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function writeList(key: string, v: MemoMeta[]) {
  localStorage.setItem(key, JSON.stringify(v));
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

  // background auth check + list — UI is already on screen; this fills it in
  useEffect(() => {
    const temps = readList(TEMPS_KEY);
    const want = Number(localStorage.getItem("qm-current")); // restore last-open memo
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
        const target = merged.some((m) => m.id === want) ? want : merged[0]?.id;
        if (target != null) openMemo(target);
      })
      .catch(() => {
        // offline — render cached list + local temps so the app is usable
        const merged = [...temps, ...readList(LIST_CACHE)].sort(byRecent);
        setMemos(merged);
        setOffline(true);
        setLoading(false);
        // restore the in-progress memo if we have its content locally (draft/temp)
        if (
          want &&
          merged.some((m) => m.id === want) &&
          (want < 0 || localStorage.getItem(DRAFT + want) != null)
        ) {
          openMemo(want);
        }
      });
  }, []);

  // remember the open memo so a reload (incl. offline) restores it
  useEffect(() => {
    if (currentId != null) localStorage.setItem("qm-current", String(currentId));
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
    if (list.length) openMemo(list[0].id);
    return { ok: true };
  }

  async function logout() {
    await leaveCurrent();
    await api("/logout", { method: "POST" });
    localStorage.removeItem("qm-authed");
    localStorage.removeItem("qm-current");
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
    if (id != null && freshIds.current.has(id) && content.trim() === "") {
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
    lastSaveAt.current = Date.now();
    if (id < 0) {
      // local temp memo — content lives in localStorage
      setCurrentId(id);
      setContent(localStorage.getItem(DRAFT + id) ?? "");
      loadedAt.current = readList(TEMPS_KEY).find((x) => x.id === id)?.updated_at ?? Date.now();
      return;
    }
    try {
      const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
      setCurrentId(memo.id);
      const draft = localStorage.getItem(DRAFT + id);
      if (draft != null && draft !== memo.content) {
        // unsynced local edit from a previous failed save — keep it and retry push
        setContent(draft);
        loadedAt.current = memo.updated_at;
        save(memo.id, draft);
      } else {
        setContent(memo.content);
        loadedAt.current = memo.updated_at;
      }
    } catch {
      // offline — fall back to the local draft if we have one
      setCurrentId(id);
      setContent(localStorage.getItem(DRAFT + id) ?? "");
      setOffline(true);
    }
  }

  async function newMemo() {
    await leaveCurrent();
    conflictRef.current = false;
    setConflict(false);
    lastSaveAt.current = Date.now();
    try {
      const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
      setMemos((m) => [{ id: memo.id, title: memo.title, updated_at: memo.updated_at }, ...m]);
      setCurrentId(memo.id);
      setContent("");
      loadedAt.current = memo.updated_at;
      freshIds.current.add(memo.id);
    } catch {
      // offline — create a local temp memo (negative id) that syncs on reconnect
      const id = -Date.now();
      const meta = { id, title: "Untitled", updated_at: Date.now() };
      writeList(TEMPS_KEY, [meta, ...readList(TEMPS_KEY)]);
      localStorage.setItem(DRAFT + id, "");
      setMemos((m) => [meta, ...m]);
      setCurrentId(id);
      setContent("");
      loadedAt.current = meta.updated_at;
      freshIds.current.add(id);
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
        if (body.trim() === "") continue; // skip empties (purged or filled later)
        try {
          const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
          await api(`/memos/${memo.id}`, {
            method: "PUT",
            body: JSON.stringify({ content: body }),
          });
          writeList(TEMPS_KEY, readList(TEMPS_KEY).filter((x) => x.id !== t.id));
          localStorage.removeItem(DRAFT + t.id);
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

  function onEdit(value: string) {
    setContent(value);
    if (currentId == null) return;
    // local-first: persist to localStorage immediately, before any network call
    localStorage.setItem(DRAFT + currentId, value);
    if (conflictRef.current) return; // resolve the conflict first; don't autosave
    if (timer.current) clearTimeout(timer.current);
    setSaving(true);
    // debounce on idle, but cap so a save still happens at least every SAVE_MAX_WAIT
    // even while typing non-stop
    const since = Date.now() - lastSaveAt.current;
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE, SAVE_MAX_WAIT - since));
    timer.current = setTimeout(() => save(currentId, value), delay);
  }

  async function save(id: number, value: string) {
    if (value.trim()) freshIds.current.delete(id); // now has content — keep it
    localStorage.setItem(DRAFT + id, value); // local-first

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
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      localStorage.removeItem(DRAFT + id); // synced — drop the local draft
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
    if (conflictRef.current) return;
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
      if (id == null || id < 0 || timer.current != null || conflictRef.current) return; // skip temp / mid-edit / conflict
      if (localStorage.getItem(DRAFT + id) != null) return; // unsynced local draft pending
      const cur = list.find((x) => x.id === id);
      if (cur && cur.updated_at > loadedAt.current) {
        const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
        if (timer.current == null && currentIdRef.current === id) {
          setContent(memo.content);
          loadedAt.current = memo.updated_at;
        }
      }
    }
    const iv = setInterval(sync, 10000);
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
      if (freshIds.current.has(id) && contentRef.current.trim() === "") {
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

  const html = useMemo(() => marked.parse(content) as string, [content]);
  const visibleMemos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? memos.filter((m) => m.title.toLowerCase().includes(q)) : memos;
  }, [memos, query]);

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
        </div>

        {conflict && (
          <div className="conflict">
            <span>This memo was changed in another session.</span>
            <button onClick={reloadCurrent}>Reload</button>
            <button onClick={overwrite}>Overwrite</button>
          </div>
        )}

        {currentId == null ? (
          <div className="center">
            {loading ? "Loading…" : "Select a memo on the left, or create a new one."}
          </div>
        ) : (
          <div className="pane">
            <textarea
              className="editor"
              value={content}
              onChange={(e) => onEdit(e.currentTarget.value)}
              placeholder="# Title&#10;&#10;Write in markdown…"
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
