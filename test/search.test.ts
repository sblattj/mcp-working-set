import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPLY_CAP_BYTES, queryTerms, rankTools, renderSearchReply, stem, tokenize } from "../src/search.ts";

const FIX = join(import.meta.dir, "fixtures");
const tools = JSON.parse(readFileSync(join(FIX, "catalog.json"), "utf8")) as { name: string; description: string; inputSchema: any }[];
const gold = JSON.parse(readFileSync(join(FIX, "search-gold.json"), "utf8")).queries as { q: string; ok: string[] }[];
const NONE = new Set<string>();
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const rows = gold.map((g) => {
  const reply = renderSearchReply(tools, NONE, g.q, 8);
  const names = reply.matches.map((m) => m.name);
  return {
    q: g.q,
    top: names.slice(0, 3),
    hit1: g.ok.includes(names[0] ?? ""),
    hit3: names.slice(0, 3).some((n) => g.ok.includes(n)),
    bytes: bytes(JSON.stringify(reply)),
  };
});
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

test("fixture and gold set are consistent", () => {
  expect(tools.length).toBeGreaterThanOrEqual(55);
  expect(gold.length).toBeGreaterThanOrEqual(40);
  const names = new Set(tools.map((t) => t.name));
  for (const g of gold) for (const ok of g.ok) expect(names.has(ok)).toBe(true);
});

test("gold hit rate: top-3 >= 90%, top-1 >= 70%", () => {
  const top1 = rows.filter((r) => r.hit1).length / rows.length;
  const top3 = rows.filter((r) => r.hit3).length / rows.length;
  console.log(`search gold: ${rows.length} queries, top-1 ${pct(top1)}, top-3 ${pct(top3)}`);
  for (const r of rows) if (!r.hit1) console.log(`  ${r.hit3 ? "top3-only" : "MISS     "} ${JSON.stringify(r.q)} -> ${r.top.join(", ")}`);
  expect(top3).toBeGreaterThanOrEqual(0.9);
  expect(top1).toBeGreaterThanOrEqual(0.7);
});

test(`every gold reply is <= ${REPLY_CAP_BYTES} bytes`, () => {
  const over = rows.filter((r) => r.bytes > REPLY_CAP_BYTES);
  expect(over).toEqual([]);
});

test("stemmer and tokenizer", () => {
  expect(stem("messages")).toBe("messag");
  expect(stem("message")).toBe("messag");
  expect(stem("running")).toBe("run");
  expect(tokenize("listGmailLabels for_the user")).toEqual(["list", "gmail", "label", "user"]);
});

test("aliases expand at a lower weight; config aliases merge over the defaults", () => {
  const t = queryTerms("email");
  expect(t.get("email")).toBe(1);
  expect(t.get("mail")).toBeLessThan(1);
  expect(queryTerms("ticket", { ticket: ["issue"] }).get("issu")).toBeLessThan(1);
  expect(queryTerms("ticket").has("issu")).toBe(false);
});

test("reply shape: compact, schemas only on the top 3, listed flag and next hint kept", () => {
  const reply = renderSearchReply(tools, new Set(["mail_list_labels"]), "list labels", 8);
  const text = JSON.stringify(reply);
  expect(text).not.toContain("\n");
  expect(reply.matches.length).toBeGreaterThan(3);
  reply.matches.slice(3).forEach((m) => {
    expect(m.inputSchema).toBeUndefined();
    expect(m.description.length).toBeLessThanOrEqual(160);
  });
  const i = reply.matches.findIndex((m) => m.name === "mail_list_labels");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(i).toBeLessThan(3);
  expect(reply.matches[i]!.listed).toBe(true);
  expect(reply.matches[i]!.inputSchema).toBeDefined();
  expect(reply.matches.filter((m) => m.listed).length).toBe(1);
  expect(reply.next).toContain("call_tool");
});

test("a query that ranks the oversize schema sheds it to stay under the cap", () => {
  const big = tools.find((t) => t.name === "codesearch_hotspot_report")!;
  expect(bytes(JSON.stringify(big.inputSchema))).toBeGreaterThan(REPLY_CAP_BYTES);
  const reply = renderSearchReply(tools, NONE, "hotspot complexity churn report", 20);
  expect(reply.matches[0]!.name).toBe("codesearch_hotspot_report");
  expect(bytes(JSON.stringify(reply))).toBeLessThanOrEqual(REPLY_CAP_BYTES);
  expect(reply.matches[0]!.inputSchema).toBeUndefined();
  expect(reply.next).toContain("exact name");
});

test("a tiny cap drops entries bottom-up but keeps the best one", () => {
  const reply = renderSearchReply(tools, NONE, "calendar event", 20, { capBytes: 400 });
  expect(reply.matches.length).toBe(1);
  expect(reply.total).toBeGreaterThan(1);
});

test("exact name, with or without backend prefix, returns only that tool with its full schema (uncapped)", () => {
  for (const q of ["mail_list_labels", "list_labels", "MAIL_LIST_LABELS"]) {
    const reply = renderSearchReply(tools, NONE, q, 8);
    expect(reply.matches.map((m) => m.name)).toEqual(["mail_list_labels"]);
    expect(reply.matches[0]!.inputSchema).toBeDefined();
  }
  const big = renderSearchReply(tools, NONE, "codesearch_hotspot_report", 8);
  expect(big.matches[0]!.inputSchema).toEqual(tools.find((t) => t.name === "codesearch_hotspot_report")!.inputSchema);
  expect(bytes(JSON.stringify(big))).toBeGreaterThan(REPLY_CAP_BYTES);
});

test("backend name returns that backend's tools in upstream order; '<backend> words' ranks inside it", () => {
  const names = rankTools(tools, "browser").tools.map((t) => t.name);
  expect(names).toEqual(tools.filter((t) => t.name.startsWith("browser_")).map((t) => t.name));
  const scoped = rankTools(tools, "drive share").tools.map((t) => t.name);
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped.every((n) => n.startsWith("drive_"))).toBe(true);
  expect(scoped[0]).toBe("drive_share_file");
});

test("no match says so", () => {
  const reply = renderSearchReply(tools, NONE, "zzqx quuxwidget", 8);
  expect(reply.matches).toEqual([]);
  expect(reply.next).toContain("No match");
});
