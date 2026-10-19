/**
 * Lossless JSON Schema slimming for the tools the proxy LISTS (never for search_tools replies,
 * which return the upstream schema untouched).
 *
 *  - drop `$schema`
 *  - drop `title` when it only restates the property key or the tool name (ignoring case, `_`, spaces)
 *  - drop `default: null`
 *  - collapse `anyOf: [X, {type:"null"}]` to X when X is a single schema and merging the sibling
 *    keywords of the anyOf into X conflicts on no key
 *
 * Never touches `description`, `required`, `properties`, `enum`, `type`. Idempotent. Pure (returns a copy).
 * Optional: compactDescriptions keeps only the first paragraph of the tool description.
 */
import type { Tool } from "@modelcontextprotocol/server";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, "");

/** Keywords whose value is a map name -> schema. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is data, not schema: never walked. */
const OPAQUE = new Set(["enum", "const", "default", "examples", "required"]);

const isNullSchema = (v: unknown) => isObj(v) && Object.keys(v).length === 1 && v.type === "null";

function slimSchema(node: unknown, label: string | undefined): unknown {
  if (Array.isArray(node)) return node.map((n) => slimSchema(n, undefined));
  if (!isObj(node)) return node;

  let out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema") continue;
    if (OPAQUE.has(k)) out[k] = v;
    else if (SCHEMA_MAPS.has(k) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, slimSchema(sub, name)]));
    } else out[k] = slimSchema(v, undefined);
  }

  // anyOf [X, null] -> X
  const any = out.anyOf;
  if (Array.isArray(any) && any.length === 2) {
    const nullIdx = any.findIndex(isNullSchema);
    const other = nullIdx === -1 ? undefined : any[1 - nullIdx];
    if (nullIdx !== -1 && isObj(other)) {
      const { anyOf: _drop, ...siblings } = out;
      if (!Object.keys(siblings).some((k) => k in other)) out = { ...other, ...siblings };
    }
  }

  if ("default" in out && out.default === null) delete out.default;
  if (typeof out.title === "string" && label !== undefined && norm(out.title) === norm(label)) delete out.title;
  return out;
}

/** First paragraph (split on a blank line) of a description. */
export function firstParagraph(text: string): string {
  return text.trim().split(/\r?\n[ \t]*\r?\n/, 1)[0]!.trimEnd();
}

export function slimInputSchema(schema: unknown, toolName: string): unknown {
  return slimSchema(schema, toolName);
}

export function slimTool(tool: Tool, opts: { compactDescriptions?: boolean } = {}): Tool {
  const out: Json = { ...(tool as unknown as Json) };
  if (isObj(out.inputSchema)) out.inputSchema = slimSchema(out.inputSchema, tool.name);
  if (isObj(out.outputSchema)) out.outputSchema = slimSchema(out.outputSchema, tool.name);
  if (typeof out.title === "string" && norm(out.title) === norm(tool.name)) delete out.title;
  if (opts.compactDescriptions && typeof out.description === "string") out.description = firstParagraph(out.description);
  return out as unknown as Tool;
}
