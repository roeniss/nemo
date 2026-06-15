import { Hono } from "hono";
import { sign, jwt } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  AUTH_USER: string;
  AUTH_PASS: string;
  JWT_SECRET: string;
  TURNSTILE_SECRET?: string; // bot protection — enforced only when set
  // history snapshot thresholds (ms); default to 1h. Overridden small in dev/e2e.
  HISTORY_GAP_MS?: string;
  HISTORY_SESSION_MS?: string;
};

const COOKIE = "token";
const MAX_AGE = 60 * 60 * 24 * 30; // 30d
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
// The login password is never stored plaintext: AUTH_PASS holds a salted
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

// Verify a login attempt against the configured AUTH_PASS, which must be a
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

const app = new Hono<{ Bindings: Bindings }>();

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

  if (username !== c.env.AUTH_USER || !(await verifyPassword(password, c.env.AUTH_PASS))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = await sign(
    { sub: username, exp: Math.floor(Date.now() / 1000) + MAX_AGE },
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
    "SELECT id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL"
  )
    .bind(await hashToken(token))
    .first<{ id: number }>();
  if (!row) return c.json({ response: "unauthorized" }, 401);
  // best-effort "last used" stamp for the settings list — never blocks the call
  await c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
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
  await c.env.DB.prepare(
    "INSERT INTO memos (title, content, created_at, updated_at) VALUES (?, ?, ?, ?)"
  )
    .bind(titleFrom(finalContent), finalContent, now, now)
    .run();
  return c.json({ response: "done" }, 201);
});

// any other (authenticated) method/path under the integration surface — keeps
// the unified { response } shape instead of Hono's default text 404.
app.all("/api/ext/*", (c) => c.json({ response: "not found" }, 404));

// gate everything under /api except the public auth + /api/ext routes
app.use("/api/*", (c, next) => {
  const p = c.req.path;
  // /api/login, /api/logout and the /api/ext/* surface are registered before this
  // middleware, so their handlers respond first and the gate never actually runs
  // for them — this guard is a defensive net for any future reordering, hence
  // unreachable under the current routes and excluded from coverage.
  /* v8 ignore next */
  if (p === "/api/login" || p === "/api/logout" || p.startsWith("/api/ext/")) return next();
  return jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next);
});

app.get("/api/me", (c) => c.json({ ok: true }));

// --- api token management (web app Settings page, JWT-gated) -------------
// list active tokens (never the hash or plaintext — those are unrecoverable)
app.get("/api/tokens", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC"
  ).all();
  return c.json(results);
});

// mint a token — the plaintext is returned exactly once, here, and only the hash
// is stored. The caller (Settings page) must surface it to the user immediately.
app.post("/api/tokens", async (c) => {
  const { label } = await c.req.json<{ label?: string }>().catch(() => ({ label: "" }));
  const token = newToken();
  const now = Date.now();
  const row = await c.env.DB.prepare(
    "INSERT INTO api_tokens (label, token_hash, created_at) VALUES (?, ?, ?) RETURNING id, label, created_at, last_used_at"
  )
    .bind((label ?? "").toString().slice(0, 80), await hashToken(token), now)
    .first();
  return c.json({ ...row, token }, 201);
});

// revoke (soft): the row stays for history, but the token stops authenticating
app.delete("/api/tokens/:id", async (c) => {
  await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?")
    .bind(Date.now(), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// --- memos --------------------------------------------------------------
function titleFrom(content: string): string {
  const line = content.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 120) || "Untitled";
}

app.get("/api/memos", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL ORDER BY updated_at DESC"
  ).all();
  return c.json(results);
});

// full-text-ish search across title AND content (the sidebar list only carries
// titles, so body matching has to happen server-side). Returns the same light
// MemoMeta shape as the list. Empty query → empty result (no match-all).
app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  // escape LIKE wildcards so "%" / "_" in the query match literally, not as patterns
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC"
  )
    .bind(like, like)
    .all();
  return c.json(results);
});

app.post("/api/memos", async (c) => {
  const now = Date.now();
  const row = await c.env.DB.prepare(
    "INSERT INTO memos (title, content, created_at, updated_at) VALUES ('Untitled', '', ?, ?) RETURNING *"
  )
    .bind(now, now)
    .first();
  return c.json(row);
});

app.get("/api/trash", async (c) => {
  // hidden memos stay in the DB but are excluded from the trash listing
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NOT NULL AND hidden_at IS NULL ORDER BY deleted_at DESC"
  ).all();
  return c.json(results);
});

// read a single trashed memo's full content — lets the trash view show each
// document. Separate from GET /api/memos/:id (which 404s on trashed rows, a
// contract the multi-session "deleted elsewhere" detection relies on).
app.get("/api/trash/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM memos WHERE id = ? AND deleted_at IS NOT NULL AND hidden_at IS NULL"
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.post("/api/memos/:id/restore", async (c) => {
  await c.env.DB.prepare("UPDATE memos SET deleted_at = NULL, hidden_at = NULL WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// hide a trashed memo from the trash view without deleting it — the row stays
// in the DB, just flagged so it no longer shows up anywhere in the UI
app.post("/api/memos/:id/hide", async (c) => {
  await c.env.DB.prepare("UPDATE memos SET hidden_at = ? WHERE id = ?")
    .bind(Date.now(), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

app.get("/api/memos/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM memos WHERE id = ? AND deleted_at IS NULL"
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.put("/api/memos/:id", async (c) => {
  const { content, base } = await c.req.json<{ content: string; base?: number | null }>();
  const id = c.req.param("id");

  // current server state — drives both the conflict check and history snapshots
  const prev = await c.env.DB.prepare(
    "SELECT updated_at, created_at, content, title FROM memos WHERE id = ? AND deleted_at IS NULL"
  )
    .bind(id)
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
    "UPDATE memos SET title = ?, content = ?, updated_at = ? WHERE id = ?"
  )
    .bind(title, content, now, id)
    .run();
  return c.json({ ok: true, title, updated_at: now });
});

// history: list a memo's preserved past states, newest first (no content — the
// list stays light; fetch a single version's content via :versionId)
app.get("/api/memos/:id/versions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, created_at FROM memo_versions WHERE memo_id = ? ORDER BY created_at DESC"
  )
    .bind(c.req.param("id"))
    .all();
  return c.json(results);
});

app.get("/api/memos/:id/versions/:versionId", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, memo_id, title, content, created_at FROM memo_versions WHERE id = ? AND memo_id = ?"
  )
    .bind(c.req.param("versionId"), c.req.param("id"))
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.delete("/api/memos/:id", async (c) => {
  const id = c.req.param("id");
  if (c.req.query("purge") === "1") {
    // hard delete — used to clean up never-used empty memos; drop its history too
    await c.env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id).run();
    await c.env.DB.prepare("DELETE FROM memo_versions WHERE memo_id = ?").bind(id).run();
  } else {
    // soft delete: mark deleted, keep the row
    await c.env.DB.prepare("UPDATE memos SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
  }
  return c.json({ ok: true });
});

export default app;
