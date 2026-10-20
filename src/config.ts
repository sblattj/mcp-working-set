/**
 * Configuration: one JSON file, every field optional.
 *
 * Path: the explicit argument, else $MWS_CONFIG, else ~/.config/mcp-working-set/config.json.
 * A missing file means "all defaults" (upstream http://127.0.0.1:4483/mcp, listener 127.0.0.1:4484).
 * Paths in stateDir, pinFiles and transcripts[].root may start with `~/`; they come back expanded.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type UpstreamConfig =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

export interface PromoteConfig {
  /** A tool needs ok calls in at least this many distinct sessions to be promoted. */
  minSessions: number;
  /** ...and at least this many ok calls in total. */
  minCalls: number;
  /** Look-back window for promotion, in days. */
  windowDays: number;
  /** A promoted tool stays listed while it had any ok call in this many days (hysteresis). */
  keepDays: number;
  /** A frontmatter pin with no ok call in this many days stops counting. */
  pinDecayDays: number;
}

export interface TranscriptSource {
  type: string;
  root: string;
}

export interface Config {
  upstream: UpstreamConfig;
  listen: { host: string; port: number };
  stateDir: string;
  serverName: string;
  /** Other MCP server names whose transcript calls count as usage: server key -> backend prefix. */
  serverAliases: Record<string, string>;
  backendHints: Record<string, string>;
  pins: string[];
  pinFiles: string[];
  promote: PromoteConfig;
  transcripts: TranscriptSource[];
  /** Timeouts in ms. tools/list has a last-good fallback, so its budget is short. */
  timeouts: { listMs: number; callMs: number; catalogTtlMs: number };
  /** Listed tools keep only the first paragraph of their description. */
  compactDescriptions: boolean;
  /** Extra query-side search synonyms, merged over the built-in table: word -> catalog words. */
  searchAliases: Record<string, string[]>;
  /** Where the config was read from (undefined when no file existed). */
  source?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mcp-working-set", "config.json");

export function defaultConfig(): Config {
  return {
    upstream: { url: "http://127.0.0.1:4483/mcp" },
    listen: { host: "127.0.0.1", port: 4484 },
    stateDir: expandHome("~/.local/state/mcp-working-set"),
    serverName: "toolbox",
    serverAliases: {},
    backendHints: {},
    pins: [],
    pinFiles: [expandHome("~/.claude/skills/*/SKILL.md")],
    promote: { minSessions: 2, minCalls: 1, windowDays: 30, keepDays: 60, pinDecayDays: 90 },
    transcripts: [{ type: "claude-code", root: expandHome("~/.claude/projects") }],
    timeouts: { listMs: 5_000, callMs: 120_000, catalogTtlMs: 30_000 },
    compactDescriptions: false,
    searchAliases: {},
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Merge a parsed config object over the defaults. Unknown keys are ignored; wrong types fall back. */
export function resolveConfig(raw: unknown, source?: string): Config {
  const c = defaultConfig();
  c.source = source;
  if (!isObj(raw)) return c;

  const up = raw.upstream;
  if (isObj(up)) {
    if (typeof up.command === "string" && up.command !== "") {
      c.upstream = {
        command: up.command,
        args: strings(up.args) ?? [],
        env: stringMap(up.env) ?? {},
        ...(typeof up.cwd === "string" ? { cwd: expandHome(up.cwd) } : {}),
      };
    } else if (typeof up.url === "string" && up.url !== "") {
      c.upstream = { url: up.url, ...(stringMap(up.headers) ? { headers: stringMap(up.headers) } : {}) };
    }
  }
  if (isObj(raw.listen)) {
    if (typeof raw.listen.host === "string") c.listen.host = raw.listen.host;
    c.listen.port = num(raw.listen.port, c.listen.port);
  }
  if (typeof raw.stateDir === "string" && raw.stateDir !== "") c.stateDir = resolve(expandHome(raw.stateDir));
  if (typeof raw.serverName === "string" && raw.serverName !== "") c.serverName = raw.serverName;
  c.serverAliases = stringMap(raw.serverAliases) ?? c.serverAliases;
  c.backendHints = stringMap(raw.backendHints) ?? c.backendHints;
  c.pins = strings(raw.pins) ?? c.pins;
  const pinFiles = strings(raw.pinFiles);
  if (pinFiles) c.pinFiles = pinFiles.map(expandHome);
  if (isObj(raw.promote)) {
    const p = raw.promote;
    c.promote = {
      minSessions: num(p.minSessions, c.promote.minSessions),
      minCalls: num(p.minCalls, c.promote.minCalls),
      windowDays: num(p.windowDays, c.promote.windowDays),
      keepDays: num(p.keepDays, c.promote.keepDays),
      pinDecayDays: num(p.pinDecayDays, c.promote.pinDecayDays),
    };
  }
  if (Array.isArray(raw.transcripts)) {
    c.transcripts = raw.transcripts
      .filter(isObj)
      .filter((t) => typeof t.type === "string" && typeof t.root === "string")
      .map((t) => ({ type: t.type as string, root: expandHome(t.root as string) }));
  }
  if (isObj(raw.timeouts)) {
    c.timeouts = {
      listMs: num(raw.timeouts.listMs, c.timeouts.listMs),
      callMs: num(raw.timeouts.callMs, c.timeouts.callMs),
      catalogTtlMs: num(raw.timeouts.catalogTtlMs, c.timeouts.catalogTtlMs),
    };
  }
  if (typeof raw.compactDescriptions === "boolean") c.compactDescriptions = raw.compactDescriptions;
  if (isObj(raw.searchAliases)) {
    c.searchAliases = Object.fromEntries(
      Object.entries(raw.searchAliases)
        .map(([k, v]) => [k.toLowerCase(), strings(v) ?? []] as const)
        .filter(([, v]) => v.length > 0),
    );
  }
  return c;
}

/** Read and resolve the config. Throws only when a file exists but is not valid JSON. */
export function loadConfig(path?: string): Config {
  const file = resolve(expandHome(path ?? process.env.MWS_CONFIG ?? DEFAULT_CONFIG_PATH));
  if (!existsSync(file)) return resolveConfig(undefined);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`config ${file}: ${err instanceof Error ? err.message : err}`);
  }
  return resolveConfig(raw, file);
}

/** The files under stateDir. */
export function statePaths(config: Config) {
  return {
    workingSet: join(config.stateDir, "working-set.json"),
    calls: join(config.stateDir, "calls.jsonl"),
    catalog: join(config.stateDir, "catalog.json"),
  };
}

/** True when the upstream is a stdio command rather than an HTTP URL. */
export const isStdio = (u: UpstreamConfig): u is Extract<UpstreamConfig, { command: string }> => "command" in u;
