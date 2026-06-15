import { beforeEach, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import app, { hashPassword } from "../worker/index";
import { D1 } from "./d1";

const JWT_SECRET = "test-secret";

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
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
let adminId: number;
let regularId: number;

async function makeAdminCookie(): Promise<string> {
  const token = await sign(
    { sub: "admin", uid: adminId, admin: true, exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET
  );
  return `token=${token}`;
}

async function makeUserCookie(): Promise<string> {
  const token = await sign(
    { sub: "user", uid: regularId, admin: false, exp: Math.floor(Date.now() / 1000) + 3600 },
    JWT_SECRET
  );
  return `token=${token}`;
}

beforeEach(async () => {
  const db = new D1();
  db.exec(SCHEMA);
  const adminHash = await hashPassword("adminpw");
  const userHash = await hashPassword("userpw");
  const now = Date.now();

  // Insert admin user
  const adminRow = db.prepare(
    "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ('admin', ?, 1, ?) RETURNING id"
  ).bind(adminHash, now);
  const adminResult = await adminRow.first<{ id: number }>();
  adminId = adminResult!.id;

  // Insert regular user
  const userRow = db.prepare(
    "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ('regular', ?, 0, ?) RETURNING id"
  ).bind(userHash, now + 1);
  const userResult = await userRow.first<{ id: number }>();
  regularId = userResult!.id;

  env = { DB: db, AUTH_USER: "admin", AUTH_PASS: adminHash, JWT_SECRET };
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);

describe("GET /api/admin/users", () => {
  it("returns user list for admin", async () => {
    const cookie = await makeAdminCookie();
    const r = await req("/api/admin/users", {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { id: number; username: string; is_admin: number }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body.some((u) => u.username === "admin")).toBe(true);
    expect(body.some((u) => u.username === "regular")).toBe(true);
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await makeUserCookie();
    const r = await req("/api/admin/users", {
      headers: { cookie },
    });
    expect(r.status).toBe(403);
  });

  it("returns 401 for unauthenticated", async () => {
    const r = await req("/api/admin/users");
    expect(r.status).toBe(401);
  });
});

describe("POST /api/admin/users", () => {
  it("creates a new user", async () => {
    const cookie = await makeAdminCookie();
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "newuser", password: "newpw" }),
    });
    expect(r.status).toBe(201);
    const body = await r.json() as { username: string; is_admin: number };
    expect(body.username).toBe("newuser");
    expect(body.is_admin).toBe(0);
  });

  it("returns 409 on duplicate username", async () => {
    const cookie = await makeAdminCookie();
    await req("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "dup", password: "pw" }),
    });
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "dup", password: "pw" }),
    });
    expect(r.status).toBe(409);
  });

  it("returns 400 when username or password missing", async () => {
    const cookie = await makeAdminCookie();
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "nopass" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await makeUserCookie();
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "x", password: "y" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  it("deletes a non-admin user", async () => {
    const cookie = await makeAdminCookie();
    const r = await req(`/api/admin/users/${regularId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("returns 400 when trying to delete yourself", async () => {
    const cookie = await makeAdminCookie();
    const r = await req(`/api/admin/users/${adminId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toBe("cannot delete yourself");
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await makeUserCookie();
    const r = await req(`/api/admin/users/${adminId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(r.status).toBe(403);
  });
});

describe("PATCH /api/admin/users/:id/password", () => {
  it("resets a user password", async () => {
    const cookie = await makeAdminCookie();
    const r = await req(`/api/admin/users/${regularId}/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ password: "newpassword" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("returns 400 when password missing", async () => {
    const cookie = await makeAdminCookie();
    const r = await req(`/api/admin/users/${regularId}/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("returns 403 for non-admin", async () => {
    const cookie = await makeUserCookie();
    const r = await req(`/api/admin/users/${regularId}/password`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ password: "newpassword" }),
    });
    expect(r.status).toBe(403);
  });
});
