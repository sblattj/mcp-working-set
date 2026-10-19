// Offline tests: stub upstreams (SDK servers on OS-assigned ports, plus a stdio child) stand in
// for the real server, and requests go through Proxy.httpHandler(), the same entry `mws serve` uses.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Proxy } from "../src/server.ts";
import { STUB_TOOLS, hungStub, legacySessionStub, modernStub } from "./fixtures/stub-upstream.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "unit-client", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function makeProxy(upstream: unknown, extra: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "mws-test-"));
  const logs: string[] = [];
  const config = resolveConfig({ upstream, stateDir, timeouts: { listMs: 1000, catalogTtlMs: 0 }, ...extra });
  const proxy = new Proxy(config, { log: (m) => logs.push(m) });
  const http = proxy.httpHandler();
  const workingSet = join(stateDir, "working-set.json");
  const writeWorkingSet = (doc: object) => {
    writeFileSync(workingSet, JSON.stringify(doc));
    const later = new Date(Date.now() + Math.floor(Math.random() * 100_000) + 5000);
    utimesSync(workingSet, later, later); // guarantee an mtime change within the same ms
  };
  async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, meta: object | null = META) {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      host: "127.0.0.1:4484",
      ...headers,
    };
    if (method === "tools/call") h["mcp-name"] = String(params.name);
    const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta ?? { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
    const res = await http.fetch(new Request("http://127.0.0.1:4484/mcp", { method: "POST", headers: h, body: JSON.stringify(body) }));
    return res.json() as Promise<any>;
  }
  const listNames = async () => ((await rpc("tools/list")).result.tools as { name: string }[]).map((t) => t.name);
  const logLines = () => {
    try {
      return readFileSync(join(stateDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const close = async () => {
    await http.close();
    await proxy.upstream.close();
  };
  return { proxy, http, rpc, listNames, writeWorkingSet, logLines, logs, stateDir, close };
}

describe("modern HTTP upstream", () => {
  const stub = modernStub();
  const p = makeProxy({ url: stub.url });
  afterAll(async () => {
    await p.close();
    stub.stop();
  });

  test("tools/list = meta-tools + (working set ∩ upstream), upstream order, not cacheable", async () => {
    p.writeWorkingSet({ generated_at: "x", promoted: [], pinned: ["calendar_list_events", "not_upstream", "call_tool"], notes: "" });
    expect(await p.listNames()).toEqual(["search_tools", "call_tool", "calendar_list_events"]);
    const r = await p.rpc("tools/list");
    expect(r.result.ttlMs).toBe(0);
    expect(r.result.cacheScope).toBe("private");
    expect(p.logs.some((l) => l.includes("modern era"))).toBe(true);
  });

  test("working-set.json edits take effect without restart", async () => {
    p.writeWorkingSet({ promoted: ["mail_list_labels", "codesearch_list_repositories"], pinned: ["calendar_list_events"] });
    expect(await p.listNames()).toEqual(["search_tools", "call_tool", "calendar_list_events", "mail_list_labels", "codesearch_list_repositories"]);
  });

  test("listed schemas are slimmed; search replies keep the upstream schema", async () => {
    const tools = (await p.rpc("tools/list")).result.tools as any[];
    const labels = tools.find((t) => t.name === "mail_list_labels");
    expect(labels.inputSchema.$schema).toBeUndefined();
    expect(labels.inputSchema.properties.account).toEqual({ type: "string" });
    const s = await p.rpc("tools/call", { name: "search_tools", arguments: { query: "mail_list_labels" } });
    const reply = JSON.parse(s.result.content[0].text);
    expect(reply.matches[0].inputSchema).toEqual(STUB_TOOLS[1]!.inputSchema);
    expect(reply.matches[0].listed).toBe(true);
  });

  test("search_tools ranks; no query returns the catalog by backend", async () => {
    const r = await p.rpc("tools/call", { name: "search_tools", arguments: { query: "search drive files" } });
    expect(JSON.parse(r.result.content[0].text).matches[0].name).toBe("drive_search_files");
    const cat = await p.rpc("tools/call", { name: "search_tools", arguments: {} });
    expect(cat.result.content[0].text).toContain("codesearch (1): codesearch_list_repositories*");
    expect(cat.result.content[0].text).toContain("drive (1): drive_search_files\n");
  });

  test("an unlisted tool is callable directly; Mcp-Name rides the upstream request", async () => {
    const r = await p.rpc("tools/call", { name: "drive_search_files", arguments: { query: "q" } });
    expect(r.result.content[0].text).toBe('ran drive_search_files {"query":"q"}');
    expect(r.result.structuredContent).toEqual({ ok: "drive_search_files" });
    expect(r.result._meta?.["io.modelcontextprotocol/serverInfo"]?.name).not.toBe("stub-upstream");
    const last = stub.seen.filter((s) => s.method === "tools/call").at(-1)!;
    expect(last.name).toBe("drive_search_files");
    expect(stub.calls.at(-1)!.clientInfo).toBe("mcp-working-set/unit-client");
  });

  test("call_tool forwards; its errors come back as isError results", async () => {
    const ok = await p.rpc("tools/call", { name: "call_tool", arguments: { name: "codesearch_list_repositories", arguments: { a: 1 } } });
    expect(ok.result.content[0].text).toBe('ran codesearch_list_repositories {"a":1}');
    const missingName = await p.rpc("tools/call", { name: "call_tool", arguments: {} });
    expect(missingName.result.isError).toBe(true);
    expect(missingName.result.content[0].text).toContain("`name` is required");
    const meta = await p.rpc("tools/call", { name: "call_tool", arguments: { name: "search_tools" } });
    expect(meta.result.content[0].text).toContain("meta-tool");
    const badArgs = await p.rpc("tools/call", { name: "call_tool", arguments: { name: "mail_list_labels", arguments: [1] } });
    expect(badArgs.result.content[0].text).toContain("must be an object");
    const unknown = await p.rpc("tools/call", { name: "call_tool", arguments: { name: "nope_tool" } });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("upstream error -32602");
  });

  test("direct call: isError passes through; an upstream JSON-RPC error is re-raised with its code", async () => {
    const bad = await p.rpc("tools/call", { name: "calendar_list_events", arguments: { fail: true } });
    expect(bad.result.isError).toBe(true);
    const unknown = await p.rpc("tools/call", { name: "nope_tool", arguments: {} });
    expect(unknown.error.code).toBe(-32602);
  });

  test("call log: one line per forwarded call, fixed keys, no arguments or results", () => {
    const calls = p.logLines().filter((l) => typeof l.tool === "string");
    for (const l of calls) expect(Object.keys(l).sort()).toEqual(["client", "ms", "ok", "tool", "ts", "via"]);
    expect(calls.map((l) => [l.tool, l.via, l.ok])).toEqual([
      ["drive_search_files", "direct", true],
      ["codesearch_list_repositories", "call_tool", true],
      ["nope_tool", "call_tool", false],
      ["calendar_list_events", "direct", false],
      ["nope_tool", "direct", false],
    ]);
    expect(calls[0].client).toBe("unit-client");
    const raw = readFileSync(join(p.stateDir, "calls.jsonl"), "utf8");
    expect(raw).not.toContain("fail");
    expect(raw).not.toContain("ran ");
  });

  test("search event log: no tool key, no query text, results -1 for the catalog", () => {
    const searches = p.logLines().filter((l) => l.event === "search");
    expect(searches.length).toBe(3);
    for (const l of searches) {
      expect(Object.keys(l).sort()).toEqual(["bytes", "client", "event", "results", "ts"]);
      expect(l.bytes).toBeGreaterThan(0);
      expect(l.client).toBe("unit-client");
    }
    expect(searches.map((l) => l.results)).toEqual([1, searches[1].results, -1]);
    expect(searches[1].results).toBeGreaterThan(0);
    expect(readFileSync(join(p.stateDir, "calls.jsonl"), "utf8")).not.toContain("search drive files");
  });

  test("User-Agent is the client fallback when no clientInfo rides the request", async () => {
    const r = await p.rpc("tools/call", { name: "search_tools", arguments: {} }, { "user-agent": "ua-client/9" }, null);
    expect(r.result.content[0].text).toContain("mcp-working-set");
    expect([p.logLines().at(-1).event, p.logLines().at(-1).client]).toEqual(["search", "ua-client/9"]);
  });

  test("last-good catalog is persisted 0600 with no tmp left behind", () => {
    const file = join(p.stateDir, "catalog.json");
    expect(JSON.parse(readFileSync(file, "utf8")).tools.map((t: any) => t.name)).toEqual(STUB_TOOLS.map((t) => t.name));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(p.stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("generated instructions: backend counts and hints from the catalog, generic without one", async () => {
    const q = makeProxy({ url: stub.url }, { serverName: "work", backendHints: { mail: "mailbox" } });
    const text = q.proxy.instructions(STUB_TOOLS as any, new Set(["mail_list_labels"]));
    expect(text).toContain("work proxies 4 backends, 4 tools");
    expect(text).toContain("mail = mailbox (1)");
    expect(text).toContain("drive (1)");
    expect(text).toContain("1 are listed. The other 3");
    const generic = q.proxy.instructions(undefined, new Set());
    expect(generic).toContain("search_tools");
    expect(generic).not.toMatch(/\d+ tools/);
    expect(q.proxy.metaTools()[0]!.description).toContain("(mailbox)");
    // the served instructions come from the last-good catalog on disk once one exists
    const init = await p.rpc("server/discover");
    expect(JSON.stringify(init)).toContain("4 backends");
    await q.close();
  });
});

describe("last-good fallback", () => {
  test("dead upstream: listing and search use the on-disk catalog; calls fail cleanly", async () => {
    const stub = modernStub();
    const live = makeProxy({ url: stub.url });
    live.writeWorkingSet({ promoted: ["mail_list_labels"], pinned: [] });
    expect(await live.listNames()).toEqual(["search_tools", "call_tool", "mail_list_labels"]);
    await live.close();
    stub.stop();

    // A fresh process over the same stateDir with the upstream gone.
    const cfg = { upstream: { url: "http://127.0.0.1:1/mcp" }, stateDir: live.stateDir, timeouts: { listMs: 1000, catalogTtlMs: 0 } };
    const logs: string[] = [];
    const dead = new Proxy(resolveConfig(cfg), { log: (m) => logs.push(m) });
    const http = dead.httpHandler();
    const call = async (method: string, params: object) =>
      (await http.fetch(new Request("http://127.0.0.1:4484/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": (params as any).name } : {}), host: "127.0.0.1:4484" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
      }))).json() as Promise<any>;
    const listed = await call("tools/list", {});
    expect(listed.result.tools.map((t: any) => t.name)).toEqual(["search_tools", "call_tool", "mail_list_labels"]);
    const s = await call("tools/call", { name: "search_tools", arguments: { query: "search drive files" } });
    expect(JSON.parse(s.result.content[0].text).matches[0].name).toBe("drive_search_files");
    const c = await call("tools/call", { name: "mail_list_labels", arguments: {} });
    expect(c.result.isError).toBe(true);
    expect(logs.some((l) => l.includes("serving last-good catalog"))).toBe(true);
    await http.close();
  });

  test("hung upstream: tools/list answers from last-good within the list timeout", async () => {
    const stub = modernStub();
    const live = makeProxy({ url: stub.url });
    live.writeWorkingSet({ promoted: ["calendar_list_events"], pinned: [] });
    await live.listNames();
    await live.close();
    stub.stop();

    const hung = hungStub();
    const cfg = { upstream: { url: hung.url }, stateDir: live.stateDir, timeouts: { listMs: 400, catalogTtlMs: 0 } };
    const proxy = new Proxy(resolveConfig(cfg), { log: () => {} });
    const t0 = Date.now();
    const tools = await proxy.listing();
    const ms = Date.now() - t0;
    expect(tools.map((t) => t.name)).toEqual(["search_tools", "call_tool", "calendar_list_events"]);
    expect(ms).toBeLessThan(2000);
    await proxy.upstream.close();
    hung.stop();
  });

  test("no upstream and no last-good catalog: only the meta-tools, search reports the outage", async () => {
    const p = makeProxy({ url: "http://127.0.0.1:1/mcp" });
    expect(await p.listNames()).toEqual(["search_tools", "call_tool"]);
    const s = await p.rpc("tools/call", { name: "search_tools", arguments: { query: "x" } });
    expect(s.result.isError).toBe(true);
    expect(s.result.content[0].text).toContain("unreachable");
    await p.close();
  });
});

describe("session-based (2025) HTTP upstream", () => {
  const stub = legacySessionStub();
  const p = makeProxy({ url: stub.url }, { pins: ["drive_search_files"] });
  afterAll(async () => {
    await p.close();
    stub.stop();
  });

  test("negotiates the legacy era, lists the working set, forwards calls on the session", async () => {
    p.writeWorkingSet({ promoted: ["mail_list_labels"], pinned: [] });
    expect(await p.listNames()).toEqual(["search_tools", "call_tool", "mail_list_labels", "drive_search_files"]);
    expect(p.logs.some((l) => l.includes("legacy era"))).toBe(true);
    const r = await p.rpc("tools/call", { name: "codesearch_list_repositories", arguments: {} });
    expect(r.result.content[0].text).toBe("ran codesearch_list_repositories {}");
    expect(stub.seen.filter((s) => s.sessionId).length).toBeGreaterThan(0);
    expect(stub.sessions.size).toBe(1);
  });

  test("an expired session is re-established on the next tools/list", async () => {
    stub.sessions.clear();
    expect(await p.listNames()).toEqual(["search_tools", "call_tool", "mail_list_labels", "drive_search_files"]);
    expect(stub.sessions.size).toBe(1);
  });
});

describe("stdio upstream", () => {
  const p = makeProxy({ command: "bun", args: ["run", join(import.meta.dir, "fixtures", "stdio-stub.ts")] });
  afterAll(() => p.close());

  test("lists the working set and forwards direct and call_tool calls to the child", async () => {
    p.writeWorkingSet({ promoted: ["codesearch_list_repositories"], pinned: [] });
    expect(await p.listNames()).toEqual(["search_tools", "call_tool", "codesearch_list_repositories"]);
    const direct = await p.rpc("tools/call", { name: "mail_list_labels", arguments: { x: 1 } });
    expect(direct.result.content[0].text).toBe('ran mail_list_labels {"x":1}');
    const via = await p.rpc("tools/call", { name: "call_tool", arguments: { name: "nope_tool" } });
    expect(via.result.content[0].text).toContain("-32602");
  });
});

describe("listener", () => {
  test("rejects a non-localhost Host header", async () => {
    const p = makeProxy({ url: "http://127.0.0.1:1/mcp" });
    const res = await p.http.fetch(
      new Request("http://evil.example/mcp", {
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(res.status).toBe(403);
    await p.close();
  });
});
