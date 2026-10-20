// The promoter accepts a PARTIAL config (every field optional, defaults applied in
// promoteMain), so callers and tests can pass only what they set. src/config.ts's resolved
// `Config` is structurally assignable to this one.
export interface PromoteSettings {
  minSessions?: number;
  minCalls?: number;
  windowDays?: number;
  keepDays?: number;
  pinDecayDays?: number;
}

export interface TranscriptSource {
  type: string;
  root: string;
}

export interface Config {
  stateDir?: string;
  serverName?: string;
  serverAliases?: Record<string, string>;
  pins?: string[];
  pinFiles?: string[];
  promote?: PromoteSettings;
  transcripts?: TranscriptSource[];
  [key: string]: unknown;
}

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type CatalogFetcher = () => Promise<CatalogTool[]>;

/** One observed tool call. */
export interface UsageEvent {
  tool: string;
  ts: Date;
  session: string;
  ok: boolean;
}

export type Status = "pinned" | "pin-stale" | "promoted" | "new" | "kept" | "demoted" | "below";

export interface Row {
  tool: string;
  sessions: number;
  calls: number;
  lastUsed: Date | null;
  status: Status;
}

export interface DecideOptions {
  /** Frontmatter pins: decay to pin-stale after 0 ok sessions in pinDecayDays. */
  pins?: Iterable<string>;
  /** Config pins: never decay. */
  fixedPins?: Iterable<string>;
  previous?: Iterable<string>;
  now: Date;
  minSessions?: number;
  minCalls?: number;
  windowDays?: number;
  keepDays?: number;
  pinDecayDays?: number;
  /** Live catalog names; unknown candidates are dropped. Omit to skip validation. */
  valid?: Set<string> | null;
}

export interface Decision {
  rows: Row[];
  promoted: string[];
  pinned: string[];
  dropped: string[];
}

/** A transcript source adapter: yields usage events from some client's session logs. */
export interface TranscriptAdapter {
  readonly type: string;
  scan(root: string, serverName: string, aliases?: Record<string, string>): Promise<ScanResult>;
}

export interface ScanResult {
  events: UsageEvent[];
  /** MCP server prefixes seen in tool_use names, with counts (diagnostics). */
  prefixes: Record<string, number>;
}
