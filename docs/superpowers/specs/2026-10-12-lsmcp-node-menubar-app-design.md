# lsmcp-node macOS menubar app

Date: 2026-10-12

## Goal

Ship a double-clickable macOS `.app` for `lsmcp-node` that:

- lets the user paste a Logseq API token into a small settings window and saves it
- runs the MCP server as a managed child process
- exposes start / stop / restart, status, launch-at-login, and host/port/api-url settings from a menubar icon

The app must run on machines without Node.js installed.

## Non-goals

- no notarization (local use only)
- no Windows/Linux build
- no MCP client changes (clients keep pointing at `http://127.0.0.1:8765/mcp`)

## Decisions

| Topic | Decision |
|-------|----------|
| Form factor | macOS menubar app (`LSUIElement=true`, no dock icon) |
| UI tech | native Swift / SwiftUI, SwiftPM (no Xcode project required) |
| Server runtime | embedded Node single-executable built with `bun build --compile` |
| Token storage | plaintext file `~/.config/lsmcp-node/token`, mode `0600` |
| Settings storage | `~/.config/lsmcp-node/config.json` |
| Launch at login | `SMAppService.mainApp` (macOS 13+) |
| Signing | ad-hoc `codesign --sign -` |

## Config layout

Single config directory for both the app and the CLI: `~/.config/lsmcp-node/`.

- `~/.config/lsmcp-node/token` — plaintext token, `0600`
- `~/.config/lsmcp-node/config.json` — `{ "api_url", "host", "port" }`

The CLI token cache path in `src/cli.ts` (`tokenCachePath()`) moves from
`~/.config/lsmcp/token` to `~/.config/lsmcp-node/token` so the CLI `--login` /
`--logout` flow and the app share one path. `XDG_CONFIG_HOME` still overrides
the base.

## Repo layout (new)

```
macos/
  Package.swift
  Sources/LsmcpNodeApp/main.swift            # menubar (NSStatusItem) + menu
  Sources/LsmcpNodeApp/ServerController.swift
  Sources/LsmcpNodeApp/SettingsWindow.swift
  Sources/LsmcpNodeApp/Config.swift
  Info.plist                                 # LSUIElement=true
scripts/
  build-app.sh                               # bun compile + swift build + assemble .app + codesign
```

## Architecture

The Swift app is a thin supervisor. All Logseq logic stays in the existing
Node server; the app only configures and supervises it.

- **Config** (`Config.swift`) — reads/writes `~/.config/lsmcp-node/token` and
  `config.json`; creates the dir with mode `0700` and the token file with `0600`.
- **ServerController** (`ServerController.swift`) — spawns
  `Bundle.main.resourceURL/lsmcp-node` via `Process`, passing env
  `LOGSEQ_API_TOKEN`, `LOGSEQ_API_URL`, `MCP_HOST`, `MCP_PORT`; captures
  stdout/stderr; kills the child on quit; exposes start/stop/restart and a
  running flag.
- **Menu** (`main.swift`) — status line, Start / Stop / Restart, Settings…,
  Launch at login toggle, Quit.
- **SettingsWindow** (`SettingsWindow.swift`) — token field (secure), api url,
  host, port, Test connection, Save.

## Data flow

1. App launch → `Config` loads token + config.json.
2. If token present → `ServerController.start()` spawns the embedded binary with
   the token/config as env vars. If no token → status shows "needs token", server
   not started.
3. Settings Save → writes token + config.json → `ServerController.restart()`.
4. Quit → child process terminated.

## Status detection

Base status is `process.isRunning`. On top of that, a periodic MCP ping (~10s)
does a JSON-RPC `initialize` + `tools/call` `health` against
`http://<host>:<port>/mcp`, so the menu can show `ok` / `error` rather than just
alive/dead.

## Test connection

The settings "Test connection" button POSTs to `<api_url>/api` with the bearer
token and calls `logseq.App.getCurrentGraph`, showing the graph name on success
or the error on failure.

## Build

`scripts/build-app.sh`:

1. `npm run build` → `dist/cli.js`
2. `bun build dist/cli.js --compile --outfile build/lsmcp-node`
3. `swift build -c release` (SwiftPM)
4. assemble `LsmcpNode.app`: `Contents/MacOS/LsmcpNode`,
   `Contents/Resources/lsmcp-node`, `Contents/Info.plist`
5. `codesign --force --deep --sign - LsmcpNode.app` (ad-hoc; Bun binaries may
   need an entitlements plist with JIT permissions, see Bun docs)

Run: `open LsmcpNode.app`, or once `xattr -dr com.apple.quarantine LsmcpNode.app`.

## Testing

- Server: existing stdio smoke check stays green.
- `scripts/build-app.sh` exits `0`.
- Manual checklist:
  1. launch app, no token → status asks for token
  2. paste token → Test connection shows graph name
  3. Save → server starts → status green
  4. Claude Desktop against `http://127.0.0.1:8765/mcp` → `health` returns `{"status":"ok"}`
  5. Stop → status stopped; Restart → green again
  6. Quit → child process gone (`pgrep lsmcp-node` empty)

## Sources

- Bun single-file executables: https://bun.sh/docs/bundler/executables
- `SMAppService.mainApp`: https://developer.apple.com/documentation/servicemanagement/smappservice
