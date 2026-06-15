import { beforeEach, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import app, { hashPassword, verifyPassword } from "../worker/index";
import { D1 } from "./d1";

// The admin endpoints are gated on an admin JWT (uid + admin claims). The
// multi-tenant login that mints those claims isn't part of this PR, so the
// tests sign tokens directly against the test JWT_SECRET.
const SECRET = "test-secret";

// users-table schema, matching the migrated production shape.
const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
`;

let env: Record<string, unknown>;

beforeEach(async () => {
  const db = new D1();
  db.exec(SCHEMA);
  env = { DB: db, JWT_SECRET: SECRET };
  // Seed an admin (id 1) and a regular user (id 2).
  const hash = await hashPassword("seed");
  await db
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, ?, ?, 1, ?)"
    )
    .bind("admin", hash, Date.now())
    .run();
  await db
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, ?, ?, 0, ?)"
    )
    .bind("alice", hash, Date.now())
    .run();
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);

async function authCookie(claims: Record<string, unknown>) {
  const token = await sign(
    { exp: Math.floor(Date.now() / 1000) + 3600, ...claims },
    SECRET,
    "HS256"
  );
  return `token=${token}`;
}

const adminHeaders = async () => ({
  "content-type": "application/json",
  cookie: await authCookie({ sub: "admin", uid: 1, admin: true }),
});

const userHeaders = async () => ({
  "content-type": "application/json",
  cookie: await authCookie({ sub: "alice", uid: 2, admin: false }),
});

describe("admin gate", () => {
  it("rejects an unauthenticated request (401)", async () => {
    expect((await req("/api/admin/users")).status).toBe(401);
  });

  it("rejects a non-admin user (403)", async () => {
    const r = await req("/api/admin/users", { headers: await userHeaders() });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden" });
  });

  it("allows an admin", async () => {
    expect((await req("/api/admin/users", { headers: await adminHeaders() })).status).toBe(200);
  });
});

describe("GET /api/admin/users", () => {
  it("lists all users ordered by created_at", async () => {
    const r = await req("/api/admin/users", { headers: await adminHeaders() });
    const rows = (await r.json()) as Array<{ id: number; username: string; is_admin: number }>;
    expect(rows.map((u) => u.username)).toEqual(["admin", "alice"]);
    expect(rows[0].is_admin).toBe(1);
    // never exposes password_hash
    expect(Object.keys(rows[0])).not.toContain("password_hash");
  });
});

describe("POST /api/admin/users", () => {
  it("creates a non-admin user and round-trips the password", async () => {
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: await adminHeaders(),
      body: JSON.stringify({ username: "bob", password: "hunter2" }),
    });
    expect(r.status).toBe(201);
    const row = (await r.json()) as { id: number; username: string; is_admin: number };
    expect(row.username).toBe("bob");
    expect(row.is_admin).toBe(0);

    const stored = await (env.DB as D1)
      .prepare("SELECT password_hash FROM users WHERE username = 'bob'")
      .first<{ password_hash: string }>();
    expect(await verifyPassword("hunter2", stored!.password_hash)).toBe(true);
  });

  it("requires username and password (400)", async () => {
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: await adminHeaders(),
      body: JSON.stringify({ username: "bob" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects a duplicate username (409)", async () => {
    const r = await req("/api/admin/users", {
      method: "POST",
      headers: await adminHeaders(),
      body: JSON.stringify({ username: "alice", password: "x" }),
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "username already exists" });
  });
});

describe("DELETE /api/admin/users/:id", () => {
  const remaining = () =>
    (env.DB as D1).prepare("SELECT id FROM users ORDER BY id").all<{ id: number }>();

  it("deletes a non-admin user", async () => {
    const r = await req("/api/admin/users/2", { method: "DELETE", headers: await adminHeaders() });
    expect(r.status).toBe(200);
    expect((await remaining()).results.map((u) => u.id)).toEqual([1]);
  });

  it("won't delete an admin (is_admin = 0 guard)", async () => {
    await req("/api/admin/users/1", { method: "DELETE", headers: await adminHeaders() });
    expect((await remaining()).results.map((u) => u.id)).toEqual([1, 2]);
  });

  it("won't delete yourself (400)", async () => {
    const r = await req("/api/admin/users/1", { method: "DELETE", headers: await adminHeaders() });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "cannot delete yourself" });
  });
});

describe("PATCH /api/admin/users/:id/password", () => {
  it("resets a user's password", async () => {
    const r = await req("/api/admin/users/2/password", {
      method: "PATCH",
      headers: await adminHeaders(),
      body: JSON.stringify({ password: "fresh" }),
    });
    expect(r.status).toBe(200);
    const row = await (env.DB as D1)
      .prepare("SELECT password_hash FROM users WHERE id = 2")
      .first<{ password_hash: string }>();
    expect(await verifyPassword("fresh", row!.password_hash)).toBe(true);
  });

  it("requires a password (400)", async () => {
    const r = await req("/api/admin/users/2/password", {
      method: "PATCH",
      headers: await adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});
