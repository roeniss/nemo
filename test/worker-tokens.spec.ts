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
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
`;

let env: Record<string, unknown>;

beforeEach(() => {
  const db = new D1();
  db.exec(SCHEMA);
  env = { DB: db, AUTH_USER: "tester", AUTH_PASS: PW_HASH, JWT_SECRET: "test-secret" };
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);

const login = () =>
  req("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "pw" }),
  });

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

async function cookie() {
  return cookieOf(await login());
}

// mint a token via the JWT-gated management route; returns the one-time plaintext
async function mint(label?: string) {
  const r = await req("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await cookie() },
    body: JSON.stringify(label === undefined ? {} : { label }),
  });
  return { status: r.status, body: (await r.json()) as { token: string; label: string; id: number } };
}

describe("token management (JWT-gated)", () => {
  it("requires auth to list/create/revoke", async () => {
    expect((await req("/api/tokens")).status).toBe(401);
    expect((await req("/api/tokens", { method: "POST" })).status).toBe(401);
    expect((await req("/api/tokens/1", { method: "DELETE" })).status).toBe(401);
  });

  it("creates a token, returning the plaintext exactly once", async () => {
    const { status, body } = await mint("iPhone Siri");
    expect(status).toBe(201);
    expect(body.token).toMatch(/^nemo_[0-9a-f]{64}$/);
    expect(body.label).toBe("iPhone Siri");
    // the plaintext is never queryable afterwards — the list omits it
    const list = (await (
      await req("/api/tokens", { headers: { cookie: await cookie() } })
    ).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("token");
    expect(list[0]).not.toHaveProperty("token_hash");
    expect(list[0].last_used_at).toBeNull();
  });

  it("defaults the label to empty for a bodyless/blank create", async () => {
    // malformed body -> caught -> label "" ; {} body -> label undefined -> ""
    const malformed = await req("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookie() },
      body: "not json",
    });
    expect(malformed.status).toBe(201);
    const { body } = await mint(); // {} -> label undefined
    expect(body.label).toBe("");
  });

  it("revoke removes a token from the list and stops it authenticating", async () => {
    const { body } = await mint("temp");
    const del = await req(`/api/tokens/${body.id}`, {
      method: "DELETE",
      headers: { cookie: await cookie() },
    });
    expect(del.status).toBe(200);
    const list = (await (
      await req("/api/tokens", { headers: { cookie: await cookie() } })
    ).json()) as unknown[];
    expect(list).toHaveLength(0);

    // the revoked token no longer works on the integration surface
    const r = await req("/api/ext/memos", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(r.status).toBe(401);
  });
});

describe("integration surface /api/ext/memos (Bearer-gated)", () => {
  const ext = (token: string | null, body?: unknown) =>
    req("/api/ext/memos", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("rejects a missing or malformed Authorization header", async () => {
    expect((await ext(null, { content: "x" })).status).toBe(401);
    // a non-Bearer scheme is treated as no token
    const basic = await req("/api/ext/memos", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Basic abc" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(basic.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    expect((await ext("nemo_deadbeef", { content: "x" })).status).toBe(401);
  });

  it("creates a memo from content with a valid token", async () => {
    const { body } = await mint("siri");
    const r = await ext(body.token, { content: "TODO: make a shower" });
    expect(r.status).toBe(201);
    const memo = (await r.json()) as { id: number; title: string; content: string };
    expect(memo.title).toBe("TODO: make a shower");
    expect(memo.content).toBe("TODO: make a shower");

    // a successful call stamps last_used_at, surfaced in the settings list
    const list = (await (
      await req("/api/tokens", { headers: { cookie: await cookie() } })
    ).json()) as Array<{ last_used_at: number | null }>;
    expect(list[0].last_used_at).not.toBeNull();
  });

  it("rejects empty, blank, or missing content with 400", async () => {
    const { body } = await mint("siri");
    expect((await ext(body.token, { content: "" })).status).toBe(400);
    expect((await ext(body.token, { content: "   " })).status).toBe(400);
    // no body at all -> JSON parse caught -> content undefined
    expect((await ext(body.token)).status).toBe(400);
  });
});
