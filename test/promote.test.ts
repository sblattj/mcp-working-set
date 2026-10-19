import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promoteMain, reportMain, decide, toolBytes } from "../src/promote/index.ts";
import { callLogEvents, callLogStats } from "../src/promote/calllog.ts";
import { claudeCodeAdapter } from "../src/promote/transcripts.ts";
import { derivePins, readFrontmatterPins } from "../src/promote/pins.ts";
import type { Config, UsageEvent } from "../src/promote/types.ts";

const NOW = new Date();
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
let ids = 0;

function entry(name: string, daysAgo: number, o: { input?: unknown; sid?: string | null; uid?: string } = {}) {
  const e: Record<string, unknown> = {
    type: "assistant",
    timestamp: iso(daysAgo),
    message: { content: [{ type: "tool_use", id: o.uid ?? `tu${ids++}`, name, input: o.input ?? {} }] },
  };
  if (o.sid !== null) e.sessionId = o.sid ?? "s1";
  return e;
}
const result = (uid: string, isError: boolean, sid = "s1") => ({
  type: "user", timestamp: iso(0), sessionId: sid,
  message: { content: [{ type: "tool_result", tool_use_id: uid, is_error: isError, content: "x" }] },
});
const ev = (tool: string, daysAgo: number, session = "s1", ok = true): UsageEvent =>
  ({ tool, ts: new Date(NOW.getTime() - daysAgo * DAY), session, ok });
const T = (n: string) => `mcp__toolbox__${n}`;

let d: string, proj: string, state: string, pins: string, out: string, logSpy: ReturnType<typeof spyOn>;
let printed: string[];

beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "mws-promote-"));
  proj = join(d, "p", "sub");
  state = join(d, "state");
  pins = join(d, "pins");
  out = join(state, "working-set.json");
  mkdirSync(proj, { recursive: true });
  mkdirSync(pins, { recursive: true });
  printed = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.join(" ")); });
});
afterEach(() => {
  logSpy.mockRestore();
  rmSync(d, { recursive: true, force: true });
});

function write(entries: unknown[], raw: string[] = [], fname = "s.jsonl") {
  writeFileSync(join(proj, fname), [...entries.map((e) => JSON.stringify(e)), ...raw].join("\n") + "\n");
}
function skill(name: string, front: string) {
  mkdirSync(join(pins, name), { recursive: true });
  writeFileSync(join(pins, name, "SKILL.md"), front);
}
function writeCalls(rows: unknown[], raw: string[] = []) {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "calls.jsonl"), [...rows.map((r) => JSON.stringify(r)), ...raw].join("\n") + "\n");
}
function prev(promoted: string[]) {
  mkdirSync(state, { recursive: true });
  writeFileSync(out, JSON.stringify({ promoted }));
}
const cfg = (extra: Partial<Config> = {}): Config => ({
  stateDir: state,
  serverName: "toolbox",
  pinFiles: [join(pins, "*", "SKILL.md")],
  transcripts: [{ type: "claude-code", root: join(d, "p") }],
  ...extra,
});
async function run(extra: Partial<Config> = {}, argv: string[] = [], fetch?: Parameters<typeof promoteMain>[2]) {
  expect(await promoteMain(argv, cfg(extra), fetch)).toBe(0);
  return JSON.parse(readFileSync(out, "utf8")) as { promoted: string[]; pinned: string[]; notes: string; generated_at: string };
}
const scan = () => claudeCodeAdapter.scan(join(d, "p"), "toolbox");

describe("session rule", () => {
  test("burst: 6 calls in 1 session is not promoted", async () => {
    write(Array(6).fill(entry(T("mail_search"), 1, { sid: "A" })));
    expect((await run()).promoted).not.toContain("mail_search");
  });
  test("2 sessions are promoted", async () => {
    write([entry(T("mail_search"), 1, { sid: "A" }), entry(T("mail_search"), 2, { sid: "B" })]);
    expect((await run()).promoted).toContain("mail_search");
  });
  test("session falls back to the file stem", async () => {
    write([entry(T("mail_x"), 1, { sid: null })], [], "one.jsonl");
    write([entry(T("mail_x"), 1, { sid: null })], [], "two.jsonl");
    const { events } = await scan();
    expect(events.map((e) => e.session).sort()).toEqual(["one", "two"]);
    expect((await run()).promoted).toContain("mail_x");
  });
  test("window edge and sorted output", async () => {
    const n = T("browser_hover"), m = T("browser_scroll");
    write([entry(n, 1, { sid: "A" }), entry(n, 29.9, { sid: "B" }), entry(m, 1, { sid: "A" }), entry(m, 30.5, { sid: "B" })]);
    const r = await run();
    expect(r.promoted).toContain("browser_hover");
    expect(r.promoted).not.toContain("browser_scroll");
    expect(r.promoted).toEqual([...r.promoted].sort());
  });
  test("minCalls floor", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" }), entry(T("mail_a"), 1, { sid: "B" })]);
    expect((await run({ promote: { minCalls: 3 } })).promoted).not.toContain("mail_a");
    expect((await run({ promote: { minCalls: 2 } })).promoted).toContain("mail_a");
  });
  test("minSessions is configurable", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" })]);
    expect((await run({ promote: { minSessions: 1 } })).promoted).toContain("mail_a");
  });
});

