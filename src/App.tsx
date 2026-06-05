import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MemoMeta = { id: number; title: string; updated_at: number };
type Memo = MemoMeta & { content: string; created_at: number };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return res;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [memos, setMemos] = useState<MemoMeta[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [sidebar, setSidebar] = useState(true);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // latest values for the beforeunload handler (avoids stale closure)
  const contentRef = useRef(content);
  contentRef.current = content;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  // initial auth check + list
  useEffect(() => {
    api("/memos").then(async (r) => {
      if (r.status === 401) return setAuthed(false);
      setAuthed(true);
      const list = (await r.json()) as MemoMeta[];
      setMemos(list);
      if (list.length) openMemo(list[0].id);
    });
  }, []);

  async function login(username: string, password: string) {
    const r = await api("/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) return false;
    setAuthed(true);
    const list = (await (await api("/memos")).json()) as MemoMeta[];
    setMemos(list);
    if (list.length) openMemo(list[0].id);
    return true;
  }

  async function logout() {
    await api("/logout", { method: "POST" });
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

  async function openMemo(id: number) {
    await flush();
    const memo = (await (await api(`/memos/${id}`)).json()) as Memo;
    setCurrentId(memo.id);
    setContent(memo.content);
  }

  async function newMemo() {
    await flush();
    const memo = (await (await api("/memos", { method: "POST" }).then((r) => r)).json()) as Memo;
    setMemos((m) => [{ id: memo.id, title: memo.title, updated_at: memo.updated_at }, ...m]);
    setCurrentId(memo.id);
    setContent("");
  }

  async function deleteMemo(id: number) {
    if (!confirm("Delete this memo?")) return;
    await api(`/memos/${id}`, { method: "DELETE" });
    setMemos((m) => m.filter((x) => x.id !== id));
    if (currentId === id) {
      setCurrentId(null);
      setContent("");
    }
  }

  function onEdit(value: string) {
    setContent(value);
    if (currentId == null) return;
    if (timer.current) clearTimeout(timer.current);
    setSaving(true);
    timer.current = setTimeout(() => save(currentId, value), 300);
  }

  async function save(id: number, value: string) {
    const { title, updated_at } = (await (
      await api(`/memos/${id}`, { method: "PUT", body: JSON.stringify({ content: value }) })
    ).json()) as { title: string; updated_at: number };
    setMemos((m) =>
      [{ id, title, updated_at }, ...m.filter((x) => x.id !== id)].sort(
        (a, b) => b.updated_at - a.updated_at
      )
    );
    setSaving(false);
  }

  // Cmd/Ctrl+S: flush pending debounce and save immediately
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        if (currentId != null) {
          setSaving(true);
          save(currentId, content);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentId, content]);

  // flush pending save on tab close / reload (keepalive survives unload)
  useEffect(() => {
    function onUnload() {
      if (timer.current && currentIdRef.current != null) {
        fetch(`/api/memos/${currentIdRef.current}`, {
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

  if (authed === null) return <div className="center">…</div>;
  if (authed === false) return <Login onLogin={login} />;

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
          <ul className="memo-list">
            {memos.map((m) => (
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
            {memos.length === 0 && <li className="empty">No memos</li>}
          </ul>
        </aside>
      )}

      <div className="main">
        <div className="topbar">
          <button className="ghost" onClick={() => setSidebar((s) => !s)}>
            {sidebar ? "◀" : "▶"}
          </button>
          <span className="status">{saving ? "Saving…" : "Saved"}</span>
        </div>

        {currentId == null ? (
          <div className="center">Select a memo on the left, or create a new one.</div>
        ) : (
          <div className="pane">
            <textarea
              className="editor"
              value={content}
              onChange={(e) => onEdit(e.target.value)}
              placeholder="# Title&#10;&#10;Write in markdown…"
              spellCheck={false}
            />
            <div className="preview markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (u: string, p: string) => Promise<boolean> }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onLogin(u, p);
    setErr(!ok);
  }

  return (
    <div className="center">
      <form className="login" onSubmit={submit}>
        <h1>memo</h1>
        <input placeholder="id" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        <input
          type="password"
          placeholder="password"
          value={p}
          onChange={(e) => setP(e.target.value)}
        />
        <button type="submit">Login</button>
        {err && <p className="err">Invalid username or password.</p>}
      </form>
    </div>
  );
}
