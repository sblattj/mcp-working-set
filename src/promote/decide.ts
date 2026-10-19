import type { Decision, DecideOptions, Row, Status, UsageEvent } from "./types.ts";
import { DAY_MS } from "./util.ts";

/** Pure decision logic over ok/failed usage events. Only ok events count. */
export function decide(events: UsageEvent[], o: DecideOptions): Decision {
  const minSessions = o.minSessions ?? 2;
  const minCalls = o.minCalls ?? 1;
  const now = o.now.getTime();
  const win = now - (o.windowDays ?? 30) * DAY_MS;
  const keep = now - (o.keepDays ?? 60) * DAY_MS;
  const pdec = now - (o.pinDecayDays ?? 90) * DAY_MS;

  const calls = new Map<string, number>();
  const sessWin = new Map<string, Set<string>>();
  const sessKeep = new Map<string, Set<string>>();
  const sessPin = new Map<string, Set<string>>();
  const last = new Map<string, Date>();
  const add = (m: Map<string, Set<string>>, k: string, s: string) => {
    let set = m.get(k);
    if (!set) m.set(k, (set = new Set()));
    set.add(s);
  };

  for (const e of events) {
    const t = e.ts.getTime();
    if (t > now || !e.ok) continue;
    if (t >= win) {
      calls.set(e.tool, (calls.get(e.tool) ?? 0) + 1);
      add(sessWin, e.tool, e.session);
    }
    if (t >= keep) add(sessKeep, e.tool, e.session);
    if (t >= pdec) add(sessPin, e.tool, e.session);
    const l = last.get(e.tool);
    if (!l || e.ts > l) last.set(e.tool, e.ts);
  }

  const fixed = new Set(o.fixedPins ?? []);
  const pins = new Set(o.pins ?? []);
  const prev = new Set(o.previous ?? []);
  const candidates = new Set<string>([
    ...calls.keys(), ...sessKeep.keys(), ...prev, ...pins, ...fixed,
  ]);
  const dropped = new Set<string>();
  if (o.valid) {
    for (const c of candidates) {
      if (!o.valid.has(c)) {
        dropped.add(c);
        candidates.delete(c);
      }
    }
  }

  const rows: Row[] = [];
  const promoted: string[] = [];
  const pinned: string[] = [];
  for (const g of [...candidates].sort()) {
    const ns = sessWin.get(g)?.size ?? 0;
    const nc = calls.get(g) ?? 0;
    let status: Status;
    if (fixed.has(g) || (pins.has(g) && (sessPin.get(g)?.size ?? 0) > 0)) {
      status = "pinned";
      pinned.push(g);
    } else if (pins.has(g)) {
      status = "pin-stale";
    } else if (ns >= minSessions && nc >= minCalls) {
      status = prev.has(g) ? "promoted" : "new";
      promoted.push(g);
    } else if (prev.has(g) && (sessKeep.get(g)?.size ?? 0) > 0) {
      status = "kept";
      promoted.push(g);
    } else if (prev.has(g)) {
      status = "demoted";
    } else if (nc) {
      status = "below";
    } else {
      continue;
    }
    rows.push({ tool: g, sessions: ns, calls: nc, lastUsed: last.get(g) ?? null, status });
  }
  return {
    rows,
    promoted: promoted.sort(),
    pinned: pinned.sort(),
    dropped: [...dropped].sort(),
  };
}
