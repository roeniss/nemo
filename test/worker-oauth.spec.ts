import { beforeEach, describe, expect, it } from "vitest";
import app, { hashPassword } from "../worker/index";
import { sign } from "hono/jwt";
import { D1 } from "./d1";

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
  hidden_at INTEGER
);
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_refresh (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
`;

let env: Record<string, unknown>;
let db: D1;

beforeEach(async () => {
  db = new D1();
  db.exec(SCHEMA);
  env = { DB: db, JWT_SECRET: "test-secret" };
  await db
    .prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, ?, ?, 0, ?)")
    .bind("tester", PW_HASH, Date.now())
    .run();
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);
const ORIGIN = "http://localhost";
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

async function sessionCookie(): Promise<string> {
  const r = await req("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "tester", password: "pw" }),
  });
  return cookieOf(r);
}

// register a client and return its client_id + a redirect_uri
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
async function registerClient(redirectUris: string[] = [REDIRECT]): Promise<string> {
  const r = await req("/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Claude" }),
  });
  return ((await r.json()) as { client_id: string }).client_id;
}

// PKCE pair: verifier + S256 challenge (computed the same way the server does)
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = "verifier-0123456789-abcdefghijklmnop-XYZ";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const challenge = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { verifier, challenge };
}

const form = (data: Record<string, string>) =>
  ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
  }) satisfies RequestInit;

describe("OAuth discovery", () => {
  it("serves protected-resource metadata", async () => {
    const r = await req("/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    const m = (await r.json()) as any;
    expect(m.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(m.authorization_servers).toEqual([ORIGIN]);
  });

  it("serves authorization-server metadata", async () => {
    const r = await req("/.well-known/oauth-authorization-server");
    const m = (await r.json()) as any;
    expect(m.issuer).toBe(ORIGIN);
    expect(m.authorization_endpoint).toBe(`${ORIGIN}/api/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ORIGIN}/api/oauth/token`);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/api/oauth/register`);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
  });
});