describe("ok-only", () => {
  test("failed-only is not promoted; one ok session is not enough", () => {
    const a = decide([ev("mail_bad", 1, "A", false), ev("mail_bad", 1, "B", false), ev("mail_bad", 2, "C", false)], { now: NOW });
    expect(a.promoted).toEqual([]);
    const b = decide([ev("mail_mix", 1, "A", true), ev("mail_mix", 1, "B", false)], { now: NOW });
    expect(b.promoted).toEqual([]);
  });
  test("tool_result is_error pairing", async () => {
    const n = T("mail_q");
    write([
      entry(n, 1, { sid: "A", uid: "u1" }), entry(n, 1, { sid: "B", uid: "u2" }), entry(n, 1, { sid: "C", uid: "u3" }),
      result("u1", true, "A"), result("u2", false, "B"),
    ]);
    const evs = (await scan()).events.sort((a, b) => a.session.localeCompare(b.session));
    expect(evs.map((e) => [e.session, e.ok])).toEqual([["A", false], ["B", true], ["C", true]]);
  });
  test("is_error in another file does not pair", async () => {
    write([entry(T("mail_q"), 1, { sid: "A", uid: "u1" })], [], "a.jsonl");
    write([result("u1", true, "A")], [], "b.jsonl");
    expect((await scan()).events.map((e) => e.ok)).toEqual([true]);
  });
});

describe("hysteresis", () => {
  test("keep while an ok session in keepDays, demote otherwise, failed does not keep", async () => {
    prev(["mail_keep", "mail_gone", "mail_failed"]);
    write([
      entry(T("mail_keep"), 45), entry(T("mail_gone"), 70),
      entry(T("mail_failed"), 10, { uid: "f1" }), result("f1", true),
    ]);
    const r = await run();
    expect(r.promoted).toContain("mail_keep");
    expect(r.promoted).not.toContain("mail_gone");
    expect(r.promoted).not.toContain("mail_failed");
  });
  test("no prior state, no hysteresis", async () => {
    write([entry(T("mail_keep"), 45)]);
    expect((await run()).promoted).not.toContain("mail_keep");
  });
});

describe("transcript parsing", () => {
  test("call_tool counts input.name; meta-tools never count", async () => {
    write([1, 2].map((i) => entry(T("call_tool"), i, { input: { name: "docs_get", arguments: { q: 1 } }, sid: `S${i}` }))
      .concat([entry(T("search_tools"), 1)]));
    const r = await run();
    expect(r.promoted).toContain("docs_get");
    expect(r.promoted).not.toContain("call_tool");
    expect(r.promoted).not.toContain("search_tools");
  });
  test("malformed lines are skipped", async () => {
    write([entry(T("mail_index"), 1, { sid: "A" }), entry(T("mail_index"), 2, { sid: "B" })], [
      '{"truncated": "tool_use', 'not json "tool_use"', '[1,2,"tool_use"]',
      JSON.stringify({ message: { content: "tool_use" } }), '{"tool_result" broken',
    ]);
    expect((await run()).promoted).toContain("mail_index");
  });
  test("missing timestamp falls back to file mtime", async () => {
    const a = entry(T("mail_x"), 1, { sid: "A" }), b = entry(T("mail_x"), 1, { sid: "B" });
    delete a.timestamp; delete b.timestamp;
    write([a, b]);
    expect((await run()).promoted).toContain("mail_x");
  });
  test("other servers are ignored and reported as prefixes", async () => {
    write([entry("mcp__other__mail_search", 1), entry("mcp__toolbox__calendar_list_events", 1), entry("Bash", 1)]);
    const r = await scan();
    expect(r.events.map((e) => e.tool)).toEqual(["calendar_list_events"]);
    expect(r.prefixes).toEqual({ other: 1, toolbox: 1 });
  });
  test("serverName comes from config", async () => {
    write([entry("mcp__gw__mail_a", 1, { sid: "A" }), entry("mcp__gw__mail_a", 1, { sid: "B" })]);
    expect((await run({ serverName: "gw" })).promoted).toContain("mail_a");
  });
});

