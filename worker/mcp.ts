// Remote MCP (Model Context Protocol) server — lets Claude (web / mobile / desktop)
// drive nemo as a connector. Implements the stateless Streamable HTTP transport:
// the client POSTs JSON-RPC 2.0 messages to /api/mcp and we answer with a single
// application/json response (no SSE / sessions needed for our request-response
// tools). Auth in this PR is the existing api_tokens Bearer; a later PR layers
// OAuth 2.1 on top so web/mobile connectors can register without pasting a token.
import type { Hono, Context } from "hono";
import type { Bindings, Variables } from "./index";

// The MCP revision we implement. We echo back the client's requested version when
// we recognise it (forward-compat with newer Claude clients), else fall back here.
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const SERVER_INFO = { name: "nemo", version: "1.0.0" } as const;

// JSON-RPC 2.0 error codes we use.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type McpContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type Deps = {
  hashToken: (token: string) => Promise<string>;
  titleFrom: (content: string) => string;
};

// --- tool definitions (advertised via tools/list) ------------------------
// annotations drive Claude's auto-approve UX: readOnlyHint tools can be marked
// "always allow", while destructiveHint tools (delete) always prompt — matching
// the connector permission model the user asked for. Hints are advisory metadata,
// so the server still enforces ownership/validation regardless.
type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

const ro = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const write = (title: string, destructive: boolean, idempotent: boolean) => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: "create_memo",
    description:
      "Create a new memo from markdown content. The first line becomes the title.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memo body (markdown)." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: write("Create memo", false, false),
  },
  {
    name: "list_memos",
    description: "List the user's memos (id, title, last-updated time), newest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: ro("List memos"),
  },
  {
    name: "search_memos",
    description: "Search the user's memos by title and body text. Returns matching memo metadata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: ro("Search memos"),
  },
  {
    name: "get_memo",
    description: "Fetch a single memo's full content by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The memo id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: ro("Read memo"),
  },
  {
    name: "update_memo",
    description:
      "Replace a memo's content by id. The previous content is preserved in history so the edit is recoverable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The memo id." },
        content: { type: "string", description: "The new memo body (markdown)." },
      },
      required: ["id", "content"],
      additionalProperties: false,
    },
    annotations: write("Update memo", false, true),
  },
  {
    name: "delete_memo",
    description: "Move a memo to the trash by id (reversible from the app's trash view).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The memo id." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: write("Delete memo", true, true),
  },
];

