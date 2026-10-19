import { existsSync, readFileSync } from "node:fs";
import { expandHome } from "./util.ts";

const PIN_RE = /^(?:working-set-pins|toolbox-pins):\s*\[(.*)\]\s*$/;
const META = new Set(["search_tools", "call_tool"]);

/** Names in a `working-set-pins: [a, b]` (or legacy `toolbox-pins:`) line of the leading --- block. */
export function readFrontmatterPins(path: string): string[] {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  if (!lines.length || lines[0]!.trim() !== "---") return [];
  for (const ln of lines.slice(1)) {
    if (ln.trim() === "---") break;
    const m = PIN_RE.exec(ln);
    if (m) {
      return m[1]!
        .split(",")
        .map((x) => x.trim().replace(/^['"]|['"]$/g, "").trim())
        .filter(Boolean);
    }
  }
  return [];
}

/** Expand one (possibly ~-prefixed, possibly globbed) pattern to existing files. */
export function expandGlob(pattern: string): string[] {
  const p = expandHome(pattern);
  const segs = p.split("/");
  const i = segs.findIndex((s) => /[*?[{]/.test(s));
  if (i < 0) return existsSync(p) ? [p] : [];
  const base = segs.slice(0, i).join("/") || "/";
  if (!existsSync(base)) return [];
  const rest = segs.slice(i).join("/");
  return [...new Bun.Glob(rest).scanSync({ cwd: base, absolute: true, onlyFiles: true })].sort();
}

/** {tool: [files]} from frontmatter pins in files matched by the globs. */
export function derivePins(globs: string[]): Record<string, string[]> {
  const pins: Record<string, string[]> = {};
  for (const g of globs) {
    for (const f of expandGlob(g)) {
      for (const n of readFrontmatterPins(f)) {
        if (META.has(n)) continue;
        (pins[n] ??= []).push(f);
      }
    }
  }
  return pins;
}
