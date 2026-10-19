/**
 * The upstream MCP server, reached through the official SDK client.
 *
 * Transports:
 *  - { url }     Streamable HTTP. versionNegotiation "auto": the client probes with server/discover
 *                and speaks the stateless 2026-07-28 protocol when the server offers it (the SDK then
 *                sends MCP-Protocol-Version, Mcp-Method and Mcp-Name headers and the per-request _meta
 *                envelope itself), else falls back to the session-based initialize handshake.
 *  - { command } stdio child process, same negotiation (the SDK probes on a short-lived sibling).
 *
 * One client per proxy, connected lazily and rebuilt after a transport failure. A JSON-RPC error
 * returned by the upstream surfaces as UpstreamRpcError (code, message, data intact) so a direct
 * call can re-raise it unchanged.
 */
import {
  CLIENT_INFO_META_KEY,
  Client,
  ProtocolError as ClientProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { type UpstreamConfig, isStdio } from "./config.ts";

export const VERSION = "0.1.0";
export const PRODUCT = "mcp-working-set";

export class UpstreamRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type ToolCallBody = CallToolResult;

export interface Upstream {
  listTools(timeoutMs: number): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, opts: { clientName: string | null; timeoutMs: number }): Promise<ToolCallBody>;
  close(): Promise<void>;
  describe(): string;
}

/** Reject after `ms` with a timeout error; the work keeps running but nobody waits for it. */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`upstream ${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Keep the CallToolResult body (content, structuredContent, isError); drop the upstream's envelope
 * (resultType, cache hints, _meta.serverInfo), which the proxy's own server re-adds.
 */
export function toolResultBody(result: Record<string, unknown> | undefined): ToolCallBody {
  const { resultType: _rt, ttlMs: _ttl, cacheScope: _cs, _meta: _m, ...body } = result ?? {};
  if (!Array.isArray(body.content)) body.content = [];
  return body as unknown as ToolCallBody;
}

export class SdkUpstream implements Upstream {
  private conn: Promise<Client> | undefined;

  constructor(
    private readonly cfg: UpstreamConfig,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  describe(): string {
    return isStdio(this.cfg) ? `stdio: ${[this.cfg.command, ...(this.cfg.args ?? [])].join(" ")}` : this.cfg.url;
  }

  private transport() {
    if (isStdio(this.cfg)) {
      return new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        env: { ...getDefaultEnvironment(), ...(this.cfg.env ?? {}) },
        ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
        stderr: "inherit",
      });
    }
    return new StreamableHTTPClientTransport(new URL(this.cfg.url), {
      ...(this.cfg.headers ? { requestInit: { headers: this.cfg.headers } } : {}),
    });
  }

  private client(timeoutMs: number): Promise<Client> {
    if (this.conn) return this.conn;
    const attempt = (async () => {
      const client = new Client(
        { name: PRODUCT, version: VERSION },
        { versionNegotiation: { mode: "auto", probe: { timeoutMs } } },
      );
      client.onclose = () => {
        if (this.conn === attempt) this.conn = undefined;
      };
      try {
        await withTimeout(client.connect(this.transport(), { timeout: timeoutMs }), timeoutMs + 100, "connect");
      } catch (err) {
        void client.close().catch(() => undefined);
        throw err;
      }
      this.log(`connected to ${this.describe()} (${client.getProtocolEra() ?? "?"} era, protocol ${client.getNegotiatedProtocolVersion() ?? "?"})`);
      return client;
    })();
    this.conn = attempt;
    attempt.catch(() => {
      if (this.conn === attempt) this.conn = undefined;
    });
    return attempt;
  }

  /** Drop the cached client after a transport-level failure, so the next request reconnects. */
  private reset(client: Client | undefined): void {
    this.conn = undefined;
    if (client) void client.close().catch(() => undefined);
  }

  async listTools(timeoutMs: number): Promise<Tool[]> {
    // tools/list is idempotent: one retry on a fresh connection covers an expired legacy session
    // or a restarted stdio child.
    for (let attempt = 0; ; attempt++) {
      let client: Client | undefined;
      try {
        return await withTimeout(
          (async () => {
            client = await this.client(timeoutMs);
            const result = await client.listTools(undefined, { timeout: timeoutMs, cacheMode: "bypass" });
            return result.tools as Tool[];
          })(),
          timeoutMs + 200,
          "tools/list",
        );
      } catch (err) {
        if (err instanceof ClientProtocolError) throw new UpstreamRpcError(err.code, err.message, err.data);
        this.reset(client);
        if (attempt >= 1 || client === undefined) throw err;
      }
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { clientName: string | null; timeoutMs: number },
  ): Promise<ToolCallBody> {
    let client: Client | undefined;
    try {
      client = await this.client(Math.min(opts.timeoutMs, 30_000));
      const params: Record<string, unknown> = { name, arguments: args };
      // Modern era: name the calling client in the per-request envelope (user keys win over the
      // SDK's auto-attached ones). Legacy sessions carry clientInfo only in initialize.
      if (opts.clientName && client.getProtocolEra() === "modern") {
        params._meta = { [CLIENT_INFO_META_KEY]: { name: `${PRODUCT}/${opts.clientName}`, version: VERSION } };
      }
      // client.request, not client.callTool: a proxy passes results through untouched, without
      // the SDK's client-side output-schema validation.
      const result = await client.request({ method: "tools/call", params } as never, { timeout: opts.timeoutMs });
      return toolResultBody(result as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ClientProtocolError) throw new UpstreamRpcError(err.code, err.message, err.data);
      // Not retried: a tool call may have side effects.
      this.reset(client);
      throw err;
    }
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    if (conn) await conn.then((c) => c.close()).catch(() => undefined);
  }
}
