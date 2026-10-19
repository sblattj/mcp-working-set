/**
 * The proxy's MCP server (Streamable HTTP via the SDK's createMcpHandler, which answers both the
 * stateless 2026-07-28 protocol and older clients).
 *
 * tools/list = search_tools + call_tool + (working set ∩ live upstream tools), in upstream order,
 * schemas slimmed. tools/call: the two meta-tools are handled here; any other name is forwarded
 * upstream whether it is listed or not, so a client holding an older listing keeps working.
 *
 * Logs (stateDir/calls.jsonl), one JSON line each, never arguments, results or query text:
 *   call   {ts, tool, via: "direct"|"call_tool", ok, ms, client}
 *   search {ts, event: "search", bytes, results, client}   (results -1 = the no-query catalog)
 */
import {
  ProtocolError,
  Server,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Catalog, META_TOOL_NAMES, WorkingSet } from "./catalog.ts";
import { type Config, statePaths } from "./config.ts";
import { slimTool } from "./schema.ts";
import { backendOf, renderSearchReply, type SearchReply } from "./search.ts";
import { PRODUCT, SdkUpstream, type Upstream, UpstreamRpcError, VERSION } from "./upstream.ts";

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;

export const defaultLog = (msg: string) => console.error(`[${PRODUCT}] ${msg}`);

export interface ProxyDeps {
  upstream?: Upstream;
  log?: (msg: string) => void;
}

/** Everything one proxy instance needs; tests build one per stub upstream. */
export class Proxy {
  readonly upstream: Upstream;
  readonly catalog: Catalog;
  readonly workingSet: WorkingSet;
  readonly callLog: string;
  readonly log: (msg: string) => void;

  constructor(
    readonly config: Config,
    deps: ProxyDeps = {},
  ) {
    this.log = deps.log ?? defaultLog;
    const paths = statePaths(config);
    this.upstream = deps.upstream ?? new SdkUpstream(config.upstream, this.log);
    this.catalog = new Catalog(
      this.upstream,
      { cachePath: paths.catalog, ttlMs: config.timeouts.catalogTtlMs, listTimeoutMs: config.timeouts.listMs },
      this.log,
    );
    this.workingSet = new WorkingSet(paths.workingSet, config.pins, this.log);
    this.callLog = paths.calls;
  }

  // ---- instructions and meta-tools ---------------------------------------------------------

