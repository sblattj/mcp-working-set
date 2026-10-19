// Stub upstream MCP servers for the offline tests. All built on the SDK server.
//  - modernStub(): createMcpHandler (answers server/discover, so the proxy speaks 2026-07-28)
//  - legacySessionStub(): WebStandardStreamableHTTPServerTransport with session ids (2025-style)
//  - hungStub(): accepts connections, never answers
//  - stdio: see stdio-stub.ts (spawned as a child process)
import { ProtocolError, Server, WebStandardStreamableHTTPServerTransport, createMcpHandler } from "@modelcontextprotocol/server";

export const STUB_TOOLS = [
  { name: "calendar_list_events", description: "List calendar events.", inputSchema: { type: "object", properties: {} } },
  {
    name: "mail_list_labels",
    description: "List mail labels.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { account: { type: "string", title: "Account", default: null } } },
  },
  { name: "codesearch_list_repositories", description: "List indexed repositories.", inputSchema: { type: "object", properties: {} } },
  { name: "drive_search_files", description: "Search files in the drive.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
];

export interface Seen {
  method: string | null;
  name: string | null;
  sessionId: string | null;
  clientInfo?: string;
}

/** An SDK Server exposing STUB_TOOLS. `fail: true` in the arguments returns isError; unknown names are a -32602 error. */
export function stubServer(seenCalls: { name: string; args: unknown; clientInfo?: string }[] = []): Server {
  const s = new Server({ name: "stub-upstream", version: "0" }, { capabilities: { tools: {} } });
  s.setRequestHandler("tools/list", async () => ({ tools: STUB_TOOLS as never }));
  s.setRequestHandler("tools/call", async (req, ctx) => {
    const name = req.params.name;
    const envelope = (ctx as { mcpReq?: { envelope?: Record<string, { name?: string }> } }).mcpReq?.envelope;
    seenCalls.push({ name, args: req.params.arguments, clientInfo: envelope?.["io.modelcontextprotocol/clientInfo"]?.name });
    if (!STUB_TOOLS.some((t) => t.name === name)) throw new ProtocolError(-32602, `unknown tool: ${name}`);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (args.fail) return { content: [{ type: "text", text: "boom" }], isError: true };
    return { content: [{ type: "text", text: `ran ${name} ${JSON.stringify(args)}` }], structuredContent: { ok: name } };
  });
  return s;
}

export function modernStub() {
  const seen: Seen[] = [];
  const calls: { name: string; args: unknown; clientInfo?: string }[] = [];
  const handler = createMcpHandler(() => stubServer(calls));
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      seen.push({ method: req.headers.get("mcp-method"), name: req.headers.get("mcp-name"), sessionId: req.headers.get("mcp-session-id") });
      return handler.fetch(req);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}/mcp`, seen, calls, stop: () => srv.stop(true) };
}

export function legacySessionStub() {
  const seen: Seen[] = [];
  const calls: { name: string; args: unknown; clientInfo?: string }[] = [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const sid = req.headers.get("mcp-session-id");
      seen.push({ method: req.headers.get("mcp-method"), name: req.headers.get("mcp-name"), sessionId: sid });
      if (sid && sessions.has(sid)) return sessions.get(sid)!.handleRequest(req);
      if (sid) return new Response("unknown session", { status: 404 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = await req.clone().json().catch(() => undefined);
      if (body?.method !== "initialize") {
        // A 2025-era server: nothing but initialize opens a session.
        return Response.json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Bad Request: no session" } }, { status: 400 });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, transport),
        enableJsonResponse: true,
      });
      await stubServer(calls).connect(transport);
      return transport.handleRequest(req);
    },
  });
  return { url: `http://127.0.0.1:${srv.port}/mcp`, seen, calls, sessions, stop: () => srv.stop(true) };
}

/** Accepts the TCP connection and the request, never answers. */
export function hungStub() {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  return { url: `http://127.0.0.1:${srv.port}/mcp`, stop: () => srv.stop(true) };
}