describe("call log", () => {
  const day = iso(1).slice(0, 10);
  test("claude clients skipped unless included; sessions are client@day", () => {
    const rows = ["codex", "claude-code", "Claude Desktop"].map((client) => ({ ts: iso(1), tool: "mail_a", ok: true, client }));
    const lines = [...rows, { ts: iso(1), tool: "mail_a", ok: true, client: "codex" }];
    const evs = callLogEvents(lines, false);
    expect(evs.length).toBe(2);
    expect(new Set(evs.map((e) => e.session))).toEqual(new Set([`codex@${day}`]));
    expect(callLogEvents(lines, true).length).toBe(4);
  });
  test("ok field and UTC days give sessions", async () => {
    writeCalls([
      { ts: iso(1), tool: "mail_a", client: "codex", ok: true }, { ts: iso(2), tool: "mail_a", client: "codex", ok: true },
      { ts: iso(1), tool: "mail_f", client: "codex", ok: false }, { ts: iso(2), tool: "mail_f", client: "codex", ok: false },
    ], ["garbage"]);
    const r = await run();
    expect(r.promoted).toContain("mail_a");
    expect(r.promoted).not.toContain("mail_f");
  });
  test("claude burst is not double counted via the log", async () => {
    const n = "mail_search";
    write(Array(6).fill(entry(T(n), 0.01, { sid: "A" })));
    writeCalls(Array(6).fill({ ts: iso(0.01), tool: n, client: "claude-code", ok: true }));
    expect((await run()).promoted).not.toContain(n);
  });
  test("--include-claude-log counts claude log lines", async () => {
    writeCalls([1, 2].map((i) => ({ ts: iso(i), tool: "mail_a", client: "claude-code", ok: true })));
    expect((await run()).promoted).not.toContain("mail_a");
    expect((await run({}, ["--include-claude-log"])).promoted).toContain("mail_a");
  });
  test("search event lines are ignored for promotion and used for stats", () => {
    const lines = [
      { ts: iso(1), event: "search", bytes: 900, results: 3, client: "codex" },
      { ts: iso(1), event: "search", bytes: 100, results: 1, client: "codex" },
      { ts: iso(1), tool: "mail_a", via: "direct", ok: true, client: "codex" },
      { ts: iso(1), tool: "mail_b", via: "call_tool", ok: false, client: "codex" },
      { ts: iso(1), tool: 7, client: "codex" },
    ];
    expect(callLogEvents(lines, true).map((e) => e.tool).sort()).toEqual(["mail_a", "mail_b"]);
    const st = callLogStats(lines, NOW, 30);
    expect(st.calls_by_via).toEqual({ direct: 1, call_tool: 1 });
    expect(st.hit_rate_direct).toBe(0.5);
    expect(st.failed_calls).toBe(1);
    expect(st.search_events).toEqual({ count: 2, median_bytes: 500, max_bytes: 900 });
  });
});

describe("pins", () => {
  test("frontmatter pins, both keys; body and unfenced mentions do not pin", async () => {
    skill("a", '---\nname: a\nworking-set-pins: [calendar_list_events, "mail_q", \'docs_get\']\n---\n# body\nworking-set-pins: [mail_body_only]\nmcp__toolbox__mail_prose\n');
    skill("b", "# no frontmatter\nworking-set-pins: [mail_nofront]\n");
    skill("c", "---\ntoolbox-pins: [legacy_tool, search_tools]\n---\n");
    expect(Object.keys(derivePins([join(pins, "*", "SKILL.md")])).sort())
      .toEqual(["calendar_list_events", "docs_get", "legacy_tool", "mail_q"]);
    write([entry(T("mail_q"), 3), entry(T("legacy_tool"), 3)]);
    const r = await run();
    expect(r.pinned).toContain("mail_q");
    expect(r.pinned).toContain("legacy_tool");
    expect(r.promoted).not.toContain("mail_q");
    expect(r.pinned).not.toContain("mail_prose");
    expect(r.pinned).not.toContain("mail_body_only");
  });
  test("readFrontmatterPins on a missing file is empty", () => {
    expect(readFrontmatterPins(join(d, "nope.md"))).toEqual([]);
  });
  test("frontmatter pins decay to pin-stale after pinDecayDays", async () => {
    skill("a", "---\nworking-set-pins: [mail_old, mail_fresh, mail_never]\n---\n");
    write([entry(T("mail_old"), 95), entry(T("mail_fresh"), 80)]);
    const r = await run();
    expect(r.pinned).toContain("mail_fresh");
    expect(r.pinned).not.toContain("mail_old");
    expect(r.pinned).not.toContain("mail_never");
    expect(r.promoted).not.toContain("mail_old");
    const dec = decide([], { pins: ["mail_never"], now: NOW });
    expect(dec.rows.map((x) => [x.tool, x.status])).toEqual([["mail_never", "pin-stale"]]);
  });
  test("config pins never decay and are never also promoted", async () => {
    prev(["browser_click"]);
    write(Array(5).fill(entry(T("browser_click"), 1)));
    const r = await run({ pins: ["browser_click", "mail_unused"] });
    expect(r.pinned).toEqual(["browser_click", "mail_unused"]);
    expect(r.promoted).not.toContain("browser_click");
    expect(r.pinned.filter((x) => r.promoted.includes(x))).toEqual([]);
  });
});