  /** Instructions from a catalog (backend counts, totals) when one is known, else a generic text. */
  instructions(tools: Tool[] | undefined = this.catalog.lastGood(), listed: Set<string> = this.workingSet.names()): string {
    const name = this.config.serverName;
    const call =
      "run it with call_tool {name, arguments}. call_tool behaves exactly like calling the tool directly (same arguments, same errors). Do not guess arguments: search first.";
    if (!tools || tools.length === 0) {
      return [
        `${name} proxies an MCP server whose tools are named {backend}_{tool}.`,
        `TOOLS: only a working set is listed. The rest are found with search_tools {query} (returns description and inputSchema; no query = catalog grouped by backend); ${call}`,
      ].join("\n\n");
    }
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(backendOf(t.name), (counts.get(backendOf(t.name)) ?? 0) + 1);
    const hints = this.config.backendHints;
    const backends = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([b, n]) => (hints[b] ? `${b} = ${hints[b]} (${n})` : `${b} (${n})`));
    const listedCount = tools.filter((t) => listed.has(t.name)).length;
    return [
      `${name} proxies ${counts.size} backends, ${tools.length} tools: ${backends.join(", ")}. Tool names are {backend}_{tool}.`,
      `TOOLS: ${listedCount} are listed. The other ${tools.length - listedCount} are found with search_tools {query} (returns its description and inputSchema; no query = catalog grouped by backend); ${call}`,
    ].join("\n\n");
  }

  metaTools(): Tool[] {
    const hints = Object.values(this.config.backendHints);
    const scope = hints.length ? ` (${hints.join("; ")})` : "";
    return [
      {
        name: "search_tools",
        description: `Find a ${this.config.serverName} tool that is not in your tool list${scope}. Returns the best matches with description and inputSchema; run one with call_tool. With no query, returns the catalog of every tool by backend.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords or an exact tool name. Omit for the catalog." },
            limit: { type: "integer", description: `Max matches to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
          },
          additionalProperties: false,
        } as Tool["inputSchema"],
      },
      {
        name: "call_tool",
        description: `Run any ${this.config.serverName} tool by name, including the ones not in your tool list. Look its arguments up with search_tools first. Behaves exactly like calling the tool directly (same arguments, same errors).`,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tool name from search_tools." },
            arguments: { type: "object", description: "That tool's arguments, per its inputSchema.", additionalProperties: true },
          },
          required: ["name"],
          additionalProperties: false,
        } as Tool["inputSchema"],
      },
    ];
  }

  /** The two meta-tools, then every working-set name the upstream currently lists, in upstream order. */
  async listing(): Promise<Tool[]> {
    const names = this.workingSet.names();
    let tools: Tool[];
    try {
      tools = await this.catalog.tools();
    } catch (err) {
      this.log(`upstream tools/list failed (${err instanceof Error ? err.message : err}); no last-good catalog, listing only meta-tools`);
      return this.metaTools();
    }
    const compact = this.config.compactDescriptions;
    return [...this.metaTools(), ...tools.filter((t) => names.has(t.name) && !META_TOOL_NAMES.has(t.name)).map((t) => slimTool(t, { compactDescriptions: compact }))];
  }

  renderCatalog(tools: Tool[], listed: Set<string>): string {
    const groups = new Map<string, string[]>();
    for (const t of tools) {
      const b = backendOf(t.name);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b)!.push(t.name);
    }
    const listedCount = tools.filter((t) => listed.has(t.name)).length;
    const lines = [`${PRODUCT} ${VERSION}: ${tools.length} tools upstream, ${listedCount} in the working set (tools/list)`];
    for (const [b, names] of [...groups.entries()].sort(([a], [c]) => a.localeCompare(c))) {
      lines.push(`${b} (${names.length}): ${names.map((n) => (listed.has(n) ? `${n}*` : n)).join(", ")}`);
    }
    lines.push("* = already in your tool list. Run any tool with call_tool {name, arguments}; search_tools {query:<name>} returns its inputSchema.");
    return lines.join("\n");
  }

  search(tools: Tool[], listed: Set<string>, query: string, rawLimit?: unknown): SearchReply {
    const limit =
      typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
    return renderSearchReply(tools, listed, query, limit, { aliases: this.config.searchAliases });
  }

  // ---- logs --------------------------------------------------------------------------------

  private append(entry: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.callLog), { recursive: true });
      appendFileSync(this.callLog, JSON.stringify(entry) + "\n");
    } catch (err) {
      this.log(`call log write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  logCall(e: { tool: string; via: "direct" | "call_tool"; ok: boolean; ms: number; client: string | null }): void {
    this.append({ ts: new Date().toISOString(), tool: e.tool, via: e.via, ok: e.ok, ms: e.ms, client: e.client });
  }

  /** No `tool` key (the promoter skips lines without one) and no query text. */
  logSearch(e: { bytes: number; results: number; client: string | null }): void {
    this.append({ ts: new Date().toISOString(), event: "search", bytes: e.bytes, results: e.results, client: e.client });
  }

  // ---- calls -------------------------------------------------------------------------------

  /**
   * Forward one tool call. An upstream JSON-RPC error is re-raised as the same protocol error on
   * a direct call; through call_tool (itself a tool) it becomes an isError result carrying the text.
   */
  async forward(name: string, args: Record<string, unknown>, via: "direct" | "call_tool", client: string | null) {
    const started = Date.now();
    let ok = false;
    try {
      const body = await this.upstream.callTool(name, args, { clientName: client, timeoutMs: this.config.timeouts.callMs });
      ok = body.isError !== true;
      return body;
    } catch (err) {
      if (err instanceof UpstreamRpcError) {
        if (via === "direct") throw new ProtocolError(err.code, err.message, err.data);
        return { content: [{ type: "text" as const, text: `upstream error ${err.code}: ${err.message}${err.data !== undefined ? ` ${JSON.stringify(err.data)}` : ""}` }], isError: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `${PRODUCT}: ${message}` }], isError: true };
    } finally {
      this.logCall({ tool: name, via, ok, ms: Date.now() - started, client });
    }
  }

  async handleCall(name: string, args: Record<string, unknown>, client: string | null) {
    if (name === "search_tools") {
      let tools: Tool[];
      try {
        tools = await this.catalog.tools();
      } catch (err) {
        const text = `search_tools: upstream unreachable and no last-good catalog (${err instanceof Error ? err.message : err})`;
        this.logSearch({ bytes: Buffer.byteLength(text), results: 0, client });
        return { content: [{ type: "text" as const, text }], isError: true };
      }
      const listed = this.workingSet.names();
      const { query, limit } = args as { query?: unknown; limit?: unknown };
      if (typeof query !== "string" || query.trim() === "") {
        const text = this.renderCatalog(tools, listed);
        this.logSearch({ bytes: Buffer.byteLength(text), results: -1, client });
        return { content: [{ type: "text" as const, text }] };
      }
      const reply = this.search(tools, listed, query, limit);
      const text = JSON.stringify(reply);
      this.logSearch({ bytes: Buffer.byteLength(text), results: reply.matches.length, client });
      return { content: [{ type: "text" as const, text }] };
    }

    if (name === "call_tool") {
      const inner = args as { name?: unknown; arguments?: unknown };
      if (typeof inner.name !== "string" || inner.name === "") {
        return { content: [{ type: "text" as const, text: "call_tool: `name` is required (find one with search_tools)" }], isError: true };
      }
      if (META_TOOL_NAMES.has(inner.name)) {
        return { content: [{ type: "text" as const, text: `call_tool: '${inner.name}' is a meta-tool; call it directly` }], isError: true };
      }
      const innerArgs = inner.arguments ?? {};
      if (typeof innerArgs !== "object" || innerArgs === null || Array.isArray(innerArgs)) {
        return { content: [{ type: "text" as const, text: "call_tool: `arguments` must be an object" }], isError: true };
      }
      return this.forward(inner.name, innerArgs as Record<string, unknown>, "call_tool", client);
    }

    return this.forward(name, args, "direct", client);
  }

  // ---- MCP server ----------------------------------------------------------------------------

  buildServer(): Server {
    const server = new Server(
      { name: PRODUCT, version: VERSION },
      {
        // The listing CAN change (working-set.json edits), so no long cache hint: the SDK default
        // is ttlMs 0 / private, i.e. the client re-lists whenever it wants a fresh view.
        capabilities: { tools: { listChanged: false } },
        // Built per request, synchronously: last-good catalog from memory/disk, never the network.
        instructions: this.instructions(),
      },
    );
    server.setRequestHandler("tools/list", async () => ({ tools: await this.listing() }));
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return this.handleCall(request.params.name, args, clientNameOf(request.params, ctx));
    });
    return server;
  }

  /** The HTTP handler: localhost Host/Origin validation, then the SDK handler. */
  httpHandler() {
    const handler = createMcpHandler(() => this.buildServer(), { onerror: (err) => this.log(`http: ${err.message}`) });
    return {
      fetch: (req: Request) =>
        hostHeaderValidationResponse(req, localhostAllowedHostnames()) ??
        originValidationResponse(req, localhostAllowedOrigins()) ??
        handler.fetch(req),
      close: () => handler.close(),
    };
  }
}

/**
 * The calling client's name. The SDK lifts the 2026-07-28 `_meta` envelope off request.params and
 * hands it to the handler as ctx.mcpReq.envelope; params._meta is checked too. Fallback for
 * clients that send clientInfo only in `initialize` (pre-2026 protocol): the HTTP User-Agent.
 */
export function clientNameOf(params: unknown, ctx: unknown): string | null {
  const key = "io.modelcontextprotocol/clientInfo";
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)?.mcpReq?.envelope;
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const info = (envelope?.[key] ?? meta?.[key]) as { name?: unknown } | undefined;
  if (typeof info?.name === "string") return info.name;
  const ua = (ctx as { http?: { req?: Request } } | undefined)?.http?.req?.headers?.get("user-agent");
  return ua ? ua.slice(0, 80) : null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Start the listener. Loopback only: the Host/Origin checks reject anything else. */
export async function serve(config: Config, deps: ProxyDeps = {}) {
  if (typeof Bun === "undefined") throw new Error("needs Bun (Bun.serve)");
  if (!LOOPBACK.has(config.listen.host)) {
    throw new Error(`listen.host ${config.listen.host} is not loopback; this proxy only serves localhost clients`);
  }
  const proxy = new Proxy(config, deps);
  proxy.workingSet.names();
  // One bounded catalog fetch before listening, so the first client already gets instructions
  // built from the catalog (a down upstream delays startup by at most timeouts.listMs).
  await proxy.catalog.tools().catch((err) => proxy.log(`startup catalog fetch failed: ${err instanceof Error ? err.message : err}`));
  const http = proxy.httpHandler();
  const listener = Bun.serve({ port: config.listen.port, hostname: config.listen.host, fetch: http.fetch });
  const stop = async () => {
    await http.close().catch(() => undefined);
    await proxy.upstream.close();
    listener.stop();
  };
  proxy.log(
    `v${VERSION} listening on http://${config.listen.host}:${listener.port}/mcp, upstream ${proxy.upstream.describe()}, working set ${proxy.workingSet.path}, log ${proxy.callLog}`,
  );
  return { proxy, port: listener.port, stop };
}
