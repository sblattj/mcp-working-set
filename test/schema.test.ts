import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstParagraph, slimTool } from "../src/schema.ts";

const tool = (inputSchema: unknown, name = "demo_tool", extra: object = {}) => ({ name, description: "d", inputSchema, ...extra }) as any;
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "catalog.json"), "utf8")) as any[];

test("drops $schema, redundant titles, default:null; keeps real titles and defaults", () => {
  const s = slimTool(
    tool({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Demo Tool",
      type: "object",
      properties: {
        user_email: { type: "string", title: "User Email", default: null, description: "who" },
        mode: { type: "string", title: "Pick a mode", default: "a", enum: ["a", "b"] },
        title: { type: "string", title: "Title" }, // a property literally named title
      },
      required: ["mode"],
    }),
  ).inputSchema as any;
  expect(s.$schema).toBeUndefined();
  expect(s.title).toBeUndefined();
  expect(s.properties.user_email).toEqual({ type: "string", description: "who" });
  expect(s.properties.mode).toEqual({ type: "string", title: "Pick a mode", default: "a", enum: ["a", "b"] });
  expect(s.properties.title).toEqual({ type: "string" });
  expect(s.required).toEqual(["mode"]);
});

test("anyOf [X, null] collapses; conflicts and multi-way unions are left alone", () => {
  const s = slimTool(
    tool({
      type: "object",
      properties: {
        a: { anyOf: [{ type: "string" }, { type: "null" }], default: null, description: "A" },
        b: { anyOf: [{ type: "string", description: "x" }, { type: "null" }], description: "B" },
        c: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      },
    }),
  ).inputSchema as any;
  expect(s.properties.a).toEqual({ type: "string", description: "A" });
  expect(s.properties.b.anyOf).toHaveLength(2);
  expect(s.properties.c.anyOf).toHaveLength(3);
});

test("the fixture exercises every slimming rule", () => {
  const text = JSON.stringify(fixture);
  for (const marker of ['"$schema"', '"title"', '"default":null', '{"type":"null"}']) expect(text).toContain(marker);
});

test("idempotent, never loses required/properties/enum/type/description, and shrinks (fixture, every tool)", () => {
  const collect = (n: unknown, out: Record<string, number> = {}) => {
    if (Array.isArray(n)) n.forEach((x) => collect(x, out));
    else if (n && typeof n === "object") {
      for (const [k, v] of Object.entries(n)) {
        if (k === "enum" || k === "required") out[k] = (out[k] ?? 0) + 1;
        if (k === "description" && typeof v === "string") out[k] = (out[k] ?? 0) + 1;
        collect(v, out);
      }
    }
    return out;
  };
  let before = 0;
  let after = 0;
  for (const t of fixture) {
    const once = slimTool(t);
    expect(slimTool(once)).toEqual(once);
    expect(once.description).toBe(t.description);
    const b = collect(t.inputSchema);
    const a = collect(once.inputSchema);
    expect(a.enum ?? 0).toBe(b.enum ?? 0);
    expect(a.required ?? 0).toBe(b.required ?? 0);
    expect(a.description ?? 0).toBe(b.description ?? 0);
    expect((once.inputSchema as any).type).toBe(t.inputSchema.type);
    expect(Object.keys((once.inputSchema as any).properties ?? {})).toEqual(Object.keys(t.inputSchema.properties ?? {}));
    expect(t.inputSchema.$schema === undefined || (once.inputSchema as any).$schema === undefined).toBe(true);
    before += JSON.stringify(t).length;
    after += JSON.stringify(once).length;
  }
  console.log(`slimming on the fixture: ${before} -> ${after} bytes`);
  expect(after).toBeLessThan(before);
});

test("does not mutate its input", () => {
  const t = fixture[0];
  const copy = JSON.parse(JSON.stringify(t));
  slimTool(t);
  expect(t).toEqual(copy);
});

test("compact descriptions keep the first paragraph only; off by default", () => {
  const t = tool({ type: "object" }, "x_y", { description: "First para\nstill first.\n\nSecond para.\n\nThird." });
  expect(slimTool(t).description).toBe(t.description);
  expect(slimTool(t, { compactDescriptions: true }).description).toBe("First para\nstill first.");
  expect(firstParagraph("one")).toBe("one");
});