describe("catalog validation", () => {
  test("unknown names are dropped and reported", () => {
    const dec = decide([ev("mail_ok", 0, "A"), ev("mail_ok", 0, "B"), ev("mail_bad", 0, "A"), ev("mail_bad", 0, "B")], {
      pins: ["mail_badpin"], now: NOW, valid: new Set(["mail_ok"]),
    });
    expect(dec.promoted).toEqual(["mail_ok"]);
    expect(dec.pinned).toEqual([]);
    expect(dec.dropped).toEqual(["mail_bad", "mail_badpin"]);
  });
  test("promoteMain drops names missing from the fetched catalog", async () => {
    write([entry(T("mail_ok"), 1, { sid: "A" }), entry(T("mail_ok"), 2, { sid: "B" }),
      entry(T("mail_gone"), 1, { sid: "A" }), entry(T("mail_gone"), 2, { sid: "B" })]);
    const r = await run({}, [], async () => [{ name: "mail_ok" }]);
    expect(r.promoted).toEqual(["mail_ok"]);
    expect(r.notes).toContain("dropped_unknown=1");
  });
  test("a failing catalog fetch skips validation", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    write([entry(T("mail_a"), 1, { sid: "A" }), entry(T("mail_a"), 2, { sid: "B" })]);
    const r = await run({}, [], async () => { throw new Error("down"); });
    errSpy.mockRestore();
    expect(r.promoted).toEqual(["mail_a"]);
  });
  test("toolBytes only counts name, description, inputSchema", () => {
    const t = { name: "a", description: "d", inputSchema: {}, annotations: { x: 1 } } as never;
    expect(toolBytes(t)).toBe(JSON.stringify({ name: "a", description: "d", inputSchema: {} }).length);
  });
});

describe("output", () => {
  test("atomic write: valid JSON, no tmp left, overwrites previous", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" }), entry(T("mail_a"), 2, { sid: "B" })]);
    await run();
    const r = await run();
    expect(r.promoted).toEqual(["mail_a"]);
    expect(Object.keys(r).sort()).toEqual(["generated_at", "notes", "pinned", "promoted"]);
    expect(readdirSync(dirname(out)).filter((f) => f.includes("tmp"))).toEqual([]);
  });
  test("dry-run prints the table and writes nothing", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" }), entry(T("mail_a"), 1, { sid: "B" })]);
    expect(await promoteMain(["--dry-run"], cfg())).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(state)).toBe(false);
    const text = printed.join("\n");
    expect(text).toContain("tool");
    expect(text).toMatch(/mail_a\s+2\s+2\s+\S+\s+new/);
  });
  test("report is read-only and labels estimates", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" }), entry(T("mail_a"), 1, { sid: "B" })]);
    writeCalls([{ ts: iso(1), tool: "mail_a", via: "direct", ok: true, client: "codex" },
      { ts: iso(1), event: "search", bytes: 40, results: 2, client: "codex" }]);
    const catalog = async () => [{ name: "mail_a", description: "d", inputSchema: { type: "object" } }, { name: "mail_b" }];
    expect(await reportMain(["--json"], cfg(), catalog)).toBe(0);
    expect(existsSync(out)).toBe(false);
    const doc = JSON.parse(printed.join("\n"));
    expect(doc.listed.map((x: { tool: string }) => x.tool)).toContain("mail_a");
    expect(doc.estimate_note).toContain("ESTIMATE");
    expect(doc.catalog_tools).toBe(2);
    expect(doc.listed[0].tokens_est).toBe(Math.floor(doc.listed[0].bytes / 4));
    expect(doc.call_log.hit_rate_direct).toBe(1);
    expect(doc.call_log.search_events).toEqual({ count: 1, median_bytes: 40, max_bytes: 40 });
  });
  test("report text mode runs", async () => {
    write([entry(T("mail_a"), 1, { sid: "A" })]);
    expect(await reportMain([], cfg())).toBe(0);
    expect(printed.join("\n")).toContain("estimate");
  });
});
