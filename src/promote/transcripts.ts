import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ScanResult, TranscriptAdapter, UsageEvent } from "./types.ts";
import { parseTs } from "./util.ts";

const META = new Set(["search_tools", "call_tool"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Claude Code project transcripts: <root>/**\/*.jsonl */
export const claudeCodeAdapter: TranscriptAdapter = {
  type: "claude-code",
  async scan(root, serverName): Promise<ScanResult> {
    const events: UsageEvent[] = [];
    const prefixes: Record<string, number> = {};
    const own = `mcp__${serverName}__`;
    let files: string[] = [];
    try {
      files = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: root, absolute: true })];
    } catch {
      return { events, prefixes };
    }
    for (const f of files.sort()) {
      let text: string;
      let mtime: Date;
      try {
        mtime = (await stat(f)).mtime;
        text = await readFile(f, "utf8");
      } catch {
        continue;
      }
      const stem = basename(f).replace(/\.jsonl$/, "");
      const pending = new Map<string, number>(); // tool_use id -> index in events (this file only)
      for (const line of text.split("\n")) {
        if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
        let d: unknown;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isObj(d)) continue;
        const content = isObj(d.message) ? d.message.content : undefined;
        if (!Array.isArray(content)) continue;
        const ts = parseTs(d.timestamp, mtime)!;
        const session = typeof d.sessionId === "string" && d.sessionId ? d.sessionId : stem;
        for (const it of content) {
          if (!isObj(it)) continue;
          if (it.type === "tool_result") {
            const id = it.tool_use_id;
            if (typeof id !== "string") continue;
            const idx = pending.get(id);
            pending.delete(id);
            if (idx !== undefined && it.is_error === true) events[idx]!.ok = false;
            continue;
          }
          if (it.type !== "tool_use") continue;
          const nm = it.name;
          if (typeof nm !== "string" || !nm.startsWith("mcp__")) continue;
          const server = nm.split("__")[1] ?? "";
          prefixes[server] = (prefixes[server] ?? 0) + 1;
          if (!nm.startsWith(own)) continue;
          let tool: string | undefined = nm.slice(own.length);
          if (tool === "call_tool") {
            const name = isObj(it.input) ? it.input.name : undefined;
            tool = typeof name === "string" && name ? name : undefined;
          } else if (!tool || META.has(tool)) {
            tool = undefined;
          }
          if (!tool) continue;
          if (typeof it.id === "string" && it.id) pending.set(it.id, events.length);
          events.push({ tool, ts, session, ok: true });
        }
      }
    }
    return { events, prefixes };
  },
};

export const ADAPTERS: Record<string, TranscriptAdapter> = {
  [claudeCodeAdapter.type]: claudeCodeAdapter,
};
