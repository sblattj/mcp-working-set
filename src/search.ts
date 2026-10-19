/**
 * search_tools ranking and reply diet. Zero dependencies.
 *
 * Ranking: BM25F (per-field length normalisation, k1 1.2, b 0.75) over three weighted fields:
 *   name tokens (backend prefix included, split on _ - and camelCase)   weight 5
 *   inputSchema parameter names                                          weight 1.5
 *   description (first DESC_CHARS characters; the rest is usually arg docs) weight 1
 * Query words expand through an alias table (built-in DEFAULT_ALIASES plus config.searchAliases)
 * at ALIAS_WEIGHT; ties keep upstream order. A tool name that covers every word the caller
 * typed gets a bonus: names are curated, descriptions are long.
 *
 * Short-circuits: an exact tool name (with or without its backend prefix) returns just that
 * tool; a bare backend name returns that backend's tools in upstream order; "<backend> words"
 * ranks only that backend's tools.
 *
 * Reply diet (renderSearchReply): compact JSON, full inputSchema only for the top 3 matches,
 * the rest get a first-sentence description, and the serialized reply is held under
 * REPLY_CAP_BYTES by shedding (top-3 descriptions trimmed, then schemas bottom-up, then
 * top-3 descriptions cut to one sentence, then entries bottom-up). An exact-name reply is
 * exempt from the cap: it is the only way a caller gets an oversize tool's schema.
 */

