import { beforeEach, describe, expect, it, vi } from "vitest";
import app, { hashPassword } from "../worker/index";
import { D1 } from "./d1";

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
CREATE TABLE webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
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

beforeEach(() => {
  db = new D1();
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

describe("GET /api/passkey/credentials (JWT-protected)", () => {
  it("returns empty list when no credentials registered", async () => {
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials", { method: "GET", headers: h });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it("returns list of registered credentials", async () => {
    const now = Date.now();
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('cred-abc', 'pubkey', 0, '["internal"]', ${now})`
    );
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials", { method: "GET", headers: h });
    expect(r.status).toBe(200);
    const body = await r.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].credential_id).toBe("cred-abc");
    expect(body[0].transports).toEqual(["internal"]);
    expect(body[0].created_at).toBe(now);
  });

  it("returns transports as empty array when null", async () => {
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('cred-notransport', 'pubkey', 0, NULL, ${Date.now()})`
    );
    const h = await authedHeaders();
    const r = await req("/api/passkey/credentials", { method: "GET", headers: h });
    expect(r.status).toBe(200);
    const body = await r.json() as any[];
    expect(body[0].transports).toEqual([]);
  });

  it("returns 401 without JWT", async () => {
    const r = await req("/api/passkey/credentials", { method: "GET" });
    expect(r.status).toBe(401);
  });
});

describe("DELETE /api/passkey/credentials/:id (JWT-protected)", () => {
  it("deletes a credential by id", async () => {
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('cred-to-delete', 'pubkey', 0, NULL, ${Date.now()})`
    );
    const idRow = await db.prepare("SELECT id FROM webauthn_credentials WHERE credential_id = ?")
      .bind("cred-to-delete")
      .first<{ id: number }>();
    const h = await authedHeaders();
    const r = await req(`/api/passkey/credentials/${idRow!.id}`, { method: "DELETE", headers: h });
    expect(r.status).toBe(200);
    expect((await r.json() as any).ok).toBe(true);

    const gone = await db.prepare("SELECT id FROM webauthn_credentials WHERE credential_id = ?")
      .bind("cred-to-delete")
      .first();
    expect(gone).toBeNull();
  });

  it("returns 401 without JWT", async () => {
    const r = await req("/api/passkey/credentials/1", { method: "DELETE" });
    expect(r.status).toBe(401);
  });
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
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('cred-abc', 'pubkey', 0, '["internal"]', ${Date.now()})`
    );
    const r = await req("/api/passkey/auth/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    // generateAuthenticationOptions was called — this just verifies the endpoint runs OK
  });
});

describe("POST /api/passkey/auth/verify", () => {
  async function insertChallenge(challenge: string, createdAt = Date.now()) {
    db.exec(
      `INSERT INTO webauthn_challenges (challenge, created_at) VALUES ('${challenge}', ${createdAt})`
    );
  }

  async function insertCredential(credId = "cred-abc") {
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('${credId}', 'AQID', 0, '["internal"]', ${Date.now()})`
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

    // Verify credential was stored
    const cred = await db
      .prepare("SELECT credential_id FROM webauthn_credentials WHERE credential_id = ?")
      .bind("mock-cred-id")
      .first<{ credential_id: string }>();
    expect(cred?.credential_id).toBe("mock-cred-id");
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

// ===========================================================================
// BRANCH COVERAGE — PR #65 gaps
// ===========================================================================

describe("verifyPassword catch branch", () => {
  it("returns false when pbkdf2 throws (malformed hash triggers crypto error)", async () => {
    // A stored hash with a valid prefix but an iteration count so extreme
    // that the Workers crypto runtime rejects it — exercises the catch { return false } arm.
    // We achieve this by passing a value that is not a valid PBKDF2 stored hash
    // so verifyPassword returns false via the catch guard.
    const r = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "wrongpass" }),
    });
    // The env AUTH_PASS is a real PBKDF2 hash; a wrong password means timingSafeEqual
    // returns false (no throw). To hit the catch we need a malformed stored hash.
    // Swap env.AUTH_PASS to a malformed value.
    const saved = env.AUTH_PASS;
    env.AUTH_PASS = "pbkdf2:99999999999:invalidbase64!!!:invalidsalt===";
    const r2 = await req("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tester", password: "pw" }),
    });
    env.AUTH_PASS = saved;
    // malformed hash → catch → false → 401
    expect(r2.status).toBe(401);
    expect(r.status).toBe(401);
  });
});

describe("POST /api/passkey/auth/verify catch branch", () => {
  it("returns 401 when verifyAuthenticationResponse throws", async () => {
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error("crypto error"));

    db.exec(
      `INSERT INTO webauthn_challenges (challenge, created_at) VALUES ('throw-challenge', ${Date.now()})`
    );
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('cred-throw', 'AQID', 0, '["internal"]', ${Date.now()})`
    );
    const r = await req("/api/passkey/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { id: "cred-throw" }, challenge: "throw-challenge" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/verification failed/);
  });
});

describe("POST /api/passkey/register/options — null transports branch", () => {
  it("maps credentials with null transports to undefined (falsy branch)", async () => {
    // Insert a credential with NULL transports so the `cr.transports ? ... : undefined`
    // false branch is exercised when building excludeCredentials.
    db.exec(
      `INSERT INTO webauthn_credentials (credential_id, public_key, counter, transports, created_at)
       VALUES ('null-transport-cred', 'AQID', 0, NULL, ${Date.now()})`
    );
    const h = await authedHeaders();
    const r = await req("/api/passkey/register/options", { method: "POST", headers: h });
    // The endpoint must still succeed — the null-transports credential is mapped
    // to { id, transports: undefined } which is valid for excludeCredentials.
    expect(r.status).toBe(200);
  });
});
