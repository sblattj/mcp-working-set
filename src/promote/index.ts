import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADAPTERS } from "./transcripts.ts";
import { callLogEvents, callLogStats, readCallLines } from "./calllog.ts";
import type { CallLogStats } from "./calllog.ts";
import { decide } from "./decide.ts";
import { derivePins } from "./pins.ts";
import type {
  CatalogFetcher, CatalogTool, Config, Decision, UsageEvent,
} from "./types.ts";
import { expandHome, isoDay, isoSecond } from "./util.ts";

export type { CatalogFetcher, CatalogTool, Config } from "./types.ts";
export { decide } from "./decide.ts";
export { readFrontmatterPins, derivePins } from "./pins.ts";
export { claudeCodeAdapter, ADAPTERS } from "./transcripts.ts";
export { callLogEvents, callLogStats } from "./calllog.ts";

const DEFAULTS = { minSessions: 2, minCalls: 1, windowDays: 30, keepDays: 60, pinDecayDays: 90 };

export interface Args {
  dryRun: boolean;
  includeClaudeLog: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): Args {
  return {
    dryRun: argv.includes("--dry-run"),
    includeClaudeLog: argv.includes("--include-claude-log"),
    json: argv.includes("--json"),
  };
}

/** Listing cost proxy: JSON of {name, description, inputSchema} (present keys only). */
export function toolBytes(t: CatalogTool): number {
  const o: Record<string, unknown> = { name: t.name };
  if (t.description !== undefined) o.description = t.description;
  if (t.inputSchema !== undefined) o.inputSchema = t.inputSchema;
  return new TextEncoder().encode(JSON.stringify(o)).length;
}

interface Computed {
  now: Date;
  stateDir: string;
  workingSetPath: string;
  settings: typeof DEFAULTS;
  events: UsageEvent[];
  transcriptCalls: number;
  callLogCalls: number;
  failedCalls: number;
  prefixes: Record<string, number>;
  pinSources: Record<string, string[]>;
  previous: string[];
  oldListed: string[];
  catalog: Map<string, CatalogTool> | null;
  decision: Decision;
  stale: string[];
  listed: string[];
  notes: string;
  lines: Record<string, unknown>[];
}

async function compute(config: Config, args: Args, fetchCatalog?: CatalogFetcher): Promise<Computed> {
  const now = new Date();
  const s = { ...DEFAULTS, ...(config.promote ?? {}) };
  const stateDir = expandHome(config.stateDir ?? "~/.local/state/mcp-working-set");
  const workingSetPath = join(stateDir, "working-set.json");
  const serverName = config.serverName ?? "toolbox";
  const sources = config.transcripts ?? [{ type: "claude-code", root: "~/.claude/projects" }];

  const events: UsageEvent[] = [];
  const prefixes: Record<string, number> = {};
  for (const src of sources) {
    const adapter = ADAPTERS[src.type];
    if (!adapter) {
      console.error(`unknown transcript adapter "${src.type}"; skipping`);
      continue;
    }
    const r = await adapter.scan(expandHome(src.root), serverName);
    events.push(...r.events);
    for (const [k, v] of Object.entries(r.prefixes)) prefixes[k] = (prefixes[k] ?? 0) + v;
  }
  const transcriptCalls = events.length;
  const lines = await readCallLines(join(stateDir, "calls.jsonl"));
  const logEvents = callLogEvents(lines, args.includeClaudeLog);
  events.push(...logEvents);
  const failedCalls = events.filter((e) => !e.ok).length;

  const pinSources = derivePins(config.pinFiles ?? ["~/.claude/skills/*/SKILL.md"]);
  const fixedPins = (config.pins ?? []).filter((n) => n !== "search_tools" && n !== "call_tool");

  let previous: string[] = [];
  let oldListed: string[] = [];
  try {
    const prev = JSON.parse(await readFile(workingSetPath, "utf8"));
    previous = Array.isArray(prev.promoted) ? prev.promoted : [];
    oldListed = [...new Set([...previous, ...(Array.isArray(prev.pinned) ? prev.pinned : [])])].sort();
  } catch {
    // no previous state
  }

  let catalog: Map<string, CatalogTool> | null = null;
  if (fetchCatalog) {
    try {
      catalog = new Map((await fetchCatalog()).map((t) => [t.name, t]));
    } catch (e) {
      console.error(`catalog fetch failed (${(e as Error).message}); skipping validation`);
    }
  }
  if (catalog) oldListed = oldListed.filter((n) => catalog!.has(n));

  const decision = decide(events, {
    pins: Object.keys(pinSources), fixedPins, previous, now, ...s,
    valid: catalog ? new Set(catalog.keys()) : null,
  });
  const stale = decision.rows.filter((r) => r.status === "pin-stale").map((r) => r.tool).sort();
  const listed = [...new Set([...decision.promoted, ...decision.pinned])].sort();
  const notes =
    `promote>=${s.minSessions} ok sessions & >=${s.minCalls} ok calls/${s.windowDays}d; ` +
    `keep while >=1 ok session/${s.keepDays}d; pins decay after 0 ok sessions/${s.pinDecayDays}d ` +
    `(config pins never). transcript_calls=${transcriptCalls} call_log_calls=${logEvents.length} ` +
    `failed_calls=${failedCalls} promoted=${decision.promoted.length} pinned=${decision.pinned.length} ` +
    `pin_stale=${stale.length} dropped_unknown=${decision.dropped.length}`;
  return {
    now, stateDir, workingSetPath, settings: s, events, transcriptCalls,
    callLogCalls: logEvents.length, failedCalls, prefixes, pinSources, previous, oldListed,
    catalog, decision, stale, listed, notes, lines,
  };
}

