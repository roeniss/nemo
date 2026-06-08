import { Hono } from "hono";
import { sign, jwt } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  AUTH_USER: string;
  AUTH_PASS: string;
  JWT_SECRET: string;
  TURNSTILE_SECRET?: string; // bot protection — enforced only when set
};

const COOKIE = "token";
const MAX_AGE = 60 * 60 * 24 * 30; // 30d

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

  if (username !== c.env.AUTH_USER || password !== c.env.AUTH_PASS) {
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

// gate everything under /api except the public auth routes
app.use("/api/*", (c, next) => {
  const p = c.req.path;
  if (p === "/api/login" || p === "/api/logout") return next();
  return jwt({ secret: c.env.JWT_SECRET, cookie: COOKIE, alg: "HS256" })(c, next);
});

app.get("/api/me", (c) => c.json({ ok: true }));

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
  // optimistic concurrency: if the row was updated elsewhere since `base`,
  // reject instead of silently clobbering. (base omitted = force overwrite)
  if (base != null) {
    const cur = await c.env.DB.prepare(
      "SELECT updated_at FROM memos WHERE id = ? AND deleted_at IS NULL"
    )
      .bind(id)
      .first<{ updated_at: number }>();
    if (!cur) return c.json({ error: "not found" }, 404);
    if (cur.updated_at > base) {
      return c.json({ conflict: true, updated_at: cur.updated_at }, 409);
    }
  }
  const title = titleFrom(content);
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE memos SET title = ?, content = ?, updated_at = ? WHERE id = ?"
  )
    .bind(title, content, now, id)
    .run();
  return c.json({ ok: true, title, updated_at: now });
});

app.delete("/api/memos/:id", async (c) => {
  const id = c.req.param("id");
  if (c.req.query("purge") === "1") {
    // hard delete — used to clean up never-used empty memos
    await c.env.DB.prepare("DELETE FROM memos WHERE id = ?").bind(id).run();
  } else {
    // soft delete: mark deleted, keep the row
    await c.env.DB.prepare("UPDATE memos SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
  }
  return c.json({ ok: true });
});

export default app;
