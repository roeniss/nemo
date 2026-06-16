// OAuth 2.1 authorization layer for the remote MCP server. Makes nemo a
// self-hosted Authorization Server (issues tokens) + Resource Server (the
// /api/mcp endpoint from part 1 validates them). This is what lets Claude
// web/mobile connectors obtain a token on their own instead of the user pasting
// one: discovery → dynamic client registration → authorize (reusing nemo's own
// login) → PKCE-protected code exchange → Bearer token on /api/mcp.
//
// Implemented entirely server-side (server-rendered consent HTML), so no SPA
// changes and the whole flow is unit-testable.
import type { Hono } from "hono";
import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";
import type { Bindings, Variables } from "./index";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

type Deps = {
  hashToken: (token: string) => Promise<string>; // SHA-256 hex (shared with api_tokens)
  newToken: () => string; // random "nemo_<hex>" secret
  verifyPassword: (password: string, stored: string) => Promise<boolean>;
};

const COOKIE = "token";
const ACCESS_TTL = 3600; // access token lifetime (seconds)
const CODE_TTL = 600 * 1000; // authorization code lifetime (ms)

// --- small crypto / encoding helpers -------------------------------------
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// PKCE S256: base64url(SHA-256(verifier)) must equal the stored challenge
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// resolve the logged-in user from the nemo session cookie, if any
async function userFromCookie(c: { req: { raw: Request }; env: Bindings }): Promise<number | null> {
  const token = getCookie(c as never, COOKIE);
  if (!token) return null;
  try {
    const payload = await verify(token, c.env.JWT_SECRET, "HS256");
    return typeof payload.uid === "number" ? payload.uid : null;
  } catch {
    return null; // expired / tampered cookie → treat as logged out
  }
}

// --- server-rendered consent page ----------------------------------------
type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string;
};

function hidden(p: AuthorizeParams): string {
  return (Object.keys(p) as (keyof AuthorizeParams)[])
    .map((k) => `<input type="hidden" name="${k}" value="${htmlEscape(p[k])}">`)
    .join("");
}

function consentPage(opts: {
  clientName: string;
  params: AuthorizeParams;
  loggedIn: boolean;
  error?: string;
}): string {
  const { clientName, params, loggedIn, error } = opts;
  const login = loggedIn
    ? ""
    : `<label>ID<input name="username" autocomplete="username" required></label>
       <label>Password<input name="password" type="password" autocomplete="current-password" required></label>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${htmlEscape(clientName)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:10vh auto;padding:0 20px}
form{display:flex;flex-direction:column;gap:12px}label{display:flex;flex-direction:column;gap:4px;font-size:14px}
input{padding:8px;font-size:16px}.row{flex-direction:row;gap:8px}button{padding:10px;font-size:15px;cursor:pointer}
.err{color:#c0392b;font-size:13px}.muted{color:#888;font-size:13px}</style></head>
<body><h1>Authorize access</h1>
<p><strong>${htmlEscape(clientName)}</strong> wants to access your nemo memos (read &amp; write).</p>
${error ? `<p class="err">${htmlEscape(error)}</p>` : ""}
<form method="post" action="/api/oauth/authorize">
${hidden(params)}${login}
<div class="row"><button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div>
</form>
<p class="muted">${loggedIn ? "Signed in to nemo." : "Sign in to nemo to continue."}</p>
</body></html>`;
}

