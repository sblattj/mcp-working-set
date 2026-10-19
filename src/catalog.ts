/**
 * State the proxy reads on every request:
 *  - Catalog: the upstream tools/list, cached for catalogTtlMs, fetched under a short timeout
 *    (timeouts.listMs). On failure the last-good catalog answers instead: in memory from the
 *    latest success, else from stateDir/catalog.json (written 0600 via tmp + rename on success).
 *  - WorkingSet: working-set.json ({generated_at, promoted, pinned, notes}), re-read whenever its
 *    mtime changes, so a promotion lands on the client's next tools/list without a restart.
 */
import type { Tool } from "@modelcontextprotocol/server";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Upstream } from "./upstream.ts";

export const META_TOOL_NAMES = new Set(["search_tools", "call_tool"]);

export class Catalog {
  private cached: { at: number; tools: Tool[] } | undefined;
  private inflight: Promise<Tool[]> | undefined;
  private disk: Tool[] | undefined;
  private fallbackLogged = false;

  constructor(
    private readonly upstream: Upstream,
    private readonly opts: { cachePath: string; ttlMs: number; listTimeoutMs: number },
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Persist a successful catalog: tmp + rename, mode 0600. Failure is logged, never thrown. */
  private save(tools: Tool[]): void {
    const path = this.opts.cachePath;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ saved_at: new Date().toISOString(), tools }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      this.log(`catalog cache write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private load(): Tool[] | undefined {
    try {
      const doc = JSON.parse(readFileSync(this.opts.cachePath, "utf8"));
      if (Array.isArray(doc?.tools) && doc.tools.length > 0) return doc.tools as Tool[];
    } catch {
      /* absent or unreadable: no last-good catalog */
    }
    return undefined;
  }

  /** The last-good catalog, synchronously: memory, else disk. Never touches the network. */
  lastGood(): Tool[] | undefined {
    if (this.cached) return this.cached.tools;
    return (this.disk ??= this.load());
  }

  /** The live catalog (cached for ttlMs), else the last-good one; throws only when neither exists. */
  async tools(force = false): Promise<Tool[]> {
    if (!force && this.cached && Date.now() - this.cached.at < this.opts.ttlMs) return this.cached.tools;
    this.inflight ??= (async () => {
      try {
        const tools = await this.upstream.listTools(this.opts.listTimeoutMs);
        this.cached = { at: Date.now(), tools };
        this.fallbackLogged = false;
        if (tools.length > 0) this.save(tools);
        return tools;
      } catch (err) {
        const stale = this.lastGood();
        if (!stale) throw err;
        if (!this.fallbackLogged) {
          this.fallbackLogged = true;
          this.log(`upstream tools/list failed (${err instanceof Error ? err.message : err}); serving last-good catalog (${stale.length} tools)`);
        }
        return stale;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

export class WorkingSet {
  private cache: { mtimeMs: number; names: Set<string> } | undefined;
  private missingLogged = false;

  constructor(
    readonly path: string,
    private readonly extraPins: readonly string[] = [],
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** promoted ∪ pinned from the file, plus config pins; meta-tool names never count. */
  names(): Set<string> {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      if (this.cache) return this.cache.names; // briefly absent mid-rewrite: keep the last good set
      if (!this.missingLogged) {
        this.missingLogged = true;
        this.log(`working set missing: ${this.path}; listing config pins and meta-tools only`);
      }
      return this.withPins([]);
    }
    this.missingLogged = false;
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.names;
    try {
      const doc = JSON.parse(readFileSync(this.path, "utf8"));
      const names = this.withPins([
        ...(Array.isArray(doc.promoted) ? doc.promoted : []),
        ...(Array.isArray(doc.pinned) ? doc.pinned : []),
      ]);
      this.cache = { mtimeMs, names };
      this.log(`loaded ${names.size} working-set names from ${this.path}`);
      return names;
    } catch (err) {
      this.log(`working set unreadable (${err instanceof Error ? err.message : err}); keeping the previous set`);
      return this.cache?.names ?? this.withPins([]);
    }
  }

  private withPins(names: unknown[]): Set<string> {
    return new Set(
      [...names, ...this.extraPins].filter((n): n is string => typeof n === "string" && n !== "" && !META_TOOL_NAMES.has(n)),
    );
  }
}
