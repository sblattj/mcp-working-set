# mcp-working-set

An MCP proxy that sits in front of any MCP server and lists only the tools you actually use, plus two meta-tools (`search_tools`, `call_tool`) that reach everything else in one hop.

## The problem

A client that connects to an MCP server loads every tool's name, description and input schema into the model's context, every session. A gateway with a few hundred tools costs on the order of 100k tokens before the first message, and most of those tools are never called.

S-T: every tool in the list is text the model has to read at the start of each conversation, whether it uses the tool or not. 300 tools can be a whole book's chapter of text, paid for every time.

## The answer

- **Working set.** `tools/list` returns `search_tools`, `call_tool`, and the tools in `working-set.json` (promoted and pinned names) that the upstream currently lists. Nothing else.
- **Usage promotion.** `mws promote` reads client transcripts and the proxy's own call log and promotes the tools that succeed across several sessions. Tools that stop being used fall out after a grace period.
- **One-hop search.** `search_tools {query}` ranks the full upstream catalog (BM25 over names, parameter names and descriptions, with a small synonym table) and returns the best matches with their input schemas. `call_tool {name, arguments}` runs any of them.
- **Everything stays callable.** A direct `tools/call` for an unlisted tool is forwarded upstream too, so a client holding an older listing keeps working after a demotion.

S-T: instead of handing the model the whole phone book, the proxy hands it the 20 numbers you dial most, plus a way to look up the rest.

## Quick start

