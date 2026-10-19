import { readFile } from "node:fs/promises";
import type { UsageEvent } from "./types.ts";
import { DAY_MS, isoDay, median, parseTs } from "./util.ts";

/** Every JSON-object line of the call log, unfiltered. */
export async function readCallLines(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d === "object" && d !== null && !Array.isArray(d)) out.push(d);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Call-log events. No session id is logged, so session = client + UTC day. Lines whose client
 * contains "claude" duplicate the transcripts and are skipped unless includeClaude.
 */
export function callLogEvents(lines: Record<string, unknown>[], includeClaude: boolean): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const d of lines) {
    if (typeof d.tool !== "string") continue; // search event lines
    const client = typeof d.client === "string" && d.client ? d.client : "unknown";
    if (!includeClaude && client.toLowerCase().includes("claude")) continue;
    const ts = parseTs(d.ts, null);
    if (!ts) continue;
    out.push({ tool: d.tool, ts, session: `${client}@${isoDay(ts)}`, ok: d.ok !== false });
  }
  return out;
}

export interface CallLogStats {
  window_days: number;
  calls_by_via: Record<string, number>;
  failed_calls: number;
  hit_rate_direct: number | null;
  search_events: { count: number; median_bytes: number | null; max_bytes: number | null };
}

export function callLogStats(lines: Record<string, unknown>[], now: Date, windowDays: number): CallLogStats {
  const win = now.getTime() - windowDays * DAY_MS;
  const via: Record<string, number> = {};
  let failed = 0;
  const search: number[] = [];
  for (const d of lines) {
    const ts = parseTs(d.ts, null);
    if (!ts || ts.getTime() < win || ts.getTime() > now.getTime()) continue;
    if (typeof d.tool === "string") {
      const v = String(d.via);
      via[v] = (via[v] ?? 0) + 1;
      if (d.ok === false) failed++;
    } else if (d.event === "search") {
      search.push(typeof d.bytes === "number" ? d.bytes : 0);
    }
  }
  const direct = via.direct ?? 0;
  const ct = via.call_tool ?? 0;
  return {
    window_days: windowDays,
    calls_by_via: via,
    failed_calls: failed,
    hit_rate_direct: direct + ct ? Math.round((direct / (direct + ct)) * 1000) / 1000 : null,
    search_events: {
      count: search.length,
      median_bytes: median(search),
      max_bytes: search.length ? Math.max(...search) : null,
    },
  };
}