const pad = (v: string | number, n: number) => String(v).padEnd(n);
const padL = (v: string | number, n: number) => String(v).padStart(n);

function table(rows: Decision["rows"]): string[] {
  const out = [`${pad("tool", 55)} ${padL("sess", 4)} ${padL("calls", 5)}  ${pad("last_used", 10)} status`];
  const sorted = [...rows].sort((a, b) => b.sessions - a.sessions || b.calls - a.calls || a.tool.localeCompare(b.tool));
  for (const r of sorted) {
    out.push(`${pad(r.tool, 55)} ${padL(r.sessions, 4)} ${padL(r.calls, 5)}  ${pad(r.lastUsed ? isoDay(r.lastUsed) : "-", 10)} ${r.status}`);
  }
  return out;
}

export async function promoteMain(argv: string[], config: Config, fetchCatalog?: CatalogFetcher): Promise<number> {
  const args = parseArgs(argv);
  const c = await compute(config, args, fetchCatalog);
  const { decision: d } = c;
  if (args.dryRun) {
    console.log(table(d.rows).join("\n"));
    console.log(`\nlisted (${c.listed.length}): ${JSON.stringify(c.listed)}`);
    console.log(`old listed (${c.oldListed.length}): added ${JSON.stringify(c.listed.filter((n) => !c.oldListed.includes(n)))} removed ${JSON.stringify(c.oldListed.filter((n) => !c.listed.includes(n)))}`);
    console.log(`pin-stale (not listed): ${JSON.stringify(c.stale)}`);
    console.log(`server prefixes seen: ${JSON.stringify(c.prefixes)}`);
    console.log(`dropped (not in catalog): ${c.catalog ? JSON.stringify(d.dropped) : "n/a (no catalog)"}`);
    console.log(c.notes);
    return 0;
  }
  await mkdir(c.stateDir, { recursive: true });
  const doc = { generated_at: isoSecond(c.now), promoted: d.promoted, pinned: d.pinned, notes: c.notes };
  const tmp = `${c.workingSetPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n");
  await rename(tmp, c.workingSetPath);
  console.log(`wrote ${c.workingSetPath}: ${c.notes}`);
  return 0;
}

export async function reportMain(argv: string[], config: Config, fetchCatalog?: CatalogFetcher): Promise<number> {
  const args = parseArgs(argv);
  const c = await compute(config, args, fetchCatalog);
  const cat = c.catalog;
  const cost = (names: string[]) => names.map((n) => {
    const t = cat?.get(n);
    const bytes = t ? toolBytes(t) : null;
    return { tool: n, bytes, tokens_est: bytes !== null ? Math.floor(bytes / 4) : null };
  });
  const sum = (xs: { bytes: number | null }[]) => (cat ? xs.reduce((a, x) => a + (x.bytes ?? 0), 0) : null);
  const newCost = cost(c.listed);
  const newTot = sum(newCost);
  const oldTot = sum(cost(c.oldListed));
  const tok = (b: number | null) => (b === null ? null : Math.floor(b / 4));
  const catBytes = cat ? [...cat.values()].reduce((a, t) => a + toolBytes(t), 0) : null;
  const stats: CallLogStats = callLogStats(c.lines, c.now, c.settings.windowDays);
  const doc = {
    generated_at: isoSecond(c.now),
    estimate_note: "bytes = length of JSON {name,description,inputSchema}; tokens_est = bytes/4 (ESTIMATE, not a tokenizer count)",
    listed: newCost,
    listed_total_bytes: newTot,
    listed_total_tokens_est: tok(newTot),
    old_listed: c.oldListed,
    old_listed_total_bytes: oldTot,
    old_listed_total_tokens_est: tok(oldTot),
    catalog_tools: cat ? cat.size : null,
    catalog_total_bytes: catBytes,
    catalog_total_tokens_est: tok(catBytes),
    call_log: stats,
    tools: c.decision.rows.map((r) => ({
      tool: r.tool, sessions: r.sessions, calls: r.calls,
      last_used: r.lastUsed ? isoDay(r.lastUsed) : null, status: r.status,
    })),
    pin_sources: c.pinSources,
    dropped_unknown: c.decision.dropped,
    notes: c.notes,
  };
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return 0;
  }
  console.log(`listed tools (${c.listed.length})${cat ? "" : " [no catalog: no bytes]"}`);
  for (const x of newCost) console.log(`  ${pad(x.tool, 55)} ${padL(x.bytes ?? "-", 7)} B  ~${padL(x.tokens_est ?? "-", 5)} tok (est)`);
  console.log(`listed total: ${newTot} B, ~${doc.listed_total_tokens_est} tokens (estimate, bytes/4)`);
  console.log(`old listed (${c.oldListed.length}): ${oldTot} B, ~${doc.old_listed_total_tokens_est} tokens (estimate)`);
  console.log(`  added:   ${JSON.stringify(c.listed.filter((n) => !c.oldListed.includes(n)))}`);
  console.log(`  removed: ${JSON.stringify(c.oldListed.filter((n) => !c.listed.includes(n)))}`);
  console.log(`catalog: ${doc.catalog_tools} tools, ${catBytes} B (~${doc.catalog_total_tokens_est} tokens, estimate)`);
  console.log(`call log, last ${stats.window_days}d (all clients): calls by via ${JSON.stringify(stats.calls_by_via)}, failed ${stats.failed_calls}, hit rate direct/(direct+call_tool) = ${stats.hit_rate_direct}`);
  const se = stats.search_events;
  console.log(`search events: count ${se.count}, median bytes ${se.median_bytes}, max bytes ${se.max_bytes}`);
  console.log("\n" + table(c.decision.rows).join("\n"));
  console.log("\n" + c.notes);
  return 0;
}