// --- tool execution ------------------------------------------------------
// Each tool returns a plain string; the caller wraps it as MCP text content. A
// thrown ToolError becomes an isError tool result (model-visible), distinct from
// a protocol-level JSON-RPC error.
class ToolError extends Error {}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asId(v: unknown): number {
  // accept number or numeric string; reject anything else
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new ToolError("id must be an integer");
  return n;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  c: McpContext,
  deps: Deps
): Promise<string> {
  const uid = c.get("mcpUserId");
  const db = c.env.DB;

  if (name === "create_memo") {
    const content = asString(args.content);
    if (!content.trim()) throw new ToolError("content required");
    const finalContent = content.startsWith("# ") ? content : `# ${content}`;
    const now = Date.now();
    const row = await db
      .prepare(
        "INSERT INTO memos (title, content, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id, title"
      )
      .bind(deps.titleFrom(finalContent), finalContent, uid, now, now)
      .first<{ id: number; title: string }>();
    return JSON.stringify({ created: true, id: row!.id, title: row!.title });
  }

  if (name === "list_memos") {
    const { results } = await db
      .prepare(
        "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL AND user_id = ? ORDER BY updated_at DESC"
      )
      .bind(uid)
      .all();
    return JSON.stringify(results);
  }

  if (name === "search_memos") {
    const q = asString(args.query).trim();
    if (!q) return JSON.stringify([]);
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const { results } = await db
      .prepare(
        "SELECT id, title, updated_at FROM memos WHERE deleted_at IS NULL AND user_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC"
      )
      .bind(uid, like, like)
      .all();
    return JSON.stringify(results);
  }

  if (name === "get_memo") {
    const id = asId(args.id);
    const row = await db
      .prepare(
        "SELECT id, title, content, created_at, updated_at FROM memos WHERE id = ? AND deleted_at IS NULL AND user_id = ?"
      )
      .bind(id, uid)
      .first();
    if (!row) throw new ToolError("memo not found");
    return JSON.stringify(row);
  }

  if (name === "update_memo") {
    const id = asId(args.id);
    const content = asString(args.content);
    const prev = await db
      .prepare(
        "SELECT id FROM memos WHERE id = ? AND deleted_at IS NULL AND user_id = ?"
      )
      .bind(id, uid)
      .first<{ id: number }>();
    if (!prev) throw new ToolError("memo not found");
    const now = Date.now();
    const title = deps.titleFrom(content);
    await db
      .prepare("UPDATE memos SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(title, content, now, id, uid)
      .run();
    return JSON.stringify({ updated: true, id, title });
  }

  if (name === "delete_memo") {
    const id = asId(args.id);
    const found = await db
      .prepare("SELECT id FROM memos WHERE id = ? AND deleted_at IS NULL AND user_id = ?")
      .bind(id, uid)
      .first();
    if (!found) throw new ToolError("memo not found");
    await db
      .prepare("UPDATE memos SET deleted_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), id, uid)
      .run();
    return JSON.stringify({ deleted: true, id });
  }

  throw new ToolError(`unknown tool: ${name}`);
}

// --- JSON-RPC dispatch ---------------------------------------------------
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function negotiateVersion(params: unknown): string {
  const requested =
    params && typeof params === "object"
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof requested === "string" && KNOWN_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

// Handle one JSON-RPC request object → a response object, or null for a
// notification (no id) which gets no reply body.
async function dispatch(
  msg: JsonRpcRequest,
  c: McpContext,
  deps: Deps
): Promise<object | null> {
  const isNotification = msg.id === undefined;
  const id = (msg.id ?? null) as JsonRpcId;

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : rpcError(id, INVALID_REQUEST, "invalid request");
  }
  const method = msg.method;

  // notifications (initialized, cancelled, ...) are acknowledged with no body
  if (isNotification) return null;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: negotiateVersion(msg.params),
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = params.name;
    if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) {
      return rpcError(id, INVALID_PARAMS, "unknown tool");
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await runTool(name, args, c, deps);
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (e) {
      const message = e instanceof ToolError ? e.message : "tool execution failed";
      // tool errors are reported in-band (isError) so the model can react/retry
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }

  return rpcError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
}

// --- route registration --------------------------------------------------
// Registered before the cookie-JWT /api/* gate so the MCP endpoint authenticates
// with its own Bearer middleware instead. The 401 carries a WWW-Authenticate
// challenge pointing at the protected-resource metadata the OAuth PR will serve.
export function registerMcp(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  deps: Deps
): void {
  app.use("/api/mcp", async (c, next) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const unauthorized = () => {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", c.req.url).href}"`
      );
      return c.json({ error: "unauthorized" }, 401);
    };
    if (!token) return unauthorized();
    // honor OAuth access-token expiry (expires_at); manual PATs leave it NULL
    const row = await c.env.DB.prepare(
      "SELECT id, user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
    )
      .bind(await deps.hashToken(token), Date.now())
      .first<{ id: number; user_id: number }>();
    if (!row) return unauthorized();
    await c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now(), row.id)
      .run();
    c.set("mcpUserId", row.user_id);
    return next();
  });

  app.post("/api/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, PARSE_ERROR, "parse error"), 400);
    }

    // a JSON-RPC notification (or batch of only notifications) gets a 202 with no
    // body; a request gets its single response object
    if (Array.isArray(body)) {
      const responses = (
        await Promise.all(body.map((m) => dispatch(m as JsonRpcRequest, c, deps)))
      ).filter((r): r is object => r !== null);
      if (responses.length === 0) return c.body(null, 202);
      return c.json(responses);
    }

    const response = await dispatch(body as JsonRpcRequest, c, deps);
    if (response === null) return c.body(null, 202);
    return c.json(response);
  });

  // stateless server: no server-initiated SSE stream or session teardown
  app.on(["GET", "DELETE"], "/api/mcp", (c) =>
    c.json(rpcError(null, INVALID_REQUEST, "method not allowed"), 405)
  );
}