// append query params to a redirect URI, preserving any it already carries
function redirectWith(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// --- route registration --------------------------------------------------
export function registerOAuth(app: App, deps: Deps): void {
  // RFC 9728 — protected resource metadata. Points Claude at this server as its
  // own authorization server.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 — authorization server metadata.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["memos"],
    });
  });

  // RFC 7591 — dynamic client registration. Public clients (Claude) self-register
  // and get a client_id; no client_secret (PKCE secures the exchange).
  app.post("/api/oauth/register", async (c) => {
    const body = await c.req
      .json<{ redirect_uris?: unknown; client_name?: unknown }>()
      .catch(() => ({}) as { redirect_uris?: unknown; client_name?: unknown });
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (uris.length === 0) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris required" }, 400);
    }
    const clientId = randomId();
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "";
    await c.env.DB.prepare(
      "INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(clientId, JSON.stringify(uris), name, Date.now())
      .run();
    return c.json(
      {
        client_id: clientId,
        redirect_uris: uris,
        client_name: name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201
    );
  });

  // look up a registered client and confirm the redirect_uri is one it registered
  async function validClient(c: { env: Bindings }, clientId: string, redirectUri: string) {
    const row = await c.env.DB.prepare(
      "SELECT client_id, redirect_uris, client_name FROM oauth_clients WHERE client_id = ?"
    )
      .bind(clientId)
      .first<{ client_id: string; redirect_uris: string; client_name: string }>();
    if (!row) return null;
    const uris = JSON.parse(row.redirect_uris) as string[];
    if (!uris.includes(redirectUri)) return null;
    return row;
  }

  // GET /authorize — show the consent page (with inline login if logged out).
  app.get("/api/oauth/authorize", async (c) => {
    const q = c.req.query();
    const params: AuthorizeParams = {
      client_id: q.client_id ?? "",
      redirect_uri: q.redirect_uri ?? "",
      code_challenge: q.code_challenge ?? "",
      state: q.state ?? "",
      scope: q.scope ?? "memos",
    };
    // validation errors here must NOT redirect (the redirect_uri isn't trusted yet)
    if (q.response_type !== "code") return c.text("unsupported_response_type", 400);
    if ((q.code_challenge_method ?? "") !== "S256" || !params.code_challenge) {
      return c.text("invalid_request: PKCE S256 required", 400);
    }
    const client = await validClient(c, params.client_id, params.redirect_uri);
    if (!client) return c.text("invalid_client or redirect_uri", 400);

    const uid = await userFromCookie(c);
    return c.html(consentPage({ clientName: client.client_name || "An application", params, loggedIn: uid != null }));
  });

  // POST /authorize — resolve the user (cookie or inline login), then allow/deny.
  app.post("/api/oauth/authorize", async (c) => {
    const form = await c.req.parseBody();
    const params: AuthorizeParams = {
      client_id: String(form.client_id ?? ""),
      redirect_uri: String(form.redirect_uri ?? ""),
      code_challenge: String(form.code_challenge ?? ""),
      state: String(form.state ?? ""),
      scope: String(form.scope ?? "memos"),
    };
    const client = await validClient(c, params.client_id, params.redirect_uri);
    if (!client || !params.code_challenge) return c.text("invalid_request", 400);
    const clientName = client.client_name || "An application";

    // deny → bounce back to the client with an OAuth error
    if (form.decision === "deny") {
      return c.redirect(redirectWith(params.redirect_uri, { error: "access_denied", state: params.state }));
    }

    // resolve the acting user: existing session cookie, else inline credentials
    let uid = await userFromCookie(c);
    if (uid == null && form.username && form.password) {
      const user = await c.env.DB.prepare(
        "SELECT id, password_hash FROM users WHERE username = ?"
      )
        .bind(String(form.username))
        .first<{ id: number; password_hash: string }>();
      if (user && (await deps.verifyPassword(String(form.password), user.password_hash))) uid = user.id;
    }
    if (uid == null) {
      // bad/absent credentials → re-render the page with an error (no redirect)
      return c.html(
        consentPage({ clientName, params, loggedIn: false, error: "Invalid credentials." }),
        400
      );
    }

    // mint a single-use, short-lived authorization code bound to the PKCE challenge
    const code = deps.newToken();
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(await deps.hashToken(code), params.client_id, uid, params.redirect_uri, params.code_challenge, params.scope, now + CODE_TTL, now)
      .run();
    return c.redirect(redirectWith(params.redirect_uri, { code, state: params.state }));
  });

  // issue an access token (stored as an api_tokens row so part 1's MCP middleware
  // validates it unchanged) plus a refresh token
  async function issueTokens(c: { env: Bindings }, userId: number, clientId: string, scope: string) {
    const now = Date.now();
    const access = deps.newToken();
    const refresh = deps.newToken();
    await c.env.DB.prepare(
      "INSERT INTO api_tokens (label, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(`mcp-oauth:${clientId}`, await deps.hashToken(access), userId, now, now + ACCESS_TTL * 1000)
      .run();
    await c.env.DB.prepare(
      "INSERT INTO oauth_refresh (token_hash, client_id, user_id, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(await deps.hashToken(refresh), clientId, userId, now)
      .run();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope,
    };
  }

  // POST /token — authorization_code (with PKCE) and refresh_token grants
  app.post("/api/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const grant = String(form.grant_type ?? "");
    c.header("Cache-Control", "no-store");
    const oauthError = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400);

    if (grant === "authorization_code") {
      const code = String(form.code ?? "");
      const verifier = String(form.code_verifier ?? "");
      const clientId = String(form.client_id ?? "");
      const redirectUri = String(form.redirect_uri ?? "");
      if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier required");
      const row = await c.env.DB.prepare(
        "SELECT client_id, user_id, redirect_uri, code_challenge, scope, expires_at FROM oauth_codes WHERE code_hash = ?"
      )
        .bind(await deps.hashToken(code))
        .first<{ client_id: string; user_id: number; redirect_uri: string; code_challenge: string; scope: string; expires_at: number }>();
      // single-use: delete on any lookup hit, valid or not
      if (row) {
        await c.env.DB.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").bind(await deps.hashToken(code)).run();
      }
      if (!row || row.expires_at < Date.now()) return oauthError("invalid_grant", "code invalid or expired");
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
        return oauthError("invalid_grant", "client_id / redirect_uri mismatch");
      }
      if ((await s256(verifier)) !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");
      return c.json(await issueTokens(c, row.user_id, row.client_id, row.scope));
    }

    if (grant === "refresh_token") {
      const refresh = String(form.refresh_token ?? "");
      if (!refresh) return oauthError("invalid_request", "refresh_token required");
      const row = await c.env.DB.prepare(
        "SELECT client_id, user_id FROM oauth_refresh WHERE token_hash = ? AND revoked_at IS NULL"
      )
        .bind(await deps.hashToken(refresh))
        .first<{ client_id: string; user_id: number }>();
      if (!row) return oauthError("invalid_grant", "refresh token invalid");
      return c.json(await issueTokens(c, row.user_id, row.client_id, "memos"));
    }

    return oauthError("unsupported_grant_type", `unsupported grant_type: ${grant}`);
  });
}
