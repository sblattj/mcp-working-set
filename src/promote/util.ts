import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export const DAY_MS = 86_400_000;

export function parseTs(v: unknown, fallback: Date | null): Date | null {
  if (typeof v === "string") {
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(v);
    const t = new Date(hasZone ? v : v + "Z");
    if (!Number.isNaN(t.getTime())) return t;
  }
  return fallback;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
