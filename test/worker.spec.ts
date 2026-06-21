import { beforeEach, describe, expect, it } from "vitest";
import app, { hashPassword, verifyPassword } from "../worker/index";
import { sign, decode } from "hono/jwt";
import { D1 } from "./d1";

// AUTH_PASS is stored as a PBKDF2 hash; mint one once for the test password.
const PW_HASH = await hashPassword("pw");

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
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden_at INTEGER,
  published_at INTEGER
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

beforeEach(async () => {
  const db = new D1();
  db.exec(SCHEMA);
  env = { DB: db, JWT_SECRET: "test-secret" };
  // Seed a user
  await db.prepare(
    "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, ?, ?, 1, ?)"
  ).bind("tester", PW_HASH, Date.now()).run();
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

describe("sliding session", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  // a signed session cookie whose token has `expOffsetSec` left to live (exp is
  // always issuedAt + 7d, so a smaller offset == issued longer ago)
  const cookieWithExp = async (expOffsetSec: number) => {
    const t = await sign({ sub: "tester", uid: 1, admin: true, exp: nowSec() + expOffsetSec }, "test-secret");
    return `token=${t}`;
  };

  it("does NOT re-issue a freshly-issued token (< 1 day old)", async () => {
    const cookie = await cookieWithExp(60 * 60 * 24 * 7); // full 7d left → just issued
    const r = await req("/api/me", { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull(); // no sliding refresh
  });

  it("re-issues a token older than 1 day, sliding the 7d window forward", async () => {
    const cookie = await cookieWithExp(60 * 60 * 24 * 5); // 5d left → issued ~2d ago
    const r = await req("/api/me", { headers: { cookie } });
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("token=");
    expect(setCookie).toContain("Max-Age=604800"); // a fresh 7d cookie
    const fresh = setCookie.match(/token=([^;]+)/)![1];
    const { payload } = decode(fresh);
    // exp pushed back out to ~now + 7d, with the identity claims preserved
    expect((payload.exp as number) - nowSec()).toBeGreaterThan(60 * 60 * 24 * 6);
    expect(payload.sub).toBe("tester");
    expect(payload.uid).toBe(1);
    expect(payload.admin).toBe(true);
  });

  it("does not re-issue a token missing identity claims (defensive guard)", async () => {
    // valid signature + exp but no uid → slideSession bails without re-issuing
    const t = await sign({ sub: "tester", exp: nowSec() + 60 * 60 * 24 * 5 }, "test-secret");
    const r = await req("/api/me", { headers: { cookie: `token=${t}` } });
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("password hashing", () => {
  it("mints a salted pbkdf2 string and round-trips", async () => {
    const h = await hashPassword("hunter2");
    expect(h).toMatch(/^pbkdf2:100000:/);
    expect(await verifyPassword("hunter2", h)).toBe(true);
    expect(await verifyPassword("nope", h)).toBe(false);
  });

  it("uses a fresh salt per call", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("fails closed on a non-hash (e.g. stale plaintext) secret", async () => {
    expect(await verifyPassword("pw", "pw")).toBe(false);
    expect(await verifyPassword("pw", "pbkdf2:100000:bad")).toBe(false);
  });

  it("fails closed when pbkdf2 throws (e.g. absurdly high iteration count)", async () => {
    // A well-formed pbkdf2: string but with an iteration count so high the
    // runtime rejects it — exercises the catch branch at line ~115.
    const badHash = `pbkdf2:999999999999:c2FsdA==:aGFzaA==`;
    expect(await verifyPassword("pw", badHash)).toBe(false);
  });

  it("returns false when stored hash decodes to different length (timingSafeEqual length guard)", async () => {
    // pbkdf2 always produces 32 bytes; encode only 1 byte so lengths differ
    const saltB64 = btoa(String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16));
    const shortHashB64 = btoa("x"); // 1 byte, not 32
    const stored = `pbkdf2:100000:${saltB64}:${shortHashB64}`;
    expect(await verifyPassword("pw", stored)).toBe(false);
  });
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
    const row = await (env.DB as D1).prepare("SELECT id FROM memos WHERE id = ?").bind(c.id).first();
    expect(row).not.toBeNull();
  });

  it("hard-purges with ?purge=1 (not recoverable from trash)", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}?purge=1`, { method: "DELETE", headers: h });
    expect(await (await req("/api/trash", { headers: h })).json()).toHaveLength(0);
    const row = await (env.DB as D1).prepare("SELECT id FROM memos WHERE id = ?").bind(c.id).first();
    expect(row).toBeNull();
  });

  it("user A cannot access user B's memos", async () => {
    const db = env.DB as D1;
    // Seed user 2
    const pw2 = await hashPassword("pw2");
    await db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, ?, ?, 0, ?)"
    ).bind("tester2", pw2, Date.now()).run();

    // User 1 creates a memo
    const h1 = await authedHeaders();
    const memo = await (await req("/api/memos", { method: "POST", headers: h1 })).json();
    await req(`/api/memos/${memo.id}`, {
      method: "PUT",
      headers: h1,
      body: JSON.stringify({ content: "# Secret", base: memo.updated_at }),
    });

    // User 2 logs in
    const r2 = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester2", password: "pw2" }),
    });
    const h2 = { "content-type": "application/json", cookie: cookieOf(r2) };

    // User 2 cannot see user 1's memo in list
    const list = await (await req("/api/memos", { headers: h2 })).json() as unknown[];
    expect(list).toHaveLength(0);

    // User 2 cannot fetch user 1's memo directly
    expect((await req(`/api/memos/${memo.id}`, { headers: h2 })).status).toBe(404);
  });
});

describe("publish (public /p/:id page)", () => {
  const mk = async (h: HeadersInit, content: string) => {
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}`, { method: "PUT", headers: h, body: JSON.stringify({ content }) });
    return c.id as number;
  };

  it("404s for an unpublished or nonexistent memo", async () => {
    const h = await authedHeaders();
    const id = await mk(h, "# Secret");
    expect((await req(`/p/${id}`)).status).toBe(404);
    expect((await req("/p/999999")).status).toBe(404);
  });

  it("publishes, serves rendered HTML with a no-script CSP, then unpublishes", async () => {
    const h = await authedHeaders();
    const id = await mk(h, "# Title\n\n**bold**");
    const pub = await req(`/api/memos/${id}/publish`, { method: "POST", headers: h });
    expect(pub.status).toBe(200);
    expect((await pub.json()).url).toBe(`/p/${id}`);

    const page = await req(`/p/${id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src");
    const body = await page.text();
    expect(body).toContain("<strong>bold</strong>");
    expect(body).toContain("<title>Title</title>");

    await req(`/api/memos/${id}/publish`, { method: "DELETE", headers: h });
    expect((await req(`/p/${id}`)).status).toBe(404);
  });

  it("escapes the title and is idempotent on re-publish", async () => {
    const h = await authedHeaders();
    const id = await mk(h, "# a <b> & \"c\"");
    await req(`/api/memos/${id}/publish`, { method: "POST", headers: h });
    await req(`/api/memos/${id}/publish`, { method: "POST", headers: h }); // re-publish: no error
    const body = await (await req(`/p/${id}`)).text();
    expect(body).toContain("<title>a &lt;b&gt; &amp; &quot;c&quot;</title>");
  });

  it("404s when publishing a memo that doesn't exist", async () => {
    const h = await authedHeaders();
    expect((await req("/api/memos/999999/publish", { method: "POST", headers: h })).status).toBe(404);
  });
});

describe("search", () => {
  const mk = async (h: HeadersInit, content: string) => {
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    await req(`/api/memos/${c.id}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content, base: c.updated_at }),
    });
    return c.id as number;
  };
  const search = async (h: HeadersInit, q: string) =>
    (await (await req(`/api/search?q=${encodeURIComponent(q)}`, { headers: h })).json()) as {
      id: number;
    }[];

  it("matches by title and by body, excluding non-matches", async () => {
    const h = await authedHeaders();
    const byTitle = await mk(h, "# Banana bread\nplain instructions");
    const byBody = await mk(h, "# Dessert\nmash one ripe banana into the bowl");
    const miss = await mk(h, "# Cherry pie\nno yellow fruit here");

    const ids = (await search(h, "banana")).map((m) => m.id);
    expect(ids).toContain(byTitle); // title hit
    expect(ids).toContain(byBody); // body-only hit
    expect(ids).not.toContain(miss);
  });

  it("excludes trashed memos from results", async () => {
    const h = await authedHeaders();
    const id = await mk(h, "# keepaway\na secret pineapple note");
    await req(`/api/memos/${id}`, { method: "DELETE", headers: h }); // soft delete
    expect(await search(h, "pineapple")).toHaveLength(0);
  });

  it("returns nothing for a blank query and treats LIKE wildcards literally", async () => {
    const h = await authedHeaders();
    await mk(h, "# plain\nordinary body");
    expect(await search(h, "")).toEqual([]);
    expect(await (await req("/api/search", { headers: h })).json()).toEqual([]); // no q param at all
    expect(await search(h, "   ")).toEqual([]); // whitespace-only trims to blank
    // an unescaped "%" would match everything — escaped, it matches a literal percent
    expect(await search(h, "%")).toHaveLength(0);
  });

  it("requires authentication", async () => {
    expect((await req("/api/search?q=x")).status).toBe(401);
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
    return (env.DB as D1)
      .prepare(
        "UPDATE memos SET created_at = ?, updated_at = ?, content = ?, title = ? WHERE id = ?"
      )
      .bind(created_at, updated_at, content, title, id)
      .run();
  };
  const versions = async (id: number) =>
    (
      await (env.DB as D1)
        .prepare(
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

  it("purge clears a memo's snapshots along with it", async () => {
    const h = await authedHeaders();
    const c = await create(h);
    const old = Date.now() - 2 * HOUR;
    await backdate(c.id, old, old, "# Old");
    await put(c.id, h, { content: "# New", base: old });
    expect(await versions(c.id)).toHaveLength(1);

    await req(`/api/memos/${c.id}?purge=1`, { method: "DELETE", headers: h });
    expect(await versions(c.id)).toHaveLength(0);
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
