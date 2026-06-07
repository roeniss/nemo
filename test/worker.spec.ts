import { beforeEach, describe, expect, it } from "vitest";
import app from "../worker/index";
import { D1 } from "./d1";

const SCHEMA = `
CREATE TABLE memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden_at INTEGER
);
`;

let env: Record<string, unknown>;

beforeEach(() => {
  const db = new D1();
  db.exec(SCHEMA);
  env = { DB: db, AUTH_USER: "tester", AUTH_PASS: "pw", JWT_SECRET: "test-secret" };
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);

const login = (password = "pw") =>
  req("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "tester", password }),
  });

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

async function authedHeaders() {
  return { "content-type": "application/json", cookie: cookieOf(await login()) };
}

describe("auth", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await req("/api/memos")).status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    expect((await login("wrong")).status).toBe(401);
  });

  it("accepts the correct password and sets a cookie", async () => {
    const r = await login();
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("token=");
  });
  // Turnstile is skipped here (no TURNSTILE_SECRET in the test env), matching
  // the worker's "enforce only when configured" behaviour.
});

describe("memos", () => {
  it("creates, updates (deriving title from the first line), and lists", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    const u = await (
      await req(`/api/memos/${c.id}`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify({ content: "# Hello\nbody", base: c.updated_at }),
      })
    ).json();
    expect(u.title).toBe("Hello");
    expect(await (await req("/api/memos", { headers: h })).json()).toHaveLength(1);
  });

  it("rejects a stale write with 409 (optimistic concurrency)", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    const conflict = await req(`/api/memos/${c.id}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "x", base: 0 }), // base older than the row
    });
    expect(conflict.status).toBe(409);
  });

  it("soft-deletes (hidden from list, visible in trash, 404 on get) and restores", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}`, { method: "DELETE", headers: h });
    expect(await (await req("/api/memos", { headers: h })).json()).toHaveLength(0);
    expect(await (await req("/api/trash", { headers: h })).json()).toHaveLength(1);
    expect((await req(`/api/memos/${c.id}`, { headers: h })).status).toBe(404);
    await req(`/api/memos/${c.id}/restore`, { method: "POST", headers: h });
    expect(await (await req("/api/memos", { headers: h })).json()).toHaveLength(1);
  });

  it("hides a trashed memo from the trash view while keeping the row in the DB", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}`, { method: "DELETE", headers: h });
    expect(await (await req("/api/trash", { headers: h })).json()).toHaveLength(1);
    await req(`/api/memos/${c.id}/hide`, { method: "POST", headers: h });
    expect(await (await req("/api/trash", { headers: h })).json()).toHaveLength(0);
    // row is still in the DB — not a real delete
    const row = await env.DB!.prepare("SELECT id FROM memos WHERE id = ?").bind(c.id).first();
    expect(row).not.toBeNull();
  });

  it("hard-purges with ?purge=1 (not recoverable from trash)", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}?purge=1`, { method: "DELETE", headers: h });
    expect(await (await req("/api/trash", { headers: h })).json()).toHaveLength(0);
    const row = await env.DB!.prepare("SELECT id FROM memos WHERE id = ?").bind(c.id).first();
    expect(row).toBeNull();
  });
});
