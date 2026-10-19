// The CLI, run as a child process the way a user runs it: `bun src/cli.ts <command>`.
import { afterAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modernStub } from "./fixtures/stub-upstream.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const stub = modernStub();
const dir = mkdtempSync(join(tmpdir(), "mws-cli-"));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ upstream: { url: stub.url }, listen: { host: "127.0.0.1", port: 0 }, stateDir: join(dir, "state"), pins: ["mail_list_labels"], transcripts: [], pinFiles: [] }),
);
afterAll(() => stub.stop());

// Async spawn: the stub upstream lives in this process and must keep answering.
const run = async (args: string[]) => {
  const p = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, MWS_CONFIG: configPath }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

test("no command prints usage and exits 2; help exits 0", async () => {
  const none = await run([]);
  expect(none.code).toBe(2);
  expect(none.out).toContain("mws serve");
  expect((await run(["help"])).code).toBe(0);
  expect((await run(["bogus"])).code).toBe(2);
});

test("mws search ranks the live upstream catalog and prints the reply", async () => {
  const r = await run(["search", "search", "drive", "files"]);
  expect(r.code).toBe(0);
  const reply = JSON.parse(r.out);
  expect(reply.matches[0].name).toBe("drive_search_files");
  expect(r.err).toMatch(/reply \d+ bytes/);
  const cat = await run(["search"]);
  expect(cat.out).toContain("mail (1): mail_list_labels*");
  expect((await run(["search", "zzqx"])).code).toBe(1);
});

test("mws init writes a parseable starter config and refuses to overwrite", async () => {
  const target = join(dir, "new", "config.json");
  const r = await run(["init", "--config", target]);
  expect(r.code).toBe(0);
  const cfg = JSON.parse(readFileSync(target, "utf8"));
  expect(cfg.upstream.url).toContain("/mcp");
  expect(cfg.promote.minSessions).toBe(2);
  expect((await run(["init", "--config", target])).code).toBe(1);
  expect((await run(["init", "--config", target, "--force"])).code).toBe(0);
});

test("mws report runs the promoter module against the configured state", async () => {
  if (!existsSync(join(import.meta.dir, "..", "src", "promote", "index.ts"))) return; // promoter not present
  const r = await run(["report", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).catalog_tools).toBe(4);
});

test("mws serve: real listener, SDK clients of both protocol generations see the working set", async () => {
  const child = Bun.spawn(["bun", CLI, "serve"], { env: { ...process.env, MWS_CONFIG: configPath }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stderr.getReader();
    let buf = "";
    const deadline = Date.now() + 10_000;
    let port: string | undefined;
    while (!port && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      port = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/)?.[1];
    }
    reader.releaseLock();
    expect(port).toBeDefined();
    for (const mode of ["auto", "legacy"] as const) {
      const client = new Client({ name: `cli-test-${mode}`, version: "1" }, { versionNegotiation: { mode } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(["search_tools", "call_tool", "mail_list_labels"]);
      expect(client.getInstructions()).toContain("4 tools");
      const r = await client.callTool({ name: "codesearch_list_repositories", arguments: {} });
      expect((r.content as { text: string }[])[0]!.text).toBe("ran codesearch_list_repositories {}");
      await client.close();
    }
    const lines = readFileSync(join(dir, "state", "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.tool === "codesearch_list_repositories").map((l) => l.client)).toEqual(["cli-test-auto", expect.any(String)]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
});
