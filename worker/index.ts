import { Hono } from "hono";
import { sign, jwt } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Context } from "hono";

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  TURNSTILE_SECRET?: string; // bot protection — enforced only when set
  // history snapshot thresholds (ms); default to 1h. Overridden small in dev/e2e.
  HISTORY_GAP_MS?: string;
  HISTORY_SESSION_MS?: string;
};

type Variables = {
  extUserId: number;
  jwtPayload: Record<string, unknown>;
};

const COOKIE = "token";
const MAX_AGE = 60 * 60 * 24 * 7; // 7d
const HOUR = 60 * 60 * 1000;

// idle gap that ends an editing session, and the max a session can run before we
// snapshot anyway — both default to 1h, so a memo gets at most ~one snapshot/hour.
const sessionGap = (env: Bindings) => Number(env.HISTORY_GAP_MS) || HOUR;
const maxSession = (env: Bindings) => Number(env.HISTORY_SESSION_MS) || HOUR;

// --- api tokens (external integration auth) -----------------------------
// Tokens for the /api/ext/* surface are stored hashed (SHA-256). The plaintext
// is shown to the user once at creation (POST /api/tokens) and never persisted,
// so a DB leak can't be replayed against the integration API.
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "nemo_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// --- login password hashing (PBKDF2-HMAC-SHA256) ------------------------
// The login password is never stored plaintext: password_hash holds a salted
// PBKDF2 hash in the form `pbkdf2:<iters>:<saltB64>:<hashB64>`. bcrypt/argon2
// aren't available on the Workers runtime, so we use WebCrypto's PBKDF2. The
// fields are `:`-delimited (not the PHC-conventional `$`) so the value survives
// dotenv variable-expansion when it lives in .dev.vars — `$` would be mangled.
// Mint a value with `node scripts/hash-password.mjs`.
// Cloudflare Workers caps PBKDF2 at 100k iterations (above that, deriveBits
// throws NotSupportedError) — so 100k is the ceiling here, not OWASP's higher
// baseline. verifyPassword reads the iteration count from the stored hash, so
// old hashes minted at a higher count won't silently re-hash differently.
const PBKDF2_ITERS = 100_000;
const PBKDF2_PREFIX = "pbkdf2:";

const b64encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));
const b64decode = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return new Uint8Array(bits);
}

// constant-time byte compare — avoids leaking how many leading bytes matched
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `${PBKDF2_PREFIX}${PBKDF2_ITERS}:${b64encode(salt)}:${b64encode(hash)}`;
}

