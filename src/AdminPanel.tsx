import { useEffect, useState } from "react";

type UserMeta = { id: number; username: string; is_admin: number; created_at: number; last_login_at: number | null };

export function AdminPanel({ flash }: { flash: (msg: string) => void }) {
  const [users, setUsers] = useState<UserMeta[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function load() {
    const r = await fetch('/api/admin/users');
    if (r.ok) setUsers(await r.json());
  }
  useEffect(() => { load(); }, []);

  async function createUser(e: Event) {
    e.preventDefault();
    const r = await fetch('/api/admin/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
    if (r.ok) { flash('유저 생성됨'); setUsername(''); setPassword(''); load(); }
    else { const d = await r.json(); flash((d as any).error || '오류'); }
  }

  async function deleteUser(id: number) {
    await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    load();
  }

  async function resetPassword(id: number) {
    const pw = prompt('새 비밀번호:');
    if (!pw) return;
    await fetch(`/api/admin/users/${id}/password`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ password: pw }) });
    flash('비밀번호 변경됨');
  }

  return (
    <div className="admin-panel">
      <h2>유저 관리</h2>
      <ul className="token-list">
        {users.map(u => (
          <li key={u.id}>
            <span>{u.username}{u.is_admin ? ' (admin)' : ''}</span>
            <span className="token-actions">
              <button onClick={() => resetPassword(u.id)}>비밀번호 변경</button>
              {!u.is_admin && <button onClick={() => deleteUser(u.id)}>삭제</button>}
            </span>
          </li>
        ))}
      </ul>
      <form onSubmit={createUser}>
        <input placeholder="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} required />
        <input type="password" placeholder="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} required />
        <button type="submit">유저 추가</button>
      </form>
    </div>
  );
}
