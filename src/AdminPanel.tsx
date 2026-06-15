// Admin panel (issue #66, multi-tenancy): list, create, delete, and reset
// passwords for users. Rendered inside Settings only for admin sessions.
import { useEffect, useState } from "react";
import { api } from "./lib";

interface User {
  id: number;
  username: string;
  is_admin: number;
  created_at: number;
  last_login_at: number | null;
}

export function AdminPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [newUser, setNewUser] = useState({ username: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const r = await api("/admin/users");
    if (r.ok) setUsers(await r.json());
  }

  useEffect(() => {
    load();
  }, []);

  async function createUser() {
    const r = await api("/admin/users", { method: "POST", body: JSON.stringify(newUser) });
    if (r.ok) {
      setNewUser({ username: "", password: "" });
      setMsg("User created");
      load();
    } else {
      const d = (await r.json()) as { error?: string };
      setMsg(d.error ?? "error");
    }
  }

  async function deleteUser(id: number) {
    if (!confirm("Delete this user?")) return;
    await api(`/admin/users/${id}`, { method: "DELETE" });
    load();
  }

  async function resetPassword(id: number) {
    const pw = prompt("New password:");
    if (!pw) return;
    await api(`/admin/users/${id}/password`, { method: "PATCH", body: JSON.stringify({ password: pw }) });
    setMsg("Password reset");
  }

  return (
    <div>
      <h2 className="section-heading">Admin: Users</h2>
      {msg && <p className="muted">{msg}</p>}
      <ul className="token-list">
        {users.map((u: User) => (
          <li key={u.id}>
            <span className="token-label">
              {u.username}
              {u.is_admin ? " (admin)" : ""}
            </span>
            {!u.is_admin && (
              <>
                <button className="ghost" onClick={() => resetPassword(u.id)}>
                  비밀번호 재설정
                </button>
                <button className="del" onClick={() => deleteUser(u.id)}>
                  삭제
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="token-create">
        <input
          placeholder="username"
          value={newUser.username}
          onInput={(e) => setNewUser((v: { username: string; password: string }) => ({ ...v, username: (e.target as HTMLInputElement).value }))}
        />
        <input
          type="password"
          placeholder="password"
          value={newUser.password}
          onInput={(e) => setNewUser((v: { username: string; password: string }) => ({ ...v, password: (e.target as HTMLInputElement).value }))}
        />
        <button onClick={createUser}>추가</button>
      </div>
    </div>
  );
}