// Verify a login attempt against the stored password_hash, which must be a
// pbkdf2: hash (mint it with scripts/hash-password.mjs). Anything else — incl.
// a stale plaintext secret — fails closed.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(PBKDF2_PREFIX)) return false;
  const [, itersStr, saltB64, hashB64] = stored.split(":");
  const iterations = Number(itersStr);
  if (!iterations || !saltB64 || !hashB64) return false;
  // Fail closed (not 500) if the stored hash is malformed or asks the runtime
  // for something it rejects — e.g. an iteration count above the Workers cap.
  try {
    const actual = await pbkdf2(password, b64decode(saltB64), iterations);
    return timingSafeEqual(actual, b64decode(hashB64));
  } catch {
    return false;
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- user helper --------------------------------------------------------
function getUser(c: Context<{ Bindings: Bindings; Variables: Variables }>): { uid: number; username: string; admin: boolean } {
  const p = c.get("jwtPayload");
  return { uid: p.uid as number, username: p.sub as string, admin: !!p.admin };
}

// --- auth ---------------------------------------------------------------
async function verifyTurnstile(token: string, secret: string, ip: string | null): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

app.post("/api/login", async (c) => {
  const { username, password, turnstileToken } = await c.req.json<{
    username: string;
    password: string;
    turnstileToken?: string;
  }>();

  // Turnstile bot protection — only enforced when a secret is configured,
  // so the app keeps working before the keys are set up.
  if (c.env.TURNSTILE_SECRET) {
    const ip = c.req.header("cf-connecting-ip") ?? null;
    const ok = turnstileToken
      ? await verifyTurnstile(turnstileToken, c.env.TURNSTILE_SECRET, ip)
      : false;
    if (!ok) return c.json({ error: "verification failed" }, 403);
  }

  const user = await c.env.DB.prepare(
    "SELECT id, password_hash, is_admin FROM users WHERE username = ?"
  ).bind(username).first<{ id: number; password_hash: string; is_admin: number }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .bind(Date.now(), user.id).run();

  const token = await sign(
    { sub: username, uid: user.id, admin: user.is_admin === 1, exp: Math.floor(Date.now() / 1000) + MAX_AGE },
    c.env.JWT_SECRET
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// --- WebAuthn / passkey endpoints ----------------------------------------
const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

// Clean up expired challenges (best-effort, called lazily on each challenge request)
async function cleanupChallenges(db: D1Database) {
  const cutoff = Date.now() - CHALLENGE_TTL;
  await db.prepare("DELETE FROM webauthn_challenges WHERE created_at < ?").bind(cutoff).run();
}

// POST /api/passkey/auth/options — generate authentication challenge (pre-login, no JWT needed)
app.post("/api/passkey/auth/options", async (c) => {
  await cleanupChallenges(c.env.DB);
  const { results: creds } = await c.env.DB.prepare(
    "SELECT credential_id, transports FROM webauthn_credentials"
  ).all<{ credential_id: string; transports: string | null }>();

  const options = await generateAuthenticationOptions({
    rpID: c.req.header("host")?.split(":")[0] ?? "localhost",
    allowCredentials: creds.map((cr) => ({
      id: cr.credential_id,
      transports: cr.transports
        ? (JSON.parse(cr.transports) as AuthenticatorTransportFuture[])
        : undefined,
    })),
    userVerification: "preferred",
  });

  // Store the challenge
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO webauthn_challenges (challenge, created_at) VALUES (?, ?)"
  ).bind(options.challenge, Date.now()).run();

  return c.json(options);
});

// POST /api/passkey/auth/verify — verify authentication, issue JWT (pre-login, no JWT needed)
app.post("/api/passkey/auth/verify", async (c) => {
  const body = await c.req.json<{ response: unknown; challenge: string }>();
  const { challenge } = body;

  // Look up and consume the challenge
  const row = await c.env.DB.prepare(
    "SELECT id, created_at FROM webauthn_challenges WHERE challenge = ?"
  ).bind(challenge).first<{ id: number; created_at: number }>();
  if (!row || Date.now() - row.created_at > CHALLENGE_TTL) {
    return c.json({ error: "invalid or expired challenge" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();

  // Look up the credential
  const credId = (body.response as { id?: string }).id ?? "";
  const cred = await c.env.DB.prepare(
    "SELECT credential_id, public_key, counter, transports, user_id FROM webauthn_credentials WHERE credential_id = ?"
  ).bind(credId).first<{ credential_id: string; public_key: string; counter: number; transports: string | null; user_id: number }>();
  if (!cred) return c.json({ error: "credential not found" }, 401);

  const rpID = c.req.header("host")?.split(":")[0] ?? "localhost";
  const expectedOrigin = c.req.header("origin") ?? `https://${rpID}`;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: cred.credential_id,
        publicKey: Uint8Array.from(atob(cred.public_key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
        counter: cred.counter,
        transports: cred.transports
          ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
    });
  } catch (err) {
    return c.json({ error: "verification failed" }, 401);
  }

  if (!verification.verified) return c.json({ error: "verification failed" }, 401);

  // Update counter
  await c.env.DB.prepare(
    "UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?"
  ).bind(verification.authenticationInfo.newCounter, cred.credential_id).run();

  // Look up the user to get username and admin status
  const userRow = await c.env.DB.prepare(
    "SELECT id, username, is_admin FROM users WHERE id = ?"
  ).bind(cred.user_id).first<{ id: number; username: string; is_admin: number }>();
  if (!userRow) return c.json({ error: "user not found" }, 401);

  // Issue JWT with full user payload
  const token = await sign(
    { sub: userRow.username, uid: userRow.id, admin: userRow.is_admin === 1, exp: Math.floor(Date.now() / 1000) + MAX_AGE },
    c.env.JWT_SECRET
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return c.json({ ok: true });
});

// JWT gate specifically for passkey register routes (registered before the general /api/* gate)
app.use("/api/passkey/register/*", (c, next) =>
  jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next)
);

// POST /api/passkey/register/options — JWT-protected (registered user only)
app.post("/api/passkey/register/options", async (c) => {
  await cleanupChallenges(c.env.DB);
  const { uid, username } = getUser(c);
  const { results: existing } = await c.env.DB.prepare(
    "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?"
  ).bind(uid).all<{ credential_id: string; transports: string | null }>();

  const options = await generateRegistrationOptions({
    rpName: "nemo",
    rpID: c.req.header("host")?.split(":")[0] ?? "localhost",
    userName: username,
    userDisplayName: username,
    excludeCredentials: existing.map((cr) => ({
      id: cr.credential_id,
      transports: cr.transports
        ? (JSON.parse(cr.transports) as AuthenticatorTransportFuture[])
        : undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO webauthn_challenges (challenge, created_at) VALUES (?, ?)"
  ).bind(options.challenge, Date.now()).run();

  return c.json(options);
});

// POST /api/passkey/register/verify — JWT-protected
app.post("/api/passkey/register/verify", async (c) => {
  const body = await c.req.json<{ response: unknown; challenge: string }>();
  const { challenge } = body;
  const { uid } = getUser(c);

  const row = await c.env.DB.prepare(
    "SELECT id, created_at FROM webauthn_challenges WHERE challenge = ?"
  ).bind(challenge).first<{ id: number; created_at: number }>();
  if (!row || Date.now() - row.created_at > CHALLENGE_TTL) {
    return c.json({ error: "invalid or expired challenge" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();

  const rpID = c.req.header("host")?.split(":")[0] ?? "localhost";
  const expectedOrigin = c.req.header("origin") ?? `https://${rpID}`;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
    });
  } catch (err) {
    return c.json({ error: "verification failed" }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification failed" }, 400);
  }

  const { credential, aaguid } = verification.registrationInfo;
  const publicKeyB64 = btoa(String.fromCharCode(...credential.publicKey))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO webauthn_credentials (credential_id, public_key, counter, transports, aaguid, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    credential.id,
    publicKeyB64,
    credential.counter,
    credential.transports ? JSON.stringify(credential.transports) : null,
    aaguid || null,
    uid,
    Date.now()
  ).run();

  return c.json({ ok: true });
});

// --- passkey credential management (Settings page, JWT-gated, user-scoped) -
// these routes are registered before the general /api/* gate, so they need their
// own JWT middleware (mirrors the passkey/register gate above)
app.use("/api/passkey/credentials/*", (c, next) =>
  jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next)
);
app.use("/api/passkey/credentials", (c, next) =>
  jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next)
);

// list the authenticated user's registered passkeys with their AAGUID so the UI
// can show a friendly authenticator name (iCloud Keychain, Windows Hello, ...)
app.get("/api/passkey/credentials", async (c) => {
  const { uid } = getUser(c);
  const { results } = await c.env.DB.prepare(
    "SELECT credential_id, aaguid, created_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(uid).all();
  return c.json(results);
});

// remove one of the authenticated user's registered passkeys
app.delete("/api/passkey/credentials/:id", async (c) => {
  const { uid } = getUser(c);
  await c.env.DB.prepare(
    "DELETE FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?"
  ).bind(c.req.param("id"), uid).run();
  return c.json({ ok: true });
});

// --- external integration surface (/api/ext/*) --------------------------
// Token-authenticated API for clients that can't drive the browser JWT login —
// e.g. a Siri Shortcut ("Hey Siri, make a new note"). Registered before the JWT
// gate so the cookie checks below never apply to it; auth is instead a static
// Bearer token matched (by hash) against the api_tokens table.
// Every /api/ext/* response uses a single shape — { "response": "<string>" } —
// so simple clients (Siri Shortcuts) can read one field: "done" on success, or a
// short error message otherwise.
app.use("/api/ext/*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return c.json({ response: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL"
  )
    .bind(await hashToken(token))
    .first<{ id: number; user_id: number }>();
  if (!row) return c.json({ response: "unauthorized" }, 401);
  // best-effort "last used" stamp for the settings list — never blocks the call
  await c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  c.set("extUserId", row.user_id);
  return next();
});

// create a memo from content in a single call (the web app's POST /api/memos
// makes an empty one, then PUTs — that two-step needs the editor). RESTful:
// POST to the memos collection = create.
app.post("/api/ext/memos", async (c) => {
  const { content } = await c.req
    .json<{ content?: unknown }>()
    .catch(() => ({ content: undefined }));
  if (typeof content !== "string" || !content.trim()) {
    return c.json({ response: "content required" }, 400);
  }
  const finalContent = content.startsWith("# ") ? content : `# ${content}`;
  const now = Date.now();
  const extUserId = c.get("extUserId");
  await c.env.DB.prepare(
    "INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(titleFrom(finalContent), finalContent, extUserId, now, now)
    .run();
  return c.json({ response: "done" }, 201);
});

// any other (authenticated) method/path under the integration surface — keeps
// the unified { response } shape instead of Hono's default text 404.
app.all("/api/ext/*", (c) => c.json({ response: "not found" }, 404));

// gate everything under /api except the public auth + /api/ext routes. The public
// routes (/api/login, /api/logout, /api/ext/*, /api/passkey/auth/*) are all
// registered before this middleware, so their handlers respond first and this
// gate only ever runs for the remaining authenticated routes.
app.use("/api/*", (c, next) => {
  return jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next);
});

app.get("/api/me", (c) => {
  const { uid, username, admin } = getUser(c);
  return c.json({ ok: true, uid, username, admin });
});

// --- admin: user management (issue #66, multi-tenancy) -------------------
// Gated to admins: the JWT must carry admin=true (set by the multi-tenant
// login). The middleware is async to keep the return type a plain
// Promise<Response> and avoid Hono's overload-resolution complaints.
app.use("/api/admin/*", async (c, next) => {
  const { admin } = getUser(c);
  if (!admin) return c.json({ error: "forbidden" }, 403);
  return next();
});

// list all users
app.get("/api/admin/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, username, is_admin, created_at, last_login_at FROM users ORDER BY created_at ASC"
  ).all();
  return c.json(results);
});

// create a (non-admin) user
app.post("/api/admin/users", async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) return c.json({ error: "username and password required" }, 400);
  const hash = await hashPassword(password);
  const now = Date.now();
  try {
    const row = await c.env.DB.prepare(
      "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 0, ?) RETURNING id, username, is_admin, created_at"
    ).bind(username, hash, now).first();
    return c.json(row, 201);
  } catch {
    return c.json({ error: "username already exists" }, 409);
  }
});

// hard-delete a non-admin user (admins and self are protected)
app.delete("/api/admin/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { uid } = getUser(c);
  if (id === uid) return c.json({ error: "cannot delete yourself" }, 400);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ? AND is_admin = 0").bind(id).run();
  return c.json({ ok: true });
});

// reset a user's password
app.patch("/api/admin/users/:id/password", async (c) => {
  const id = Number(c.req.param("id"));
  const { password } = await c.req.json();
  if (!password) return c.json({ error: "password required" }, 400);
  const hash = await hashPassword(password);
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, id).run();
  return c.json({ ok: true });
});

// --- api token management (web app Settings page, JWT-gated) -------------
// list active tokens (never the hash or plaintext — those are unrecoverable)
app.get("/api/tokens", async (c) => {
  const { uid } = getUser(c);
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL AND user_id = ? ORDER BY created_at DESC"
  ).bind(uid).all();
  return c.json(results);
});

