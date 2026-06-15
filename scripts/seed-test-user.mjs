// Seed a single test/dev user into the local D1 so e2e (and local dev) can log
// in. The new worker authenticates against the `users` table, not AUTH_* env
// vars, so the DB must contain the login user before the worker can mint a JWT.
//
// Reads TEST_USER / TEST_PASS from the environment (set by CI; falls back to
// local-dev defaults), computes the same salted PBKDF2 hash the worker expects,
// and INSERTs the user (admin) via `wrangler d1 execute --local`. Idempotent:
// INSERT OR IGNORE means re-running against a populated DB is a no-op.
import { execFileSync } from "node:child_process";

const PBKDF2_ITERS = 100_000; // keep in sync with worker/index.ts

const TEST_USER = process.env.TEST_USER ?? "roeniss";
const TEST_PASS = process.env.TEST_PASS ?? "local-dev-only";

const b64encode = (bytes) => Buffer.from(bytes).toString("base64");

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
      key,
      256
    )
  );
  return `pbkdf2:${PBKDF2_ITERS}:${b64encode(salt)}:${b64encode(bits)}`;
}

const hash = await hashPassword(TEST_PASS);

// Quote for SQL string literals (double single-quotes). Values are local-only
// test creds, but escape anyway so an apostrophe can't break the statement.
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql =
  `INSERT OR IGNORE INTO users (username, password_hash, is_admin, created_at) ` +
  `VALUES (${sqlStr(TEST_USER)}, ${sqlStr(hash)}, 1, CAST(strftime('%s','now') AS INTEGER) * 1000);`;

execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "nemo-db", "--local", "--command", sql],
  { stdio: "inherit" }
);