Requires [Bun](https://bun.sh) 1.3 or newer.

```sh
git clone <this repo> mcp-working-set && cd mcp-working-set
bun install
bun run src/cli.ts init      # writes ~/.config/mcp-working-set/config.json
# edit "upstream" in that file, then:
bun run src/cli.ts serve     # listens on http://127.0.0.1:4484/mcp
```

`bun link` puts an `mws` command on your PATH (`mws serve`, `mws search ...`). The package is not on npm yet, so `bunx mcp-working-set` does not work until it is.

Point your client at the proxy instead of the upstream server.

**Claude Code**

```sh
claude mcp add --transport http toolbox http://127.0.0.1:4484/mcp
```

Use the same name as `serverName` in the config (default `toolbox`): the promoter finds calls in Claude Code transcripts by the `mcp__<serverName>__<tool>` prefix.

**Codex** (`~/.codex/config.toml`, in Codex versions that support Streamable HTTP servers)

```toml
[mcp_servers.toolbox]
url = "http://127.0.0.1:4484/mcp"
```

**Any other client**: a Streamable HTTP MCP server at `http://127.0.0.1:4484/mcp`. Clients on the stateless 2026-07-28 protocol and older (2025) clients are both served.

Then keep the working set fresh, for example from cron or a launchd/systemd timer:

```sh
mws promote            # rewrites working-set.json; the running proxy picks it up on its next tools/list
mws promote --dry-run  # show the decision table without writing
mws report             # what is listed, its size, call and search stats (--json for machines)
mws search "share a file"   # run search_tools against the live catalog and print the reply
```

## Upstreams

The proxy talks to the upstream through the official MCP TypeScript SDK client (`@modelcontextprotocol/client`) with protocol negotiation on `auto`:

| upstream | how |
|---|---|
| Streamable HTTP, 2026-07-28 (stateless) | probed with `server/discover`; every request then carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` and the per-request `_meta` envelope (the SDK adds them) |
| Streamable HTTP, 2025 (session-based) | falls back to the `initialize` handshake and an `Mcp-Session-Id` session; an expired session is re-opened on the next `tools/list` (a `tools/call` that lands on the expired session fails once; calls are not retried because they may have side effects) |
| stdio command | spawned as a child process, same negotiation |

On the stateless protocol the proxy also names the calling client in the forwarded request (`clientInfo.name = mcp-working-set/<client>`). On the session-based protocol and stdio the upstream only sees the proxy's own name.

## Configuration

One JSON file. Path: `--config <path>`, else `$MWS_CONFIG`, else `~/.config/mcp-working-set/config.json`. A missing file means all defaults. Every field is optional.

```json
{
  "upstream": { "url": "http://127.0.0.1:4483/mcp" },
  "listen": { "host": "127.0.0.1", "port": 4484 },
  "stateDir": "~/.local/state/mcp-working-set",
  "serverName": "toolbox",
  "backendHints": { "mail": "mailbox and filters", "drive": "files and docs" },
  "pins": [],
  "pinFiles": ["~/.claude/skills/*/SKILL.md"],
  "promote": { "minSessions": 2, "minCalls": 1, "windowDays": 30, "keepDays": 60, "pinDecayDays": 90 },
  "transcripts": [{ "type": "claude-code", "root": "~/.claude/projects" }]
}
```

| field | meaning |
|---|---|
| `upstream` | `{ "url": "...", "headers": {...} }` for HTTP, or `{ "command": "npx", "args": [...], "env": {...}, "cwd": "..." }` for stdio |
| `listen` | where the proxy listens. Loopback only: the listener validates `Host` and `Origin` against localhost and refuses a non-loopback `host` |
| `stateDir` | holds `working-set.json`, `calls.jsonl` (call and search log) and `catalog.json` (last-good upstream catalog) |
| `serverName` | the name your client registered the proxy under; used in the generated server instructions and to find `mcp__<serverName>__<tool>` calls in transcripts |
| `backendHints` | short labels per backend prefix (`mail` in `mail_send_message`), shown in the server instructions and the `search_tools` description |
| `pins` | tool names that are always listed and never decay |
| `pinFiles` | globs of Markdown files whose front matter may carry `working-set-pins: [tool_a, tool_b]` (for example a skill that needs certain tools) |
| `promote` | promotion thresholds, see below |
| `transcripts` | where to read past tool calls from; the `claude-code` adapter reads `<root>/**/*.jsonl` |
| `timeouts` | `{ "listMs": 5000, "callMs": 120000, "catalogTtlMs": 30000 }` |
| `compactDescriptions` | `true` keeps only the first paragraph of each listed tool's description (default `false`) |
| `searchAliases` | extra query synonyms, e.g. `{ "ticket": ["issue"] }`, merged over the built-in table |

## How promotion works

`mws promote` collects every tool call it can see: calls in client transcripts, plus the proxy's own `calls.jsonl`. Then, per tool:

- **Sessions, not calls.** A tool is promoted when it had successful calls in at least `minSessions` distinct sessions (and at least `minCalls` successful calls) within the last `windowDays`. One long session that hammers a tool does not promote it; a tool you reach for on different days does.
- **Only successes count.** A call that returned an error (or `isError`) is ignored, so a tool the model keeps fumbling does not earn a slot.
- **Hysteresis.** Once promoted, a tool stays listed while it had at least one successful session in the last `keepDays` (longer than `windowDays`). It is demoted only after that. This stops tools from flapping in and out of the list.
- **Pins.** `pins` in the config are listed unconditionally. Front-matter pins from `pinFiles` are listed while they are used at least once every `pinDecayDays`; an unused one goes stale and drops off, so an old skill does not hold a slot forever.
- **Reality check.** Names the upstream no longer lists are dropped from the result.

The proxy re-reads `working-set.json` whenever its modification time changes, so the next `tools/list` from any client reflects a promotion without a restart.

S-T: a tool earns its place by being useful on different days, keeps it for a while after you stop using it, and loses it if you stop for long enough.

## Search

`search_tools {query}`:

- **Exact name**, with or without the backend prefix (`mail_list_labels` or `list_labels`): that tool alone, with its full upstream schema, uncapped.
- **A backend name** (`browser`): that backend's tools in upstream order. `browser click` ranks only inside that backend.
- **Anything else**: BM25F ranking. Name tokens weigh most, then parameter names, then the first 600 characters of the description. A name that covers every query word gets a bonus.
- **Reply budget.** The reply is compact JSON with full schemas for the top 3 matches only, and stays under 6 KB by trimming long descriptions, then dropping schemas (the caller can ask by exact name), then dropping the lowest entries.
- **No query**: the whole catalog grouped by backend, names only, with listed tools marked `*`.

Listed tools get lossless schema slimming (no `$schema`, no titles that only repeat the key, no `default: null`, `anyOf [X, null]` collapsed to `X` when that loses nothing). `search_tools` returns schemas exactly as the upstream sent them.

## Resilience and logs

- `tools/list` against the upstream has a 5 s budget. On failure or timeout the proxy serves the last-good catalog (in memory, else `catalog.json`, written `0600` after every successful list). With no catalog at all it lists only the two meta-tools.
- `calls.jsonl` gets one line per forwarded call, `{ts, tool, via, ok, ms, client}`, and one per search, `{ts, event: "search", bytes, results, client}`. Never arguments, results or query text.
- `client` is the client name from the request's `_meta` envelope, else the HTTP `User-Agent`.

## How it compares

| project | what the model sees | how the list is chosen |
|---|---|---|
| ToolHive optimizer | `find_tool` and `call_tool` only | no direct tools; every call goes through search |
| mcp-gateway | a static `surfaced_tools` list plus search | hand-configured |
| LiteLLM MCP | `core_tools` surfaced inside search results | hand-configured |
| this | working set plus `search_tools` and `call_tool`, all tools still callable directly | promoted from usage across sessions, with hysteresis, pins and pin decay |

## Measured on one setup

One private setup (a gateway over several backends, one user, Claude Code). Token counts are estimates (bytes / 4), not tokenizer counts.

| | before | after |
|---|---|---|
| upstream catalog | 298 tools, ~529 KB (~132k tokens est.) | |
| listed in `tools/list` | hand-pinned 27 tools, ~36 KB | working set of 20 tools, ~21 KB (~5.3k tokens est.) |
| search top-1 (60-query private gold set) | 53% | 82% |
| search top-3 | 72% | 98% |
| largest search reply | 118 KB | 6 KB |

Your numbers will differ; `mws report` prints yours.

## Development

```sh
bun install
bun test          # offline: stub upstreams (stateless HTTP, session HTTP, stdio, dead, hung)
bun run typecheck
```

`test/fixtures/catalog.json` is a synthetic 60-tool catalog (mail, calendar, drive, browser, codesearch) and `test/fixtures/search-gold.json` a 50-query gold set for it; `bun test` prints the top-1 and top-3 hit rates and fails below 70% and 90%.

## License

MIT