// mint a token — the plaintext is returned exactly once, here, and only the hash
// is stored. The caller (Settings page) must surface it to the user immediately.
app.post("/api/tokens", async (c) => {
  const { uid } = getUser(c);
  const { label } = await c.req.json<{ label?: string }>().catch(() => ({ label: "" }));
  const token = newToken();
  const now = Date.now();
  const row = await c.env.DB.prepare(
    "INSERT INTO api_tokens (label, token_hash, user_id, created_at) VALUES (?, ?, ?, ?) RETURNING id, label, created_at, last_used_at"
  )
    .bind((label ?? "").toString().slice(0, 80), await hashToken(token), uid, now)
    .first();
  return c.json({ ...row, token }, 201);
});

// revoke (soft): the row stays for history, but the token stops authenticating
app.delete("/api/tokens/:id", async (c) => {
  const { uid } = getUser(c);
  await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), c.req.param("id"), uid)
    .run();
  return c.json({ ok: true });
});

// --- memos --------------------------------------------------------------
function titleFrom(content: string): string {
  const line = content.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || "Untitled";
}

app.get("/api/memos", async (c) => {
  const { uid } = getUser(c);
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL AND user_id = ? ORDER BY updated_at DESC"
  ).bind(uid).all();
  return c.json(results);
});

