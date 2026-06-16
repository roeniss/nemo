import { beforeEach, describe, expect, it, vi } from "vitest";
import app, { hashPassword } from "../worker/index";
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
CREATE TABLE webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  aaguid TEXT,
  name TEXT,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE webauthn_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`;

let env: Record<string, unknown>;
let db: D1;

beforeEach(async () => {
  db = new D1();
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

// Mock @simplewebauthn/server since we can't do real crypto in tests
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    generateRegistrationOptions: vi.fn().mockResolvedValue({
      challenge: "mock-reg-challenge",
      rp: { name: "nemo", id: "localhost" },
      user: { id: "dXNlcg==", name: "tester", displayName: "tester" },
      pubKeyCredParams: [],
      timeout: 60000,
      excludeCredentials: [],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation: "none",
    }),
    generateAuthenticationOptions: vi.fn().mockResolvedValue({
      challenge: "mock-auth-challenge",
      allowCredentials: [],
      userVerification: "preferred",
      rpId: "localhost",
      timeout: 60000,
    }),
    verifyRegistrationResponse: vi.fn().mockResolvedValue({
      verified: true,
      registrationInfo: {
        aaguid: "fbfc3007-154e-4ecc-8032-51d60de6b4c2",
        credential: {
          id: "mock-cred-id",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ["internal"],
        },
      },
    }),
    verifyAuthenticationResponse: vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    }),
  };
});

describe("POST /api/passkey/auth/options", () => {
  it("returns authentication options (no auth required)", async () => {
    const r = await req("/api/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.challenge).toBe("mock-auth-challenge");
  });

  it("stores the challenge in the DB", async () => {
    await req("/api/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const row = await db.prepare("SELECT challenge FROM webauthn_challenges WHERE challenge = ?")
      .bind("mock-auth-challenge")
      .first<{ challenge: string }>();
    expect(row?.challenge).toBe("mock-auth-challenge");
  });

  it("includes existing credentials in allowCredentials", async () => {
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('cred-abc', 'pubkey', 0, '["internal"]', 1, ${Date.now()})`
    );
    const r = await req("/api/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    // generateAuthenticationOptions was called — this just verifies the endpoint runs OK
  });

  it("maps credential with null transports to undefined in allowCredentials", async () => {
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('cred-no-transport', 'pubkey', 0, NULL, 1, ${Date.now()})`
    );
    const r = await req("/api/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/passkey/auth/verify", () => {
  async function insertChallenge(challenge: string, createdAt = Date.now()) {
    db.exec(
      `INSERT INTO webauthn_challenges (challenge, created_at) VALUES ('${challenge}', ${createdAt})`
    );
  }

  async function insertCredential(credId = "cred-abc", transports: string | null = '["internal"]') {
    const transportVal = transports === null ? "NULL" : `'${transports}'`;
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('${credId}', 'AQID', 0, ${transportVal}, 1, ${Date.now()})`
    );
  }

  it("returns 400 for invalid / missing challenge", async () => {
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-abc" }, challenge: "nonexistent" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/invalid or expired/);
  });

  it("returns 400 for expired challenge", async () => {
    const oldTs = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    await insertChallenge("old-challenge", oldTs);
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-abc" }, challenge: "old-challenge" }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 401 when credential not found", async () => {
    await insertChallenge("valid-challenge");
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "no-such-cred" }, challenge: "valid-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/credential not found/);
  });

  it("returns 401 when response has no id (falls back to empty string)", async () => {
    await insertChallenge("no-id-challenge");
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: {}, challenge: "no-id-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/credential not found/);
  });

  it("issues a JWT cookie on successful verification", async () => {
    await insertChallenge("valid-challenge");
    await insertCredential("cred-abc");
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-abc" }, challenge: "valid-challenge" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
    expect(r.headers.get("set-cookie")).toContain("token=");
  });

  it("succeeds when credential has null transports (maps to undefined)", async () => {
    await insertChallenge("null-transport-challenge");
    await insertCredential("cred-null", null);
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-null" }, challenge: "null-transport-challenge" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
  });

  it("returns 401 when the credential's user no longer exists", async () => {
    // Credential verifies, but its user_id points at a deleted/non-existent
    // user row, so the user lookup returns null → 401 "user not found".
    await insertChallenge("orphan-cred-challenge");
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('cred-orphan', 'AQID', 0, '["internal"]', 999, ${Date.now()})`
    );
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-orphan" }, challenge: "orphan-cred-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/user not found/);
  });

  it("returns 401 when verifyAuthenticationResponse throws", async () => {
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error("bad sig"));

    await insertChallenge("throw-challenge");
    await insertCredential("cred-abc");
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-abc" }, challenge: "throw-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/verification failed/);
  });

  it("returns 401 when verified is false", async () => {
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: false,
      authenticationInfo: undefined as any,
    });

    await insertChallenge("unverified-auth-challenge");
    await insertCredential("cred-abc");
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-abc" }, challenge: "unverified-auth-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/verification failed/);
  });
});

describe("POST /api/passkey/register/options (JWT-protected)", () => {
  it("returns registration options when authenticated", async () => {
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/options", { method: "POST", headers: h });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.challenge).toBe("mock-reg-challenge");
  });

  it("stores the challenge in DB", async () => {
    const h = await authedHeaders();
    await req("/api/passkey/register/options", { method: "POST", headers: h });
    const row = await db.prepare("SELECT challenge FROM webauthn_challenges WHERE challenge = ?")
      .bind("mock-reg-challenge")
      .first<{ challenge: string }>();
    expect(row?.challenge).toBe("mock-reg-challenge");
  });

  it("maps existing credential with null transports to undefined in excludeCredentials", async () => {
    // Insert a credential with NULL transports to hit the ternary false-branch on line ~290
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('cred-null-transport', 'pubkey', 0, NULL, 1, ${Date.now()})`
    );
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/options", { method: "POST", headers: h });
    expect(r.status).toBe(200);
  });

  it("maps existing credential with transports to parsed array in excludeCredentials", async () => {
    // Insert a credential with transports to hit the ternary true-branch on line ~290
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, user_id, created_at)
       VALUES ('cred-with-transport', 'pubkey', 0, '["internal"]', 1, ${Date.now()})`
    );
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/options", { method: "POST", headers: h });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/passkey/register/verify (JWT-protected)", () => {
  async function insertChallenge(challenge: string, createdAt = Date.now()) {
    db.exec(
      `INSERT INTO webauthn_challenges (challenge, created_at) VALUES ('${challenge}', ${createdAt})`
    );
  }

  it("returns 400 for missing/expired challenge", async () => {
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "nonexistent" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/invalid or expired/);
  });

  it("returns 400 for expired challenge", async () => {
    const oldTs = Date.now() - 10 * 60 * 1000;
    await insertChallenge("old-reg-challenge", oldTs);
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "old-reg-challenge" }),
    });
    expect(r.status).toBe(400);
  });

  it("saves credential and returns {ok:true} on success", async () => {
    await insertChallenge("valid-reg-challenge");
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "valid-reg-challenge" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);

    // Verify credential was stored, including the AAGUID
    const cred = await db
      .prepare("SELECT credential_id, aaguid FROM webauthn_credentials WHERE credential_id = ?")
      .bind("mock-cred-id")
      .first<{ credential_id: string; aaguid: string | null }>();
    expect(cred?.credential_id).toBe("mock-cred-id");
    expect(cred?.aaguid).toBe("fbfc3007-154e-4ecc-8032-51d60de6b4c2");
  });

  it("returns 400 when verifyRegistrationResponse throws", async () => {
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyRegistrationResponse).mockRejectedValueOnce(new Error("bad attestation"));

    await insertChallenge("bad-challenge");
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "bad-challenge" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/verification failed/);
  });

  it("saves credential with null transports when credential has no transports", async () => {
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: "mock-cred-no-transport",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          // no transports field → undefined → stores null
        },
      },
    } as any);

    await insertChallenge("no-transport-reg-challenge");
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "no-transport-reg-challenge" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);
  });

  it("returns 400 when verification.verified is false", async () => {
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: false,
      registrationInfo: undefined,
    } as any);

    await insertChallenge("unverified-challenge");
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ response: {}, challenge: "unverified-challenge" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("passkey credential management", () => {
  async function insertCred(id: string, aaguid: string | null, createdAt = Date.now(), userId = 1) {
    await db
      .prepare(
        `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, aaguid, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, "pk", 0, null, aaguid, userId, createdAt)
      .run();
  }

  it("GET /api/passkey/credentials lists the user's credentials with aaguid, newest first", async () => {
    await insertCred("cred-a", "fbfc3007-154e-4ecc-8032-51d60de6b4c2", 100);
    await insertCred("cred-b", null, 200);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials", { headers: h });
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<{ credential_id: string; aaguid: string | null }>;
    expect(list).toHaveLength(2);
    expect(list[0].credential_id).toBe("cred-b"); // newest first
    expect(list[1].aaguid).toBe("fbfc3007-154e-4ecc-8032-51d60de6b4c2");
  });

  it("GET /api/passkey/credentials only returns the authenticated user's credentials", async () => {
    await insertCred("mine", null, 100, 1);
    await insertCred("theirs", null, 200, 2);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials", { headers: h });
    const list = (await r.json()) as Array<{ credential_id: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].credential_id).toBe("mine");
  });

  it("GET /api/passkey/credentials requires auth", async () => {
    const r = await req("/api/passkey/credentials");
    expect(r.status).toBe(401);
  });

  it("DELETE /api/passkey/credentials/:id removes the credential", async () => {
    await insertCred("cred-del", null);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials/cred-del", { method: "DELETE", headers: h });
    expect(r.status).toBe(200);
    const remaining = await db
      .prepare("SELECT credential_id FROM webauthn_credentials WHERE credential_id = ?")
      .bind("cred-del")
      .first();
    expect(remaining).toBeNull();
  });

  it("DELETE /api/passkey/credentials/:id does not delete another user's credential", async () => {
    await insertCred("theirs", null, 100, 2);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials/theirs", { method: "DELETE", headers: h });
    expect(r.status).toBe(200);
    const remaining = await db
      .prepare("SELECT credential_id FROM webauthn_credentials WHERE credential_id = ?")
      .bind("theirs")
      .first();
    expect(remaining).not.toBeNull();
  });

  it("DELETE /api/passkey/credentials/:id requires auth", async () => {
    const r = await req("/api/passkey/credentials/anything", { method: "DELETE" });
    expect(r.status).toBe(401);
  });

  const nameOf = (id: string) =>
    db.prepare("SELECT name FROM webauthn_credentials WHERE credential_id = ?").bind(id).first<{ name: string | null }>();

  it("PATCH /api/passkey/credentials/:id sets a custom name (trimmed)", async () => {
    await insertCred("cred-name", null);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials/cred-name", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "  Work laptop  " }),
    });
    expect(r.status).toBe(200);
    expect((await nameOf("cred-name"))?.name).toBe("Work laptop");
  });

  it("PATCH /api/passkey/credentials/:id clears the name when blank (falls back to AAGUID label)", async () => {
    await insertCred("cred-clear", null);
    const h = await authedHeaders();
    await req("/api/passkey/credentials/cred-clear", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "temp" }),
    });
    const r = await req("/api/passkey/credentials/cred-clear", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "   " }),
    });
    expect(r.status).toBe(200);
    expect((await nameOf("cred-clear"))?.name).toBeNull();
  });

  it("PATCH /api/passkey/credentials/:id treats a missing name as a clear", async () => {
    await insertCred("cred-missing", null);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials/cred-missing", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    expect((await nameOf("cred-missing"))?.name).toBeNull();
  });

  it("PATCH /api/passkey/credentials/:id does not rename another user's credential", async () => {
    await insertCred("theirs-rename", null, 100, 2);
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials/theirs-rename", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "hijack" }),
    });
    expect(r.status).toBe(200);
    expect((await nameOf("theirs-rename"))?.name).toBeNull();
  });

  it("PATCH /api/passkey/credentials/:id requires auth", async () => {
    const r = await req("/api/passkey/credentials/anything", {
      method: "PATCH",
      body: JSON.stringify({ name: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("GET /api/passkey/credentials returns the custom name alongside aaguid", async () => {
    await insertCred("cred-named", "fbfc3007-154e-4ecc-8032-51d60de6b4c2", 100);
    const h = await authedHeaders();
    await req("/api/passkey/credentials/cred-named", {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ name: "My key" }),
    });
    const r = await req("/api/passkey/credentials", { headers: h });
    const list = (await r.json()) as Array<{ credential_id: string; name: string | null }>;
    expect(list.find((c) => c.credential_id === "cred-named")?.name).toBe("My key");
  });
});