describe("OAuth dynamic client registration", () => {
  it("registers a public client and returns a client_id", async () => {
    const r = await req("/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
    });
    expect(r.status).toBe(201);
    const c = (await r.json()) as any;
    expect(c.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(c.token_endpoint_auth_method).toBe("none");
    const row = await db.prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?").bind(c.client_id).first<any>();
    expect(row.client_name).toBe("Claude");
  });

  it("rejects registration without redirect_uris", async () => {
    const r = await req("/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_redirect_uri");
  });

  it("tolerates a non-JSON body (treated as missing redirect_uris)", async () => {
    const r = await req("/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(400);
  });

  it("defaults client_name to empty when omitted", async () => {
    const r = await req("/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(((await r.json()) as any).client_name).toBe("");
  });
});

describe("OAuth authorize (GET)", () => {
  const base = async (overrides: Record<string, string> = {}) => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      ...overrides,
    });
    return { clientId, url: `/api/oauth/authorize?${params}` };
  };

  it("renders the consent page (logged out → shows login fields)", async () => {
    const { url } = await base();
    const r = await req(url);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Authorize");
    expect(html).toContain('name="password"'); // inline login present when logged out
  });

  it("renders the consent page without login fields when already signed in", async () => {
    const { url } = await base();
    const r = await req(url, { headers: { cookie: await sessionCookie() } });
    const html = await r.text();
    expect(html).not.toContain('name="password"');
    expect(html).toContain("Signed in to nemo.");
  });

  it("rejects a non-code response_type", async () => {
    const { url } = await base({ response_type: "token" });
    expect((await req(url)).status).toBe(400);
  });

  it("requires PKCE S256", async () => {
    const { url } = await base({ code_challenge_method: "plain" });
    const r = await req(url);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("PKCE");
  });

  it("rejects an unknown client", async () => {
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "deadbeef",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect((await req(`/api/oauth/authorize?${params}`)).status).toBe(400);
  });

  it("rejects a redirect_uri the client did not register", async () => {
    const { url } = await base({ redirect_uri: "https://evil.example/cb" });
    expect((await req(url)).status).toBe(400);
  });

  it("treats a garbage session cookie as logged out", async () => {
    const { url } = await base();
    const r = await req(url, { headers: { cookie: "token=not-a-jwt" } });
    expect(await r.text()).toContain('name="password"'); // verify() threw → logged out
  });

  it("treats a valid JWT without a numeric uid as logged out", async () => {
    const { url } = await base();
    const jwt = await sign({ uid: "oops", sub: "tester" }, "test-secret", "HS256");
    const r = await req(url, { headers: { cookie: `token=${jwt}` } });
    expect(await r.text()).toContain('name="password"');
  });

  it("rejects when PKCE params are entirely absent", async () => {
    // only response_type given → all the other query lookups hit their defaults
    const r = await req("/api/oauth/authorize?response_type=code");
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("PKCE");
  });

  it("falls back to a generic name for a client with no client_name", async () => {
    const clientId = await registerClient([REDIRECT]);
    await db.prepare("UPDATE oauth_clients SET client_name = '' WHERE client_id = ?").bind(clientId).run();
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(await (await req(`/api/oauth/authorize?${params}`)).text()).toContain("An application");
  });

  it("escapes the client name to prevent HTML injection", async () => {
    const clientId = await registerClient([REDIRECT]);
    await db.prepare("UPDATE oauth_clients SET client_name = ? WHERE client_id = ?")
      .bind("<script>alert(1)</script>", clientId).run();
    const { challenge } = await pkce();
    const params = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    const html = await (await req(`/api/oauth/authorize?${params}`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// drive a full authorize POST → returns the redirect Location
async function approve(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return req("/api/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authParams() {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  return {
    clientId,
    verifier,
    base: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      state: "st-1",
      scope: "memos",
    } as Record<string, string>,
  };
}

describe("OAuth authorize (POST)", () => {
  it("issues a code via inline login and redirects to the client", async () => {
    const { base } = await authParams();
    const r = await approve({ ...base, decision: "allow", username: "tester", password: "pw" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("st-1");
    const codes = await db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<any>();
    expect(codes.n).toBe(1);
  });

  it("issues a code from an existing session cookie (no inline creds)", async () => {
    const { base } = await authParams();
    const r = await approve({ ...base, decision: "allow" }, { cookie: await sessionCookie() });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("redirects with access_denied when the user denies", async () => {
    const { base } = await authParams();
    const r = await approve({ ...base, decision: "deny" }, { cookie: await sessionCookie() });
    const loc = new URL(r.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-1");
  });

  it("re-renders with an error on bad credentials (no redirect)", async () => {
    const { base } = await authParams();
    const r = await approve({ ...base, decision: "allow", username: "tester", password: "wrong" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Invalid credentials.");
  });

  it("re-renders with an error when no credentials and no session", async () => {
    const { base } = await authParams();
    const r = await approve({ ...base, decision: "allow" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Invalid credentials.");
  });

  it("rejects a bad client / redirect_uri / missing challenge", async () => {
    const { base } = await authParams();
    expect((await approve({ ...base, client_id: "nope", decision: "allow" })).status).toBe(400);
    expect((await approve({ ...base, redirect_uri: "https://evil/cb", decision: "allow" })).status).toBe(400);
    expect((await approve({ ...base, code_challenge: "", decision: "allow" })).status).toBe(400);
  });

  it("rejects a POST with no form fields at all", async () => {
    // every String(form.x ?? "") hits its default → client lookup fails → 400
    const r = await approve({});
    expect(r.status).toBe(400);
  });

  it("re-renders the generic client name on a failed inline login", async () => {
    const { base, clientId } = await authParams();
    await db.prepare("UPDATE oauth_clients SET client_name = '' WHERE client_id = ?").bind(clientId).run();
    const r = await approve({ ...base, decision: "allow", username: "tester", password: "wrong" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("An application");
  });
});

// run a full authorize→token handshake and return the token response JSON
async function fullGrant() {
  const { base, verifier, clientId } = await authParams();
  const a = await approve({ ...base, decision: "allow" }, { cookie: await sessionCookie() });
  const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
  const t = await req("/api/oauth/token", form({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  }));
  return { t, code, verifier, clientId };
}

describe("OAuth token (authorization_code)", () => {
  it("exchanges a code + PKCE verifier for access & refresh tokens", async () => {
    const { t } = await fullGrant();
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toContain("no-store");
    const body = (await t.json()) as any;
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^nemo_/);
    expect(body.refresh_token).toMatch(/^nemo_/);
    expect(body.expires_in).toBe(3600);
    // access token is a real api_tokens row with an expiry
    const row = await db.prepare("SELECT user_id, expires_at FROM api_tokens").first<any>();
    expect(row.user_id).toBe(1);
    expect(row.expires_at).toBeGreaterThan(Date.now());
  });

  it("rejects a missing code or verifier", async () => {
    const r = await req("/api/oauth/token", form({ grant_type: "authorization_code" }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_request");
  });

  it("rejects an unknown / already-used code (single use)", async () => {
    const { code, verifier, clientId } = await fullGrant();
    // reusing the same code fails — it was deleted on first exchange
    const r = await req("/api/oauth/token", form({
      grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT,
    }));
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const { base, verifier, clientId } = await authParams();
    const a = await approve({ ...base, decision: "allow" }, { cookie: await sessionCookie() });
    const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
    await db.prepare("UPDATE oauth_codes SET expires_at = ? WHERE 1=1").bind(Date.now() - 1).run();
    const r = await req("/api/oauth/token", form({
      grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT,
    }));
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a client_id / redirect_uri mismatch", async () => {
    const { base, verifier } = await authParams();
    const a = await approve({ ...base, decision: "allow" }, { cookie: await sessionCookie() });
    const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
    const r = await req("/api/oauth/token", form({
      grant_type: "authorization_code", code, code_verifier: verifier, client_id: "different", redirect_uri: REDIRECT,
    }));
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects a wrong PKCE verifier", async () => {
    const { base, clientId } = await authParams();
    const a = await approve({ ...base, decision: "allow" }, { cookie: await sessionCookie() });
    const code = new URL(a.headers.get("location")!).searchParams.get("code")!;
    const r = await req("/api/oauth/token", form({
      grant_type: "authorization_code", code, code_verifier: "wrong-verifier", client_id: clientId, redirect_uri: REDIRECT,
    }));
    expect(((await r.json()) as any).error_description).toContain("PKCE");
  });
});

describe("OAuth token (refresh + errors)", () => {
  it("mints a fresh access token from a refresh token", async () => {
    const { t } = await fullGrant();
    const refresh = ((await t.json()) as any).refresh_token;
    const r = await req("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: refresh }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.access_token).toMatch(/^nemo_/);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<any>();
    expect(count.n).toBe(2); // original + refreshed
  });

  it("rejects a missing refresh token", async () => {
    const r = await req("/api/oauth/token", form({ grant_type: "refresh_token" }));
    expect(((await r.json()) as any).error).toBe("invalid_request");
  });

  it("rejects an unknown / revoked refresh token", async () => {
    const { t } = await fullGrant();
    const refresh = ((await t.json()) as any).refresh_token;
    await db.prepare("UPDATE oauth_refresh SET revoked_at = ? WHERE 1=1").bind(Date.now()).run();
    const r = await req("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: refresh }));
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });

  it("rejects an unsupported grant_type", async () => {
    const r = await req("/api/oauth/token", form({ grant_type: "password" }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("unsupported_grant_type");
  });

  it("rejects a request with no grant_type at all", async () => {
    const r = await req("/api/oauth/token", form({}));
    expect(((await r.json()) as any).error).toBe("unsupported_grant_type");
  });
});

describe("OAuth end-to-end → MCP", () => {
  it("the issued access token authenticates a real MCP call", async () => {
    const { t } = await fullGrant();
    const access = ((await t.json()) as any).access_token;
    const r = await req("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_memo", arguments: { content: "from claude" } } }),
    });
    const body = (await r.json()) as any;
    expect(body.result.content[0].text).toContain("created");
    const memo = await db.prepare("SELECT user_id, content FROM memos").first<any>();
    expect(memo.user_id).toBe(1);
    expect(memo.content).toBe("# from claude");
  });
});