// full-text-ish search across title AND content (the sidebar list only carries
// titles, so body matching has to happen server-side). Returns the same light
// MemoMeta shape as the list. Empty query → empty result (no match-all).
app.get("/api/search", async (c) => {
  const { uid } = getUser(c);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  // escape LIKE wildcards so "%" / "_" in the query match literally, not as patterns
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL AND user_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC"
  )
    .bind(uid, like, like)
    .all();
  return c.json(results);
});

app.post("/api/memos", async (c) => {
  const { uid } = getUser(c);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    "INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('Untitled', '', ?, ?, ?) RETURNING *"
  )
    .bind(uid, now, now)
    .first();
  return c.json(row);
});

app.get("/api/trash", async (c) => {
  const { uid } = getUser(c);
  // hidden memos stay in the DB but are excluded from the trash listing
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NOT NULL AND hidden_at IS NULL AND user_id = ? ORDER BY deleted_at DESC"
  ).bind(uid).all();
  return c.json(results);
});

// read a single trashed memo's full content — lets the trash view show each
// document. Separate from GET /api/memos/:id (which 404s on trashed rows, a
// contract the multi-session "deleted elsewhere" detection relies on).
app.get("/api/trash/:id", async (c) => {
  const { uid } = getUser(c);
  const row = await c.env.DB.prepare(
    "SELECT * FROM memos WHERE id = ? AND deleted_at IS NOT NULL AND hidden_at IS NULL AND user_id = ?"
  )
    .bind(c.req.param("id"), uid)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.post("/api/memos/:id/restore", async (c) => {
  const { uid } = getUser(c);
  await c.env.DB.prepare("UPDATE memos SET deleted_at = NULL, hidden_at = NULL WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), uid)
    .run();
  return c.json({ ok: true });
});

// hide a trashed memo from the trash view without deleting it — the row stays
// in the DB, just flagged so it no longer shows up anywhere in the UI
app.post("/api/memos/:id/hide", async (c) => {
  const { uid } = getUser(c);
  await c.env.DB.prepare("UPDATE memos SET hidden_at = ? WHERE id = ? AND user_id = ?")
    .bind(Date.now(), c.req.param("id"), uid)
    .run();
  return c.json({ ok: true });
});

app.get("/api/memos/:id", async (c) => {
  const { uid } = getUser(c);
  const row = await c.env.DB.prepare(
    "SELECT * FROM memos WHERE id = ? AND deleted_at IS NULL AND user_id = ?"
  )
    .bind(c.req.param("id"), uid)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.put("/api/memos/:id", async (c) => {
  const { uid } = getUser(c);
  const { content, base } = await c.req.json<{ content: string; base?: number | null }>();
  const id = c.req.param("id");

  // current server state — drives both the conflict check and history snapshots
  const prev = await c.env.DB.prepare(
    "SELECT updated_at, created_at, content, title FROM memos WHERE id = ? AND deleted_at IS NULL AND user_id = ?"
  )
    .bind(id, uid)
    .first<{ updated_at: number; created_at: number; content: string; title: string }>();

  // optimistic concurrency: if the row was updated elsewhere since `base`,
  // reject instead of silently clobbering. (base omitted = force overwrite)
  if (base != null) {
    if (!prev) return c.json({ error: "not found" }, 404);
    if (prev.updated_at > base) {
      return c.json({ conflict: true, updated_at: prev.updated_at }, 409);
    }
  }

  const now = Date.now();

  // session-snapshot history: when a new editing session begins, preserve the
  // prior session's final state into memo_versions. A "new session" is either a
  // >=1h idle gap since the last save (sessionGap), or continuous editing that
  // has run >=1h since the last snapshot (maxSession) — so a memo accrues at most
  // ~one snapshot per hour. Skipped when the content is empty or unchanged.
  if (prev && prev.content && prev.content !== content) {
    const last = await c.env.DB.prepare(
      "SELECT MAX(created_at) AS at FROM memo_versions WHERE memo_id = ?"
    )
      .bind(id)
      .first<{ at: number | null }>();
    const since = last?.at ?? prev.created_at; // baseline before any snapshot exists
    const idleGap = now - prev.updated_at >= sessionGap(c.env);
    const longRun = prev.updated_at - since >= maxSession(c.env);
    if (idleGap || longRun) {
      await c.env.DB.prepare(
        "INSERT INTO memo_versions (memo_id, title, content, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(id, prev.title, prev.content, prev.updated_at)
        .run();
    }
  }

  const title = titleFrom(content);
  await c.env.DB.prepare(
    "UPDATE memos SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?"
  )
    .bind(title, content, now, id, uid)
    .run();
  return c.json({ ok: true, title, updated_at: now });
});

// history: list a memo's preserved past states, newest first (no content — the
// list stays light; fetch a single version's content via :versionId)
app.get("/api/memos/:id/versions", async (c) => {
  const { uid } = getUser(c);
  // Only list versions for memos owned by this user
  const memo = await c.env.DB.prepare(
    "SELECT id FROM memos WHERE id = ? AND user_id = ?"
  ).bind(c.req.param("id"), uid).first();
  if (!memo) return c.json([]);
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, created_at FROM memo_versions WHERE memo_id = ? ORDER BY created_at DESC"
  )
    .bind(c.req.param("id"))
    .all();
  return c.json(results);
});

app.get("/api/memos/:id/versions/:versionId", async (c) => {
  const { uid } = getUser(c);
  // Check memo ownership
  const memo = await c.env.DB.prepare(
    "SELECT id FROM memos WHERE id = ? AND user_id = ?"
  ).bind(c.req.param("id"), uid).first();
  if (!memo) return c.json({ error: "not found" }, 404);
  const row = await c.env.DB.prepare(
    "SELECT id, memo_id, title, content, created_at FROM memo_versions WHERE id = ? AND memo_id = ?"
  )
    .bind(c.req.param("versionId"), c.req.param("id"))
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.delete("/api/memos/:id", async (c) => {
  const { uid } = getUser(c);
  const id = c.req.param("id");
  if (c.req.query("purge") === "1") {
    // hard delete — used to clean up never-used empty memos; drop its history too
    await c.env.DB.prepare("DELETE FROM memos WHERE id = ? AND user_id = ?").bind(id, uid).run();
    await c.env.DB.prepare("DELETE FROM memo_versions WHERE memo_id = ?").bind(id).run();
  } else {
    // soft delete: mark deleted, keep the row
    await c.env.DB.prepare("UPDATE memos SET deleted_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), id, uid)
      .run();
  }
  return c.json({ ok: true });
});

export default app;
