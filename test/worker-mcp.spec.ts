import { beforeEach, describe, expect, it } from "vitest";
import app, { hashPassword } from "../worker/index";
import { MCP_PROTOCOL_VERSION, SERVER_INFO, TOOLS, runTool } from "../worker/mcp";
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
CREATE TABLE memo_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memo_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
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
    .prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, ?, ?, 1, ?)")
    .bind("tester", PW_HASH, Date.now())
    .run();
  // a second user, to assert cross-user isolation
  await db
    .prepare("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, ?, ?, 0, ?)")
    .bind("other", PW_HASH, Date.now())
    .run();
});

const req = (path: string, init?: RequestInit) => app.request(path, init, env as never);

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];

// mint an api_token via the real login + POST /api/tokens flow
async function mintToken(username = "tester"): Promise<string> {
  const login = await req("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "pw" }),
  });
  const r = await req("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieOf(login) },
    body: JSON.stringify({ label: "mcp" }),
  });
  return ((await r.json()) as { token: string }).token;
}

// POST a JSON-RPC message to the MCP endpoint with a Bearer token
async function rpc(token: string | null, message: unknown) {
  return req("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  });
}

const call = (token: string, name: string, args: Record<string, unknown> = {}, id = 1) =>
  rpc(token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

// pull the text payload out of a successful tools/call result
async function resultText(r: Response): Promise<{ text: string; isError: boolean }> {
  const body = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { text: body.result.content[0].text, isError: !!body.result.isError };
}

describe("MCP auth", () => {
  it("rejects a request with no token (401 + WWW-Authenticate)", async () => {
    const r = await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
  });

  it("rejects an unknown token", async () => {
    const r = await rpc("nemo_bogus", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const token = await mintToken();
    await db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE 1=1").bind(Date.now()).run();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
  });

  it("stamps last_used_at on a valid call", async () => {
    const token = await mintToken();
    await rpc(token, { jsonrpc: "2.0", id: 1, method: "ping" });
    const row = await db.prepare("SELECT last_used_at FROM api_tokens").first<{ last_used_at: number }>();
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
});

describe("MCP protocol", () => {
  it("initialize negotiates a known requested version", async () => {
    const token = await mintToken();
    const r = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const body = (await r.json()) as any;
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo).toEqual(SERVER_INFO);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("initialize falls back to the server version for an unknown requested version", async () => {
    const token = await mintToken();
    const r = await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(((await r.json()) as any).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("initialize with no params uses the server version", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(((await r.json()) as any).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("responds to ping with an empty result", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", id: 7, method: "ping" });
    expect((await r.json()) as any).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("tools/list advertises all tools with annotations", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = ((await r.json()) as any).result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(
      ["create_memo", "delete_memo", "get_memo", "list_memos", "search_memos", "update_memo"].sort()
    );
    const del = tools.find((t: any) => t.name === "delete_memo");
    expect(del.annotations.destructiveHint).toBe(true);
    const list = tools.find((t: any) => t.name === "list_memos");
    expect(list.annotations.readOnlyHint).toBe(true);
  });

  it("acknowledges a notification (no id) with 202 and no body", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("returns an array of responses for a batch, dropping notifications", async () => {
    const token = await mintToken();
    const r = await rpc(token, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ]);
    const body = (await r.json()) as any[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(1);
  });

  it("returns 202 for a batch of only notifications", async () => {
    const token = await mintToken();
    const r = await rpc(token, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(r.status).toBe(202);
  });

  it("rejects a malformed request (bad jsonrpc / missing method)", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "1.0", id: 1, method: "ping" });
    expect(((await r.json()) as any).error.code).toBe(-32600);
  });

  it("drops a malformed notification silently (202)", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", method: 123 });
    expect(r.status).toBe(202);
  });

  it("returns method-not-found for an unknown method", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "does/not/exist" });
    expect(((await r.json()) as any).error.code).toBe(-32601);
  });

  it("returns a parse error for an invalid JSON body", async () => {
    const token = await mintToken();
    const r = await req("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: "{ not json",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32700);
  });

  it("returns 405 for GET / DELETE on the MCP endpoint", async () => {
    const token = await mintToken();
    const get = await req("/api/mcp", { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
    const del = await req("/api/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    expect(del.status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("create_memo creates a memo and returns its id", async () => {
    const token = await mintToken();
    const r = await call(token, "create_memo", { content: "buy milk" });
    const { text, isError } = await resultText(r);
    expect(isError).toBe(false);
    const out = JSON.parse(text);
    expect(out.created).toBe(true);
    const row = await db.prepare("SELECT title, content, user_id FROM memos WHERE id = ?").bind(out.id).first<any>();
    expect(row.user_id).toBe(1);
    expect(row.title).toBe("buy milk");
    expect(row.content).toBe("# buy milk"); // prefixed
  });

  it("create_memo keeps an existing heading prefix", async () => {
    const token = await mintToken();
    const r = await call(token, "create_memo", { content: "# Title\nbody" });
    const out = JSON.parse((await resultText(r)).text);
    const row = await db.prepare("SELECT content FROM memos WHERE id = ?").bind(out.id).first<any>();
    expect(row.content).toBe("# Title\nbody");
  });

  it("create_memo rejects empty content as a tool error", async () => {
    const token = await mintToken();
    const { isError, text } = await resultText(await call(token, "create_memo", { content: "   " }));
    expect(isError).toBe(true);
    expect(text).toContain("content required");
  });

  it("list_memos returns only the caller's memos, newest first", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('a','a',1,1,1)").run();
    await db.prepare("INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('b','b',1,2,2)").run();
    await db.prepare("INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('x','x',2,3,3)").run();
    const list = JSON.parse((await resultText(await call(token, "list_memos"))).text);
    expect(list.map((m: any) => m.title)).toEqual(["b", "a"]);
  });

  it("search_memos matches title and body, and returns [] for an empty query", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('groceries','milk',1,1,1)").run();
    const hit = JSON.parse((await resultText(await call(token, "search_memos", { query: "milk" }))).text);
    expect(hit).toHaveLength(1);
    const empty = JSON.parse((await resultText(await call(token, "search_memos", { query: "  " }))).text);
    expect(empty).toEqual([]);
  });

  it("get_memo returns full content, and errors when missing", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (5,'t','full body',1,1,1)").run();
    const ok = await resultText(await call(token, "get_memo", { id: 5 }));
    expect(JSON.parse(ok.text).content).toBe("full body");
    const missing = await resultText(await call(token, "get_memo", { id: 999 }));
    expect(missing.isError).toBe(true);
  });

  it("get_memo accepts a numeric string id but rejects a non-integer", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (8,'t','b',1,1,1)").run();
    const ok = await resultText(await call(token, "get_memo", { id: "8" }));
    expect(JSON.parse(ok.text).id).toBe(8);
    const bad = await resultText(await call(token, "get_memo", { id: "abc" }));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("integer");
  });

  it("update_memo replaces content and snapshots the prior version", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (3,'old','old body',1,1,1)").run();
    const ok = await resultText(await call(token, "update_memo", { id: 3, content: "# new body" }));
    expect(ok.isError).toBe(false);
    const row = await db.prepare("SELECT content, title FROM memos WHERE id = 3").first<any>();
    expect(row.content).toBe("# new body");
    const ver = await db.prepare("SELECT content FROM memo_versions WHERE memo_id = 3").first<any>();
    expect(ver.content).toBe("old body"); // prior content preserved
  });

  it("update_memo does not snapshot when content is unchanged", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (4,'t','same',1,1,1)").run();
    await call(token, "update_memo", { id: 4, content: "same" });
    const ver = await db.prepare("SELECT COUNT(*) AS n FROM memo_versions WHERE memo_id = 4").first<any>();
    expect(ver.n).toBe(0);
  });

  it("update_memo errors when the memo does not exist", async () => {
    const token = await mintToken();
    const r = await resultText(await call(token, "update_memo", { id: 123, content: "x" }));
    expect(r.isError).toBe(true);
  });

  it("delete_memo soft-deletes the memo", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (6,'t','b',1,1,1)").run();
    const ok = await resultText(await call(token, "delete_memo", { id: 6 }));
    expect(ok.isError).toBe(false);
    const row = await db.prepare("SELECT deleted_at FROM memos WHERE id = 6").first<any>();
    expect(row.deleted_at).toBeGreaterThan(0);
  });

  it("delete_memo errors when the memo does not exist", async () => {
    const token = await mintToken();
    const r = await resultText(await call(token, "delete_memo", { id: 404 }));
    expect(r.isError).toBe(true);
  });

  it("cannot touch another user's memo", async () => {
    const token = await mintToken(); // user 1
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (9,'t','theirs',2,1,1)").run();
    const get = await resultText(await call(token, "get_memo", { id: 9 }));
    expect(get.isError).toBe(true);
    const del = await resultText(await call(token, "delete_memo", { id: 9 }));
    expect(del.isError).toBe(true);
  });

  it("rejects an unknown tool name", async () => {
    const token = await mintToken();
    const r = await call(token, "nuke_everything");
    expect(((await r.json()) as any).error.code).toBe(-32602);
  });

  it("tools/call with no params object reports an unknown tool", async () => {
    const token = await mintToken();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call" });
    expect(((await r.json()) as any).error.code).toBe(-32602);
  });

  it("surfaces an unexpected (non-ToolError) failure as a generic tool error", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (id, title, content, user_id, created_at, updated_at) VALUES (10,'t','body',1,1,1)").run();
    // drop the versions table so the snapshot INSERT throws a raw DB error
    db.exec("DROP TABLE memo_versions");
    const r = await resultText(await call(token, "update_memo", { id: 10, content: "changed" }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe("tool execution failed");
  });

  it("create_memo with a missing content field is a tool error", async () => {
    const token = await mintToken();
    const r = await resultText(await rpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_memo", arguments: {} },
    }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("content required");
  });

  it("get_memo with a missing id is a tool error", async () => {
    const token = await mintToken();
    const r = await resultText(await call(token, "get_memo", {}));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("integer");
  });

  it("tools/call defaults arguments to an empty object when omitted", async () => {
    const token = await mintToken();
    await db.prepare("INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES ('only','only',1,1,1)").run();
    const r = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_memos" } });
    const { text } = await resultText(r);
    expect(JSON.parse(text)).toHaveLength(1);
  });

  it("exports six tools", () => {
    expect(TOOLS).toHaveLength(6);
  });

  // runTool's final exhaustiveness guard is unreachable through the endpoint
  // (dispatch validates the name against TOOLS first), so exercise it directly.
  it("runTool throws on an unknown tool name", async () => {
    const ctx = { get: () => 1, env: { DB: db } } as never;
    const deps = { hashToken: async (t: string) => t, titleFrom: (s: string) => s };
    await expect(runTool("mystery", {}, ctx, deps)).rejects.toThrow("unknown tool: mystery");
  });
});
