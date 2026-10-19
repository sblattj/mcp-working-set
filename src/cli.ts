#!/usr/bin/env bun
/**
 * mws: the mcp-working-set command line.
 *
 *   mws serve                 run the proxy (listen.host:listen.port, path /mcp)
 *   mws promote [--dry-run]   recompute working-set.json from transcripts, the call log and pins
 *   mws report [--json]       what is listed, what it costs, how calls and searches went
 *   mws search "<query>"      run search_tools against the live upstream catalog and print the reply
 *   mws init [--force]        write a starter config file
 *
 * Global: --config <path> (else $MWS_CONFIG, else ~/.config/mcp-working-set/config.json).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Catalog } from "./catalog.ts";
import { type Config, DEFAULT_CONFIG_PATH, expandHome, loadConfig, statePaths } from "./config.ts";
import { Proxy, defaultLog, serve } from "./server.ts";
import { SdkUpstream, VERSION } from "./upstream.ts";

const USAGE = `mws ${VERSION}: an MCP proxy that lists a usage-promoted working set

usage:
  mws serve                 run the proxy
  mws promote [--dry-run]   recompute working-set.json
  mws report [--json]       listed tools, their cost, call and search stats
  mws search "<query>"      search the live upstream catalog, print the reply
  mws init [--force]        write a starter config

options:
  --config <path>           config file (else $MWS_CONFIG, else ${DEFAULT_CONFIG_PATH.replace(process.env.HOME ?? "\0", "~")})
`;

/** Split out --config; everything else is passed through to the command. */
export function parseGlobal(argv: string[]): { configPath?: string; command?: string; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") configPath = argv[++i];
    else if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
    else rest.push(a);
  }
  const [command, ...args] = rest;
  return { configPath, command, rest: args };
}

/** A catalog fetcher for the promoter: the live upstream, else the last-good catalog on disk. */
function catalogFetcher(config: Config) {
  return async () => {
    const upstream = new SdkUpstream(config.upstream, () => {});
    try {
      const catalog = new Catalog(upstream, { cachePath: statePaths(config).catalog, ttlMs: 0, listTimeoutMs: config.timeouts.listMs });
      return await catalog.tools();
    } finally {
      await upstream.close();
    }
  };
}

export const STARTER_CONFIG = {
  upstream: { url: "http://127.0.0.1:4483/mcp" },
  listen: { host: "127.0.0.1", port: 4484 },
  stateDir: "~/.local/state/mcp-working-set",
  serverName: "toolbox",
  backendHints: {},
  pins: [],
  pinFiles: ["~/.claude/skills/*/SKILL.md"],
  promote: { minSessions: 2, minCalls: 1, windowDays: 30, keepDays: 60, pinDecayDays: 90 },
  transcripts: [{ type: "claude-code", root: "~/.claude/projects" }],
};

async function main(argv: string[]): Promise<number> {
  const { configPath, command, rest } = parseGlobal(argv);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "version") {
    console.log(VERSION);
    return 0;
  }

  if (command === "init") {
    const file = resolve(expandHome(configPath ?? process.env.MWS_CONFIG ?? DEFAULT_CONFIG_PATH));
    if (existsSync(file) && !rest.includes("--force")) {
      console.error(`${file} exists; pass --force to overwrite`);
      return 1;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
    console.log(`wrote ${file}`);
    console.log(`edit "upstream" to point at your MCP server: {"url": "..."} or {"command": "...", "args": [...]}.`);
    console.log("every field is optional; see the Configuration section of the README for what each one does.");
    return 0;
  }

  const config = loadConfig(configPath);

  switch (command) {
    case "serve": {
      const { stop } = await serve(config);
      const onSignal = () => void stop().then(() => process.exit(0));
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      return new Promise<number>(() => {}); // run until signalled
    }
    case "search": {
      const query = rest.filter((a) => !a.startsWith("--")).join(" ");
      const proxy = new Proxy(config, { log: defaultLog });
      try {
        const tools = await proxy.catalog.tools();
        const listed = proxy.workingSet.names();
        if (query.trim() === "") {
          console.log(proxy.renderCatalog(tools, listed));
          return 0;
        }
        const reply = proxy.search(tools, listed, query);
        const compact = JSON.stringify(reply);
        console.log(rest.includes("--raw") ? compact : JSON.stringify(reply, null, 2));
        console.error(`${reply.matches.length} of ${reply.total} matches, reply ${Buffer.byteLength(compact)} bytes`);
        return reply.matches.length ? 0 : 1;
      } finally {
        await proxy.upstream.close();
      }
    }
    case "promote":
    case "report": {
      // Imported lazily so the server and its tests do not depend on the promoter.
      const mod = await import("./promote/index.ts");
      const fn = command === "promote" ? mod.promoteMain : mod.reportMain;
      return fn(rest, config as unknown as Parameters<typeof fn>[1], catalogFetcher(config));
    }
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`mws: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}

export { main };
