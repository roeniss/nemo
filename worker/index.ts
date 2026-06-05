import { Hono } from "hono";
import { sign, jwt } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";

type Bindings = {
  DB: D1Database;
  AUTH_USER: string;
  AUTH_PASS: string;
  JWT_SECRET: string;
};

const COOKIE = "token";
const MAX_AGE = 60 * 60 * 24 * 30; // 30d

const app = new Hono<{ Bindings: Bindings }>();

// --- auth ---------------------------------------------------------------
app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json<{ username: string; password: string }>();
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
  const { content } = await c.req.json<{ content: string }>();
  const title = titleFrom(content);
  const now = Date.now();
  await c.env.DB.prepare(
    "UPDATE memos SET title = ?, content = ?, updated_at = ? WHERE id = ?"
  )
    .bind(title, content, now, c.req.param("id"))
    .run();
  return c.json({ ok: true, title, updated_at: now });
});

app.delete("/api/memos/:id", async (c) => {
  // soft delete: mark deleted, keep the row
  await c.env.DB.prepare("UPDATE memos SET deleted_at = ? WHERE id = ?")
    .bind(Date.now(), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

export default app;
