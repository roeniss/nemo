import { beforeEach, describe, expect, it } from "vitest";
import app, { hashPassword } from "../worker/index";
import { D1 } from "./d1";

// AUTH_PASS is stored as a PBKDF2 hash; mint one once for the test password.
const PW_HASH = await hashPassword("pw");

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
  env = { DB: db, AUTH_USER: "tester", AUTH_PASS: PW_HASH, JWT_SECRET: "test-secret" };
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

describe("logout", () => {
  it("returns {ok:true} and clears the token cookie", async () => {
    const r = await req("/api/logout", { method: "POST" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    // deleteCookie emits a set-cookie that empties the token + expires it
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("token=");
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);
  });
});

describe("me", () => {
  it("returns {ok:true} with a valid cookie", async () => {
    const h = await authedHeaders();
    const r = await req("/api/me", { headers: h });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("returns 401 without auth", async () => {
    expect((await req("/api/me")).status).toBe(401);
  });
});

describe("memo edge cases", () => {
  it("GET /api/memos/:id returns the full row for an existing memo", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    const r = await req(`/api/memos/${c.id}`, { headers: h });
    expect(r.status).toBe(200);
    const row = await r.json();
    expect(row.id).toBe(c.id);
    expect(row.title).toBe("Untitled");
    expect(row.content).toBe("");
  });

  it("GET /api/memos/:id for a non-existent id returns 404 {error:'not found'}", async () => {
    const h = await authedHeaders();
    const r = await req("/api/memos/9999", { headers: h });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });

  it("PUT with base omitted force-overwrites without a conflict check", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    // no `base` field => skip optimistic concurrency entirely
    const r = await req(`/api/memos/${c.id}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "# Forced" }),
    });
    expect(r.status).toBe(200);
    const u = await r.json();
    expect(u.ok).toBe(true);
    expect(u.title).toBe("Forced");
  });

  it("PUT with whitespace-only content derives the 'Untitled' title", async () => {
    const h = await authedHeaders();
    const c = await (await req("/api/memos", { method: "POST", headers: h })).json();
    const r = await req(`/api/memos/${c.id}`, {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "   \n  \n", base: c.updated_at }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).title).toBe("Untitled");
  });

  it("PUT with base set on a non-existent id returns 404", async () => {
    const h = await authedHeaders();
    const r = await req("/api/memos/9999", {
      method: "PUT",
      headers: h,
      body: JSON.stringify({ content: "x", base: Date.now() }),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });
});

describe("turnstile client ip", () => {
  // covers verifyTurnstile's `if (ip) form.append("remoteip", ip)` branch: when a
  // cf-connecting-ip header is present, the client IP is forwarded to siteverify.
  it("forwards cf-connecting-ip to the siteverify call", async () => {
    const orig = globalThis.fetch;
    let forwardedIp: FormDataEntryValue | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      forwardedIp = (init?.body as FormData).get("remoteip");
      return new Response(JSON.stringify({ success: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const r = await app.request(
        "/api/login",
        {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
          body: JSON.stringify({ username: "tester", password: "pw", turnstileToken: "good" }),
        },
        { ...env, TURNSTILE_SECRET: "sek" } as never
      );
      expect(r.status).toBe(200);
      expect(forwardedIp).toBe("203.0.113.7");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
