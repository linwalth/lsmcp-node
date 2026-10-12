# lsmcp-node

<p align="center"><img src="icon.svg" width="64" alt="lsmcp-node logo"></p>

Node MCP server for Logseq.

<p align="center"><img src="./demo.svg" width="720" alt="lsmcp-node architecture"></p>

## What This Is

`lsmcp-node` exposes Logseq read/write tools over MCP so clients like Claude Desktop can automate page and block workflows. It is the Node/TypeScript sibling of [lsmcp](https://github.com/linwalth/lsmcp) — same 34-tool surface and conventions, but runnable with plain `node` (no `uv`, no virtualenv). It talks to Logseq's local HTTP API, deduplicates blocks by UUID at read time, and returns lean responses by default.

## Tools

| Tool | Description |
|------|-------------|
| `health` | Ping Logseq and return graph name and page count |
| `get_page` | Return a page entity and deduplicated block tree by page name |
| `get_block` | Get a single block by UUID |
| `list_pages` | List pages with optional namespace filter (truncated by limit); `slim=true` drops properties |
| `search_pages` | Find pages by a name fragment; returns full paths for nested/namespace pages; `slim=true` drops properties |
| `list_namespace` | List every page beneath a namespace without truncation |
| `list_namespace_tree` | Browse a namespace as a hierarchical tree (parents with nested children) |
| `get_references` | Get backlinks to a page (pages that reference this page) |
| `forward_links` | List the pages that THIS page links to (outbound wikilinks) |
| `graph_stats` | Whole-graph orientation snapshot: page counts, top namespaces (call first) |
| `page_outline` | Flat truncated outline skeleton of a page (progressive disclosure, lighter than `get_page`) |
| `expand_references` | Expand the backlink neighborhood around a page by up to N BFS hops |
| `cross_reference` | Pages that link to BOTH of two pages (intersection of their backlinks) |
| `namespace_stats` | Granular stats for one namespace subtree: depth distribution, child namespaces |
| `search_blocks` | Full-text search over BLOCK CONTENTS (find lore by substance, not just page names) |
| `list_blueprints` | List page-structure templates under the `blaupausen/` namespace |
| `get_blueprint` | Fetch the headed-block layout of a blueprint so new pages match graph conventions |
| `get_conventions` | Structured JSON of all writing conventions (typography, structure, links, statblock schema) |
| `get_namespace_map` | Namespace architecture map (static purpose + live page counts) |
| `validate_page` | Lint a page against conventions: dead links, em-dashes, CJK, bullet prefixes, title redundancy |
| `orphan_report` | Report pages with zero backlinks, classified by orphan policy |
| `similar_pages` | Find near-duplicate page names via fuzzy string matching |
| `query` | Run a Datalog query against Logseq's indexed DB; inline values via `%1`,`%2` placeholders |
| `page_create` | Create a new page with optional properties and initial blocks |
| `block_append` | Append blocks to a page; accepts flat strings or nested objects with content, properties, and children |
| `block_prepend` | Prepend blocks to the top of a page (above existing content) |
| `block_update` | Update block content by UUID (readback-verified) |
| `block_delete` | Delete a block by UUID |
| `delete_page` | Delete a page by name |
| `rename_page` | Rename a page from old_name to new_name |
| `move_block` | Move a block before, after, or as a child of a target block (move-verified) |
| `journal_today` | Get or create today's journal page and return its block tree |
| `journal_append` | Append blocks to a journal page for a given date |
| `journal_range` | Return journal entries for all existing pages between start_date and end_date |

## Requirements

- [ ] Node.js 18+ is installed: `node --version`
- [ ] Logseq Desktop is running with the API enabled:
  `Settings -> Features -> Enable developer mode -> Enable API server`
- [ ] `LOGSEQ_API_TOKEN` is available from Logseq:
  `Settings -> Features -> API server -> API token`

## Install

```bash
set -euo pipefail
cd /path/to/lsmcp-node
npm install
npm run build
```

## Token

`lsmcp-node` reads the token from `LOGSEQ_API_TOKEN`. Cache it once instead of exporting every time:

```bash
node dist/cli.js --login    # prompts, writes ~/.config/lsmcp-node/token (0600)
node dist/cli.js --logout   # forget the cached token
```

Resolution order: `LOGSEQ_API_TOKEN` env → cached token file.

## Run Locally

```bash
LOGSEQ_API_TOKEN=<token> node dist/cli.js
```

First run logs `lsmcp-node listening on http://127.0.0.1:8765/mcp` and answers `health` with `{"status":"ok",...}`.

## macOS App

A native menubar app can configure and supervise the server for you (no terminal, no `node` needed at runtime). It stores the Logseq API token at `~/.config/lsmcp-node/token` and settings (api url, host, port) at `~/.config/lsmcp-node/config.json` — the same token path the CLI `--login` uses. From the menubar you can start/stop/restart the server, open settings, and toggle launch at login. The server runs on `http://127.0.0.1:8765/mcp` like the CLI.

### Build

Requirements:

- macOS 13+ (Ventura) for `SMAppService` (launch at login)
- Node.js 18+ with this repo's deps installed (`npm install`)
- [Bun](https://bun.sh) — used only at build time, to compile the embedded server binary
- Xcode Command Line Tools (`xcode-select --install`), providing `swift` and `codesign`

```bash
npm install
npm run build:app      # -> dist-app/LSMCP-node.app
```

`npm run build:app` runs [`scripts/build-app.sh`](./scripts/build-app.sh), which:

1. bundles the TypeScript server to `dist/cli.js` (esbuild)
2. compiles it to a standalone binary `build/lsmcp-node` (`bun build --compile`, bundles the Bun runtime)
3. builds the Swift menubar app (`swift build -c release`)
4. assembles `LSMCP-node.app` and ad-hoc codesigns it (with JIT entitlements for the embedded Bun binary)

### Run

```bash
open dist-app/LSMCP-node.app
```

First launch from a build may be quarantined; clear it once:

```bash
xattr -dr com.apple.quarantine dist-app/LSMCP-node.app
```

The bundle is ad-hoc signed and intended for local use. To hand it to machines
you do not control, sign it with an Apple Developer ID and notarize it, otherwise
Gatekeeper will refuse to launch it there.

Note: with Command Line Tools only (no full Xcode) and Swift 6.4, a plain
`swift build` fails with `Unknown error parsing property list`; the script passes
`--build-system native` to work around
[swiftlang/swift-package-manager#10561](https://github.com/swiftlang/swift-package-manager/issues/10561).

## Transports

The default transport is **streamable HTTP** (endpoint `/mcp` on `127.0.0.1:8765`). stdio is available for Claude Desktop and other stdio-only MCP clients.

```bash
# streamable HTTP (default) — no flags needed
LOGSEQ_API_TOKEN=<token> node dist/cli.js

# stdio (for Claude Desktop and stdio-only clients)
LOGSEQ_API_TOKEN=<token> node dist/cli.js --transport stdio
```

Options (flags override env vars):

| Flag | Env | Default | Notes |
|------|-----|---------|-------|
| `--transport` | `MCP_TRANSPORT` | `http` | `http` \| `stdio` (`http` aliases `streamable-http`; `sse` is not supported) |
| `--host` | `MCP_HOST` | `127.0.0.1` | Bind host for http transport |
| `--port` | `MCP_PORT` | `8765` | Bind port for http transport |

Additional environment variables:

| Env | Default | Notes |
|-----|---------|-------|
| `LOGSEQ_API_URL` | `http://127.0.0.1:12315` | Logseq API base URL |
| `LOGSEQ_CACHE_TTL_SECONDS` | `60` | Read-response cache TTL (0 disables) |
| `LOGSEQ_API_TIMEOUT` | `30` | API request timeout in seconds |

HTTP binds to loopback by default. If you expose it on `0.0.0.0`, put it behind an authenticated reverse proxy — the server does not enforce its own bearer token.

## MCP Client Config

Claude Desktop example (stdio transport):

```json
{
  "mcpServers": {
    "lsmcp-node": {
      "command": "node",
      "args": ["/path/to/lsmcp-node/dist/cli.js", "--transport", "stdio"],
      "cwd": "/path/to/lsmcp-node",
      "env": {
        "LOGSEQ_API_URL": "http://127.0.0.1:12315",
        "LOGSEQ_API_TOKEN": "<token>"
      }
    }
  }
}
```

Replace `/path/to/lsmcp-node` with the absolute path to your cloned repo. HTTP clients (Cursor, VS Code MCP) point at `http://127.0.0.1:8765/mcp` instead.

## Smoke Check

With Logseq running and the API enabled:

```bash
export LOGSEQ_API_TOKEN=<token>
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' \
             '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health","arguments":{}}}' \
  | node dist/cli.js --transport stdio
```

Expected: two JSON-RPC responses on stdout — an `initialize` result and a `health` result containing `"status":"ok"`.

## License

[MIT](./LICENSE)
