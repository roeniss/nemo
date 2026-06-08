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
CREATE TABLE memo_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memo_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
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

  it("reads a single trashed memo's content (GET /api/trash/:id), 404 before delete and after hide", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "# Trashed\nbody", base: c.updated_at }),
    });
    // not in trash yet — the trash read 404s
    expect((await req(`/api/trash/${c.id}`, { headers: h })).status).toBe(404);
    await req(`/api/memos/${c.id}`, { method: "DELETE", headers: h });
    const got = await req(`/api/trash/${c.id}`, { headers: h });
    expect(got.status).toBe(200);
    expect((await got.json()).content).toBe("# Trashed\nbody");
    // once hidden it drops out of the trash read too
    await req(`/api/memos/${c.id}/hide`, { method: "POST", headers: h });
    expect((await req(`/api/trash/${c.id}`, { headers: h })).status).toBe(404);
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

describe("history (session snapshots)", () => {
  const HOUR = 60 * 60 * 1000;
  const create = async (h: HeadersInit) =>
    (await req("/api/memos", { method: "POST", headers: h })).json();
  const put = async (id: number, h: HeadersInit, body: unknown) =>
    (await req(`/api/memos/${id}`, { method: "PUT", headers: h, body: JSON.stringify(body) })).json();
  // rewrite a memo's stored state so the time-gated snapshot logic is testable
  // (title is kept in sync with content, mirroring what a real PUT would store)
  const backdate = (id: number, created_at: number, updated_at: number, content: string) => {
    const title = content.split("\n")[0].replace(/^#+\s*/, "") || "Untitled";
    return env
      .DB!.prepare(
        "UPDATE memos SET created_at = ?, updated_at = ?, content = ?, title = ? WHERE id = ?"
      )
      .bind(created_at, updated_at, content, title, id)
      .run();
  };
  const versions = async (id: number) =>
    (
      await env.DB!.prepare(
        "SELECT * FROM memo_versions WHERE memo_id = ? ORDER BY created_at DESC"
      )
        .bind(id)
        .all()
    ).results as Array<{ title: string; content: string; created_at: number }>;

  it("snapshots the prior session's final state when editing resumes after a >=1h idle gap", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "# Old\nbody");
    await put(c.id, h, { content: "# New", base: old });
    const v = await versions(c.id);
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe("Old");
    expect(v[0].content).toBe("# Old\nbody");
    expect(v[0].created_at).toBe(old); // snapshot stamped with the session's end time
  });

  it("does not snapshot rapid edits within a single session", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const u1 = await put(c.id, h, { content: "# a", base: c.updated_at }); // prev empty → skip
    await put(c.id, h, { content: "# b", base: u1.updated_at }); // tiny gap → skip
    expect(await versions(c.id)).toHaveLength(0);
  });

  it("caps a long continuous run at 1h even without an idle gap", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const now = Date.now();
    // last save was seconds ago (no idle gap) but the run began >1h ago, unsnapshotted
    await backdate(c.id, now - 2 * HOUR, now - 1000, "# Long");
    await put(c.id, h, { content: "# Long edited", base: now - 1000 });
    const v = await versions(c.id);
    expect(v).toHaveLength(1);
    expect(v[0].content).toBe("# Long");
  });

  it("skips an unchanged save even after a gap", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "# Same");
    await put(c.id, h, { content: "# Same", base: old });
    expect(await versions(c.id)).toHaveLength(0);
  });

  it("skips empty initial content even after a gap", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "");
    await put(c.id, h, { content: "# First", base: old });
    expect(await versions(c.id)).toHaveLength(0);
  });

  it("lists versions (no content) and serves a single version's content; purge clears them", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "# Old");
    await put(c.id, h, { content: "# New", base: old });

    const listed = await (await req(`/api/memos/${c.id}/versions`, { headers: h })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Old");
    expect(listed[0].content).toBeUndefined(); // list stays light

    const one = await (
      await req(`/api/memos/${c.id}/versions/${listed[0].id}`, { headers: h })
    ).json();
    expect(one.content).toBe("# Old");

    await req(`/api/memos/${c.id}?purge=1`, { method: "DELETE", headers: h });
    expect(await (await req(`/api/memos/${c.id}/versions`, { headers: h })).json()).toHaveLength(0);
  });

  it("404s a single-version fetch for a non-existent versionId", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "# Old");
    await put(c.id, h, { content: "# New", base: old });
    // a versionId that doesn't exist for this memo → GET /versions/:versionId 404s
    const r = await req(`/api/memos/${c.id}/versions/99999`, { headers: h });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });
});

describe("turnstile enforcement (TURNSTILE_SECRET set)", () => {
  const loginWith = (body: Record<string, unknown>, e: Record<string, unknown>) =>
    app.request(
      "/api/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      e as never
    );

  // stub the Cloudflare siteverify call so the test is deterministic + offline
  function stubSiteverify(success: boolean) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    return () => {
      globalThis.fetch = orig;
    };
  }

  it("rejects login with no token when a secret is configured", async () => {
    const r = await loginWith(
      { username: "tester", password: "pw" },
      { ...env, TURNSTILE_SECRET: "sek" }
    );
    expect(r.status).toBe(403);
  });

  it("rejects login when the token fails verification", async () => {
    const restore = stubSiteverify(false);
    try {
      const r = await loginWith(
        { username: "tester", password: "pw", turnstileToken: "bad" },
        { ...env, TURNSTILE_SECRET: "sek" }
      );
      expect(r.status).toBe(403);
    } finally {
      restore();
    }
  });

  it("accepts login when the token passes verification", async () => {
    const restore = stubSiteverify(true);
    try {
      const r = await loginWith(
        { username: "tester", password: "pw", turnstileToken: "good" },
        { ...env, TURNSTILE_SECRET: "sek" }
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("set-cookie")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("still rejects a wrong password even with a valid token", async () => {
    const restore = stubSiteverify(true);
    try {
      const r = await loginWith(
        { username: "tester", password: "WRONG", turnstileToken: "good" },
        { ...env, TURNSTILE_SECRET: "sek" }
      );
      expect(r.status).toBe(401);
    } finally {
      restore();
    }
  });
});
