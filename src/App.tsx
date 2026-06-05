import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

type MemoMeta = { id: number; title: string; updated_at: number };
type Memo = MemoMeta & { content: string; created_at: number };
type LoginResult = { ok: boolean; locked?: boolean; remaining?: number };

const DRAFT = "qm-draft-"; // localStorage key prefix for unsynced edits

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return res;
}

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
  const [sidebar, setSidebar] = useState(true);
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latest values for the beforeunload handler (avoids stale closure)
  const contentRef = useRef(content);
  contentRef.current = content;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // background auth check + list — UI is already on screen; this fills it in
  useEffect(() => {
    api("/memos").then(async (r) => {
      if (r.status === 401) {
        localStorage.removeItem("qm-authed");
        setAuthed(false);
        setLoading(false);
        return;
      }
      localStorage.setItem("qm-authed", "1");
      setAuthed(true);
      const list = (await r.json()) as MemoMeta[];
      setMemos(list);
      setLoading(false);
      if (list.length) openMemo(list[0].id);
    });
  }, []);

  async function login(username: string, password: string): Promise<LoginResult> {
    const r = await api("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      const d = (await r.json().catch(() => ({}))) as { locked?: boolean; remaining?: number };
      return { ok: false, locked: !!d.locked, remaining: d.remaining };
    }
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
      try {
        await api(`/memos/${id}?purge=1`, { method: "DELETE" });
      } catch {
        // offline — leave the empty row; it can be cleaned up later
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
  }

  async function newMemo() {
    await leaveCurrent();
    conflictRef.current = false;
    setConflict(false);
    const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
    setMemos((m) => [{ id: memo.id, title: memo.title, updated_at: memo.updated_at }, ...m]);
    setCurrentId(memo.id);
    setContent("");
    loadedAt.current = memo.updated_at;
    freshIds.current.add(memo.id);
  }

  async function deleteMemo(id: number) {
    const m = memos.find((x) => x.id === id);
    await api(`/memos/${id}`, { method: "DELETE" });
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
    timer.current = setTimeout(() => save(currentId, value), 300);
  }

  async function save(id: number, value: string) {
    if (value.trim()) freshIds.current.delete(id); // now has content — keep it
    try {
      const r = await api(`/memos/${id}`, {
        method: "PUT",
        body: JSON.stringify({ content: value, base: loadedAt.current }),
      });
      if (r.status === 409) {
        // changed in another session — stop autosaving, let the user choose
        conflictRef.current = true;
        setConflict(true);
        setSaving(false);
        return;
      }
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      localStorage.removeItem(DRAFT + id); // synced — drop the local draft
      setOffline(false);
      setMemos((m) =>
        [{ id, title, updated_at }, ...m.filter((x) => x.id !== id)].sort(
          (a, b) => b.updated_at - a.updated_at
        )
      );
      if (id === currentIdRef.current) loadedAt.current = updated_at;
      setSaving(false);
    } catch {
      // network failure — the draft in localStorage is the safety net; retry later
      setOffline(true);
      setSaving(false);
    }
  }

  // push any unsynced draft for the current memo (on reconnect / focus / poll)
  async function retryDrafts() {
    if (!navigator.onLine || conflictRef.current) return;
    const id = currentIdRef.current;
    if (id == null) return;
    const d = localStorage.getItem(DRAFT + id);
    if (d != null) await save(id, d);
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
      retryDrafts(); // push any unsynced offline edits
      const r = await api("/memos").catch(() => null);
      if (!r || !r.ok) return;
      const list = (await r.json()) as MemoMeta[];
      setMemos(list);
      const id = currentIdRef.current;
      if (id == null || timer.current != null || conflictRef.current) return; // skip mid-edit / conflict
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
      if (id == null) return;
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

  // retry unsynced drafts the moment the network comes back
  useEffect(() => {
    window.addEventListener("online", retryDrafts);
    return () => window.removeEventListener("online", retryDrafts);
  }, []);

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

function Login({ onLogin }: { onLogin: (u: string, p: string) => Promise<LoginResult> }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const res = await onLogin(u, p);
    if (res.ok) return;
    if (res.locked) {
      setMsg("Login is disabled after too many failed attempts. Manual reset required.");
    } else {
      setMsg(
        `Invalid username or password.${
          res.remaining != null ? ` ${res.remaining} attempt(s) left.` : ""
        }`
      );
    }
  }

  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <h1>memo</h1>
        <input placeholder="id" value={u} onChange={(e) => setU(e.currentTarget.value)} autoFocus />
        <input
          type="password"
          placeholder="password"
          value={p}
          onChange={(e) => setP(e.currentTarget.value)}
        />
        <button type="submit">Login</button>
        {msg && <p className="err">{msg}</p>}
      </form>
    </div>
  );
}