export interface SearchableTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export const REPLY_CAP_BYTES = 6000;
const FULL_SCHEMA_COUNT = 3;
const DESC_CHARS = 600;
const SHORT_DESC_CHARS = 160;
const K1 = 1.2;
const B = 0.75;
const ALIAS_WEIGHT = 0.8;
const NAME_COVERAGE_BONUS = 0.5;
const FIELD_WEIGHTS = { name: 5, param: 1.5, desc: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

const STOPWORDS = new Set(
  "a an the to on of for in into at by my me i we our you your and or with from what who is are be this that it do does can how".split(" "),
);

/**
 * Query-side synonyms: a word people type -> words tool catalogs tend to use. Generic on
 * purpose; add backend-specific vocabulary through config.searchAliases.
 */
export const DEFAULT_ALIASES: Record<string, string[]> = {
  email: ["mail", "message"],
  inbox: ["mail", "message"],
  invite: ["event"],
  meeting: ["event"],
  appointment: ["event"],
  schedule: ["event", "calendar"],
  spreadsheet: ["sheet"],
  sheet: ["spreadsheet"],
  doc: ["document"],
  document: ["doc"],
  todo: ["task"],
  screenshot: ["capture", "snapshot"],
  url: ["navigate", "open"],
  website: ["page", "navigate"],
  javascript: ["script", "evaluate"],
  login: ["credential", "auth"],
  password: ["credential"],
  repo: ["repository"],
  upload: ["create", "file"],
  share: ["permission", "access"],
  delete: ["remove", "trash"],
  remove: ["delete"],
  find: ["search"],
  lookup: ["search", "get"],
};

/** Light stemmer: plural, -ing, -ed, trailing e. Applied identically to queries and documents. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && /([^aeiou])\1$/.test(w)) w = w.slice(0, -1); // runn -> run
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Raw lowercase words: split camelCase, then on anything that is not a letter or digit. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Search tokens: words minus stopwords and 1-char tokens, stemmed. */
export function tokenize(text: string): string[] {
  return words(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Backend prefix of a tool name: everything before the first `_`. */
export const backendOf = (name: string) => name.split("_", 1)[0] ?? name;

interface Doc {
  tf: Record<Field, Map<string, number>>;
  len: Record<Field, number>;
}
interface Index {
  docs: Doc[];
  df: Map<string, number>;
  avg: Record<Field, number>;
  backends: Map<string, number[]>;
}

const indexCache = new WeakMap<readonly SearchableTool[], Index>();

function paramNames(schema: unknown): string {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props && typeof props === "object" ? Object.keys(props).join(" ") : "";
}

function buildIndex(tools: readonly SearchableTool[]): Index {
  const df = new Map<string, number>();
  // Average field length over the docs that HAVE the field, so a field many tools lack
  // (no parameters) is not crushed by length normalisation on the ones that carry it.
  const sums = { name: 0, param: 0, desc: 0 } as Record<Field, number>;
  const counts = { name: 0, param: 0, desc: 0 } as Record<Field, number>;
  const backends = new Map<string, number[]>();
  const docs = tools.map((t, i) => {
    const b = backendOf(t.name).toLowerCase();
    if (!backends.has(b)) backends.set(b, []);
    backends.get(b)!.push(i);
    const text: Record<Field, string> = {
      name: t.name,
      param: paramNames(t.inputSchema),
      desc: (t.description ?? "").slice(0, DESC_CHARS),
    };
    const doc: Doc = { tf: {} as Doc["tf"], len: {} as Doc["len"] };
    const seen = new Set<string>();
    for (const f of FIELDS) {
      const toks = tokenize(text[f]);
      const m = new Map<string, number>();
      for (const tok of toks) {
        m.set(tok, (m.get(tok) ?? 0) + 1);
        seen.add(tok);
      }
      doc.tf[f] = m;
      doc.len[f] = toks.length;
      sums[f] += toks.length;
      if (toks.length) counts[f]++;
    }
    for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
    return doc;
  });
  const avg = Object.fromEntries(FIELDS.map((f) => [f, Math.max(sums[f] / Math.max(counts[f], 1), 1)])) as Record<Field, number>;
  return { docs, df, avg, backends };
}

function indexOf(tools: readonly SearchableTool[]): Index {
  let idx = indexCache.get(tools);
  if (!idx) {
    idx = buildIndex(tools);
    indexCache.set(tools, idx);
  }
  return idx;
}

export interface SearchOptions {
  /** Extra aliases, merged over DEFAULT_ALIASES (a key here replaces the built-in entry). */
  aliases?: Record<string, string[]>;
  capBytes?: number;
}

/** Query terms with weights: the query's own tokens at 1, alias expansions at ALIAS_WEIGHT. */
export function queryTerms(query: string, extraAliases: Record<string, string[]> = {}): Map<string, number> {
  const aliases = { ...DEFAULT_ALIASES, ...extraAliases };
  const terms = new Map<string, number>();
  const raw = words(query).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  for (const w of raw) terms.set(stem(w), 1);
  for (const w of raw) {
    for (const alias of aliases[w] ?? []) {
      for (const tok of tokenize(alias)) if (!terms.has(tok)) terms.set(tok, ALIAS_WEIGHT);
    }
  }
  return terms;
}

export type RankMode = "exact" | "backend" | "ranked";

/** Rank tools for a query. Returns tools best-first and how the result was produced. */
export function rankTools<T extends SearchableTool>(
  tools: readonly T[],
  query: string,
  opts: SearchOptions = {},
): { mode: RankMode; tools: T[] } {
  const q = query.trim().toLowerCase();
  const exact = tools.filter((t) => {
    const n = t.name.toLowerCase();
    return n === q || n.slice(backendOf(n).length + 1) === q;
  });
  if (exact.length) return { mode: "exact", tools: exact };

  const idx = indexOf(tools);
  const backend = idx.backends.get(q);
  if (backend) return { mode: "backend", tools: backend.map((i) => tools[i]!) };

  // '<backend> words...': rank only that backend's tools against the remaining words.
  let pool: Set<number> | undefined;
  let rest = q;
  const space = q.indexOf(" ");
  if (space > 0 && idx.backends.has(q.slice(0, space))) {
    pool = new Set(idx.backends.get(q.slice(0, space))!);
    rest = q.slice(space + 1);
  }

  const terms = queryTerms(rest, opts.aliases);
  const n = tools.length;
  const scored: { i: number; score: number }[] = [];
  idx.docs.forEach((doc, i) => {
    if (pool && !pool.has(i)) return;
    let score = 0;
    let own = 0;
    let ownInName = 0;
    for (const [term, qw] of terms) {
      if (qw === 1) {
        own++;
        if (doc.tf.name.has(term)) ownInName++;
      }
      let tf = 0;
      for (const f of FIELDS) {
        const raw = doc.tf[f].get(term);
        if (!raw) continue;
        tf += (FIELD_WEIGHTS[f] * raw) / (1 - B + (B * doc.len[f]) / idx.avg[f]);
      }
      if (tf === 0) continue;
      const df = idx.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += qw * idf * ((tf * (K1 + 1)) / (tf + K1));
    }
    if (own) score *= 1 + NAME_COVERAGE_BONUS * (ownInName / own);
    if (score > 0) scored.push({ i, score });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { mode: "ranked", tools: scored.map((s) => tools[s.i]!) };
}

/** First sentence of a description, whitespace collapsed, at most `max` characters. */
export function firstSentence(text: string, max = SHORT_DESC_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  const s = m ? m[0] : flat;
  return s.length <= max ? s : s.slice(0, max - 3).trimEnd() + "...";
}

function trimTo(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 3).trimEnd() + "...";
}

export interface SearchMatch {
  name: string;
  listed: boolean;
  description: string;
  inputSchema?: unknown;
}
export interface SearchReply {
  query: string;
  total: number;
  matches: SearchMatch[];
  next: string;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Build the dieted search reply (see the header). Serialize it with plain JSON.stringify. */
export function renderSearchReply(
  tools: readonly SearchableTool[],
  listed: ReadonlySet<string>,
  query: string,
  limit: number,
  opts: SearchOptions = {},
): SearchReply {
  const capBytes = opts.capBytes ?? REPLY_CAP_BYTES;
  const { mode, tools: ranked } = rankTools(tools, query, opts);
  const shown = ranked.slice(0, limit);
  const full = mode === "exact";
  const matches: SearchMatch[] = shown.map((t, i) =>
    full || i < FULL_SCHEMA_COUNT
      ? { name: t.name, listed: listed.has(t.name), description: t.description ?? "", inputSchema: t.inputSchema }
      : { name: t.name, listed: listed.has(t.name), description: firstSentence(t.description ?? "") },
  );
  const reply: SearchReply = { query, total: ranked.length, matches, next: "" };
  const omitted: string[] = [];
  const setNext = () => {
    if (!ranked.length) reply.next = "No match. Call search_tools with no query for the full catalog.";
    else {
      reply.next = "Run one with call_tool {name, arguments}.";
      if (omitted.length || matches.some((m) => !("inputSchema" in m)))
        reply.next += " Entries without inputSchema: search_tools {query:<exact name>} returns it.";
    }
  };
  setNext();
  if (full) return reply;

  const top = Math.min(FULL_SCHEMA_COUNT, matches.length);
  const over = () => bytes(reply) > capBytes;
  // 1. trim the top descriptions (some carry kilobytes of argument docs)
  for (let i = top - 1; i >= 0 && over(); i--) matches[i]!.description = trimTo(matches[i]!.description, DESC_CHARS);
  // 2. drop schemas bottom-up
  for (let i = top - 1; i >= 0 && over(); i--) {
    if ("inputSchema" in matches[i]!) {
      delete matches[i]!.inputSchema;
      omitted.push(matches[i]!.name);
      setNext();
    }
  }
  // 3. top descriptions down to one sentence
  for (let i = top - 1; i >= 0 && over(); i--) matches[i]!.description = firstSentence(matches[i]!.description);
  // 4. drop entries bottom-up
  while (matches.length > 1 && over()) matches.pop();
  return reply;
}
