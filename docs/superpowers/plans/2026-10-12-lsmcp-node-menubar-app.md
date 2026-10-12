# lsmcp-node macOS menubar app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a double-clickable macOS menubar `.app` that configures and supervises the existing `lsmcp-node` MCP server, storing the Logseq token at `~/.config/lsmcp-node/token`.

**Architecture:** A native AppKit menubar app (SwiftPM) is a thin supervisor. It reads/writes config, spawns an embedded Node single-executable (`bun build --compile`) as a child process with env vars, and offers a settings window plus start/stop/restart and launch-at-login. All Logseq logic stays in the existing TypeScript server.

**Tech Stack:** Swift/AppKit (SwiftPM), `bun build --compile`, `codesign`, existing esbuild/TS build.

**Spec:** [docs/superpowers/specs/2026-10-12-lsmcp-node-menubar-app-design.md](../specs/2026-10-12-lsmcp-node-menubar-app-design.md)

## Global Constraints

- Config dir: `~/.config/lsmcp-node/` (dir mode `0700`, token file mode `0600`), `XDG_CONFIG_HOME` overrides the base.
- Token file: `~/.config/lsmcp-node/token`. Settings file: `~/.config/lsmcp-node/config.json` = `{ "api_url", "host", "port" }`.
- Server env contract (unchanged): `LOGSEQ_API_TOKEN`, `LOGSEQ_API_URL` (default `http://127.0.0.1:12315`), `MCP_HOST` (default `127.0.0.1`), `MCP_PORT` (default `8765`).
- MCP endpoint: `http://<host>:<port>/mcp`. Default port `8765`.
- macOS 13+ (for `SMAppService`). No notarization; ad-hoc codesign only.
- Embedded server binary name: `lsmcp-node`, placed at `Contents/Resources/lsmcp-node`.
- App bundle name: `LsmcpNode.app`; `Info.plist` sets `LSUIElement=true`.
- No new runtime npm dependencies.

## Review Focus

- Token file written with wrong permissions or to the old `~/.config/lsmcp/` path → token leaks or app/CLI disagree. Expect mode `0600` under `~/.config/lsmcp-node/`.
- Embedded binary missing / not executable after assembly → app starts but server never comes up. Expect spawn to surface a clear error in the menu, not a silent hang.
- Child process left running after Quit or on relaunch → duplicate servers fighting for port `8765`. Expect exactly one server, gone after Quit.
- Port already in use → server exits; app must show `error`, not `running`.
- Token containing whitespace/newlines on paste → server auth fails. Expect trimmed token written.

---

### Task 1: CLI token cache path

**Files:**
- Modify: `src/cli.ts:9-12`
- Modify: `README.md` (token path mentions)

**Interfaces:**
- Produces: token cache path `~/.config/lsmcp-node/token` used by both CLI and app.

- [ ] **Step 1: Change `tokenCachePath()`**

In `src/cli.ts`, replace the body:

```ts
function tokenCachePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "lsmcp-node", "token");
}
```

- [ ] **Step 2: Update `--login` usage strings**

In `usage()` and the `--login` help text, replace `~/.config/lsmcp/token` with `~/.config/lsmcp-node/token`.

- [ ] **Step 3: Build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: exit `0`.

- [ ] **Step 4: Verify path at runtime**

Run: `printf 'abc\n' | node dist/cli.js --login; ls -l ~/.config/lsmcp-node/token`
Expected: prints `Cached token to /Users/<you>/.config/lsmcp-node/token`; `ls` shows mode `-rw-------`.

- [ ] **Step 5: Update README**

Replace `~/.config/lsmcp/token` occurrences with `~/.config/lsmcp-node/token`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts README.md
git commit -m "feat: move token cache to ~/.config/lsmcp-node"
```

---

### Task 2: SwiftPM package + menubar skeleton

**Files:**
- Create: `macos/Package.swift`
- Create: `macos/Sources/LsmcpNodeApp/main.swift`
- Create: `macos/Info.plist`

**Interfaces:**
- Produces: `LsmcpNodeApp` executable target; `AppDelegate` class; a menubar `NSStatusItem` titled `lsmcp-node`.

- [ ] **Step 1: Create `macos/Package.swift`**

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "LsmcpNodeApp",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "LsmcpNodeApp",
      path: "Sources/LsmcpNodeApp"
    )
  ]
)
```

- [ ] **Step 2: Create `macos/Sources/LsmcpNodeApp/main.swift`**

```swift
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.title = "lsmcp-node"
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    statusItem.menu = menu
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
```

- [ ] **Step 3: Create `macos/Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LsmcpNode</string>
  <key>CFBundleIdentifier</key><string>linwalth.lsmcp-node</string>
  <key>CFBundleExecutable</key><string>LsmcpNode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
```

- [ ] **Step 4: Build**

Run: `swift build -c release --package-path macos`
Expected: exit `0`, binary at `macos/.build/release/LsmcpNodeApp`.

- [ ] **Step 5: Commit**

```bash
git add macos
git commit -m "feat: scaffold macOS menubar app (SwiftPM)"
```

---

### Task 3: Config read/write

**Files:**
- Create: `macos/Sources/LsmcpNodeApp/Config.swift`

**Interfaces:**
- Produces:
  - `struct AppConfig { var apiURL: String; var host: String; var port: Int }` with `static let defaults`.
  - `enum ConfigStore` with `static var dir: URL`, `static func loadToken() -> String?`, `static func saveToken(_ token: String) throws`, `static func loadConfig() -> AppConfig`, `static func saveConfig(_ cfg: AppConfig) throws`.

- [ ] **Step 1: Create `Config.swift`**

```swift
import Foundation

struct AppConfig {
  var apiURL: String = "http://127.0.0.1:12315"
  var host: String = "127.0.0.1"
  var port: Int = 8765

  static let defaults = AppConfig()
}

enum ConfigStore {
  static var dir: URL {
    let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
      .map { URL(fileURLWithPath: $0) }
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config")
    return base.appendingPathComponent("lsmcp-node", isDirectory: true)
  }

  static var tokenURL: URL { dir.appendingPathComponent("token") }
  static var configURL: URL { dir.appendingPathComponent("config.json") }

  static func ensureDir() throws {
    try FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
  }

  static func loadToken() -> String? {
    guard let data = try? Data(contentsOf: tokenURL),
          let raw = String(data: data, encoding: .utf8) else { return nil }
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return token.isEmpty ? nil : token
  }

  static func saveToken(_ token: String) throws {
    try ensureDir()
    let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
    try Data(trimmed.utf8).write(to: tokenURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
  }

  static func loadConfig() -> AppConfig {
    guard let data = try? Data(contentsOf: configURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return .defaults }
    var cfg = AppConfig.defaults
    if let v = obj["api_url"] as? String { cfg.apiURL = v }
    if let v = obj["host"] as? String { cfg.host = v }
    if let v = obj["port"] as? Int { cfg.port = v }
    return cfg
  }

  static func saveConfig(_ cfg: AppConfig) throws {
    try ensureDir()
    let obj: [String: Any] = ["api_url": cfg.apiURL, "host": cfg.host, "port": cfg.port]
    let data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: configURL, options: [.atomic])
  }
}
```

- [ ] **Step 2: Build**

Run: `swift build -c release --package-path macos`
Expected: exit `0`.

- [ ] **Step 3: Commit**

```bash
git add macos/Sources/LsmcpNodeApp/Config.swift
git commit -m "feat: add app config store"
```

---

### Task 4: ServerController

**Files:**
- Create: `macos/Sources/LsmcpNodeApp/ServerController.swift`

**Interfaces:**
- Consumes: `AppConfig`, `ConfigStore` (Task 3).
- Produces: `final class ServerController: ObservableObject` with `enum State { case stopped, running, error(String) }`, `@Published var state`, `var onStateChange: ((State) -> Void)?`, `func start(token: String, config: AppConfig)`, `func stop()`, `func restart(token: String, config: AppConfig)`, `var isRunning: Bool`.

- [ ] **Step 1: Create `ServerController.swift`**

```swift
import Foundation

final class ServerController {
  enum State: Equatable {
    case stopped
    case running
    case error(String)
  }

  var onStateChange: ((State) -> Void)?
  private(set) var state: State = .stopped {
    didSet { if state != oldValue { onStateChange?(state) } }
  }
  private var process: Process?
  private var logHandle: FileHandle?

  var isRunning: Bool { process?.isRunning ?? false }

  private var binaryURL: URL? {
    Bundle.main.resourceURL?.appendingPathComponent("lsmcp-node")
  }

  func start(token: String, config: AppConfig) {
    stop()
    guard let binary = binaryURL, FileManager.default.isExecutableFile(atPath: binary.path) else {
      state = .error("embedded server binary not found")
      return
    }
    let p = Process()
    p.executableURL = binary
    var env = ProcessInfo.processInfo.environment
    env["LOGSEQ_API_TOKEN"] = token
    env["LOGSEQ_API_URL"] = config.apiURL
    env["MCP_HOST"] = config.host
    env["MCP_PORT"] = String(config.port)
    p.environment = env

    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if !d.isEmpty { FileHandle.standardError.write(d) }
    }
    logHandle = pipe.fileHandleForReading

    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self else { return }
        if proc.terminationStatus == 0 {
          self.state = .stopped
        } else {
          self.state = .error("server exited (\(proc.terminationStatus))")
        }
      }
    }

    do {
      try p.run()
      process = p
      state = .running
    } catch {
      state = .error("failed to start server: \(error.localizedDescription)")
    }
  }

  func stop() {
    guard let p = process, p.isRunning else { process = nil; return }
    p.terminationHandler = nil
    p.terminate()
    let deadline = Date().addingTimeInterval(3)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    process = nil
    state = .stopped
  }

  func restart(token: String, config: AppConfig) {
    start(token: token, config: config)
  }
}
```

- [ ] **Step 2: Build**

Run: `swift build -c release --package-path macos`
Expected: exit `0`.

- [ ] **Step 3: Commit**

```bash
git add macos/Sources/LsmcpNodeApp/ServerController.swift
git commit -m "feat: add server process controller"
```

---

### Task 5: Settings window

**Files:**
- Create: `macos/Sources/LsmcpNodeApp/SettingsWindow.swift`

**Interfaces:**
- Consumes: `ConfigStore`, `AppConfig` (Task 3).
- Produces: `final class SettingsWindowController` with `init(onSave: @escaping (String, AppConfig) -> Void)` and `func show()`.

- [ ] **Step 1: Create `SettingsWindow.swift`**

```swift
import AppKit

final class SettingsWindowController: NSWindowController {
  private let onSave: (String, AppConfig) -> Void
  private let tokenField = NSSecureTextField()
  private let apiField = NSTextField()
  private let hostField = NSTextField()
  private let portField = NSTextField()
  private let statusLabel = NSTextField(labelWithString: "")

  init(onSave: @escaping (String, AppConfig) -> Void) {
    self.onSave = onSave
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 260),
      styleMask: [.titled, .closable],
      backing: .buffered, defer: false
    )
    window.title = "lsmcp-node settings"
    super.init(window: window)
    buildUI()
    loadCurrent()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

  private func label(_ text: String) -> NSTextField {
    NSTextField(labelWithString: text)
  }

  private func buildUI() {
    guard let content = window?.contentView else { return }
    let grid = NSGridView(views: [
      [label("Logseq API token"), tokenField],
      [label("Logseq API URL"), apiField],
      [label("MCP host"), hostField],
      [label("MCP port"), portField],
    ])
    grid.rowSpacing = 8
    grid.columnSpacing = 12
    grid.translatesAutoresizingMaskIntoConstraints = false
    grid.column(at: 1).xPlacement = .fill

    let testButton = NSButton(title: "Test connection", target: self, action: #selector(testConnection))
    let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
    saveButton.keyEquivalent = "\r"
    let buttons = NSStackView(views: [testButton, saveButton])
    buttons.orientation = .horizontal
    buttons.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(grid)
    content.addSubview(buttons)
    content.addSubview(statusLabel)

    NSLayoutConstraint.activate([
      grid.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
      grid.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      grid.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      buttons.topAnchor.constraint(equalTo: grid.bottomAnchor, constant: 16),
      buttons.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      statusLabel.topAnchor.constraint(equalTo: buttons.bottomAnchor, constant: 12),
      statusLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      statusLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
    ])
  }

  private func loadCurrent() {
    tokenField.stringValue = ConfigStore.loadToken() ?? ""
    let cfg = ConfigStore.loadConfig()
    apiField.stringValue = cfg.apiURL
    hostField.stringValue = cfg.host
    portField.stringValue = String(cfg.port)
  }

  private func currentConfig() -> AppConfig {
    var cfg = AppConfig.defaults
    cfg.apiURL = apiField.stringValue.trimmingCharacters(in: .whitespaces)
    cfg.host = hostField.stringValue.trimmingCharacters(in: .whitespaces)
    if let p = Int(portField.stringValue.trimmingCharacters(in: .whitespaces)) { cfg.port = p }
    return cfg
  }

  func show() {
    loadCurrent()
    window?.center()
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func save() {
    let token = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let cfg = currentConfig()
    do {
      try ConfigStore.saveToken(token)
      try ConfigStore.saveConfig(cfg)
      statusLabel.stringValue = "saved"
      onSave(token, cfg)
    } catch {
      statusLabel.stringValue = "save failed: \(error.localizedDescription)"
    }
  }

  @objc private func testConnection() {
    let token = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let cfg = currentConfig()
    statusLabel.stringValue = "testing..."
    LogseqProbe.getCurrentGraph(apiURL: cfg.apiURL, token: token) { result in
      DispatchQueue.main.async {
        switch result {
        case .success(let graph): self.statusLabel.stringValue = "ok: \(graph)"
        case .failure(let err): self.statusLabel.stringValue = "error: \(err.localizedDescription)"
        }
      }
    }
  }
}

enum LogseqProbe {
  static func getCurrentGraph(apiURL: String, token: String,
                              completion: @escaping (Result<String, Error>) -> Void) {
    guard let url = URL(string: apiURL + "/api") else {
      completion(.failure(NSError(domain: "lsmcp", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "invalid api url"])))
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["method": "logseq.App.getCurrentGraph"])
    URLSession.shared.dataTask(with: req) { data, _, error in
      if let error { completion(.failure(error)); return }
      guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        completion(.failure(NSError(domain: "lsmcp", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "unexpected response"])))
        return
      }
      let name = (obj["result"] as? [String: Any])?["name"] as? String ?? "unknown graph"
      completion(.success(name))
    }.resume()
  }
}
```

- [ ] **Step 2: Build**

Run: `swift build -c release --package-path macos`
Expected: exit `0`.

- [ ] **Step 3: Commit**

```bash
git add macos/Sources/LsmcpNodeApp/SettingsWindow.swift
git commit -m "feat: add settings window with token + test connection"
```

---

### Task 6: Menu wiring

**Files:**
- Modify: `macos/Sources/LsmcpNodeApp/main.swift`

**Interfaces:**
- Consumes: `ServerController` (Task 4), `SettingsWindowController` (Task 5), `ConfigStore` (Task 3).

- [ ] **Step 1: Replace `main.swift`**

```swift
import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private let server = ServerController()
  private lazy var settings = SettingsWindowController { [weak self] token, cfg in
    guard let self else { return }
    self.server.restart(token: token, config: cfg)
    self.refreshStatus()
  }
  private var healthTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    server.onStateChange = { [weak self] _ in self?.refreshStatus() }
    refreshStatus()
    buildMenu()
    autostartIfPossible()
    healthTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    server.stop()
  }

  private func buildMenu() {
    let menu = NSMenu()
    menu.addItem(withTitle: "status", action: nil, keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Start", action: #selector(startServer), keyEquivalent: "")
    menu.addItem(withTitle: "Stop", action: #selector(stopServer), keyEquivalent: "")
    menu.addItem(withTitle: "Restart", action: #selector(restartServer), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Settings...", action: #selector(openSettings), keyEquivalent: ",")
    let launchItem = NSMenuItem(title: "Launch at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    launchItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(launchItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) {
      item.target = self
    }
    statusItem.menu = menu
  }

  private func autostartIfPossible() {
    guard let token = ConfigStore.loadToken() else { return }
    server.start(token: token, config: ConfigStore.loadConfig())
  }

  private func refreshStatus() {
    let title: String
    switch server.state {
    case .running: title = "running"
    case .stopped: title = ConfigStore.loadToken() == nil ? "needs token" : "stopped"
    case .error(let msg): title = "error: \(msg)"
    }
    statusItem.button?.title = "lsmcp-node: \(title)"
    statusItem.menu?.items.first?.title = "status: \(title)"
  }

  @objc private func startServer() {
    guard let token = ConfigStore.loadToken() else { openSettings(); return }
    server.start(token: token, config: ConfigStore.loadConfig())
  }

  @objc private func stopServer() { server.stop() }

  @objc private func restartServer() {
    guard let token = ConfigStore.loadToken() else { openSettings(); return }
    server.restart(token: token, config: ConfigStore.loadConfig())
  }

  @objc private func openSettings() { settings.show() }

  @objc private func toggleLaunchAtLogin(_ sender: NSMenuItem) {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {
      NSLog("launch at login toggle failed: \(error.localizedDescription)")
    }
    sender.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
```

- [ ] **Step 2: Build**

Run: `swift build -c release --package-path macos`
Expected: exit `0`.

- [ ] **Step 3: Commit**

```bash
git add macos/Sources/LsmcpNodeApp/main.swift
git commit -m "feat: wire menubar menu, autostart, launch-at-login"
```

---

### Task 7: Build script

**Files:**
- Create: `scripts/build-app.sh`
- Modify: `package.json` (add `build:app` script)

**Interfaces:**
- Produces: `LsmcpNode.app` at repo root `dist-app/`.

- [ ] **Step 1: Create `scripts/build-app.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Build the Node server bundle
npm run build

# 2. Compile the embedded single-executable (bun runtime, no node needed at runtime)
mkdir -p build
bun build dist/cli.js --compile --outfile build/lsmcp-node

# 3. Build the Swift menubar app
swift build -c release --package-path macos

# 4. Assemble the .app bundle
APP="dist-app/LsmcpNode.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/.build/release/LsmcpNodeApp "$APP/Contents/MacOS/LsmcpNode"
cp build/lsmcp-node "$APP/Contents/Resources/lsmcp-node"
chmod +x "$APP/Contents/Resources/lsmcp-node"
cp macos/Info.plist "$APP/Contents/Info.plist"

# 5. Ad-hoc codesign (bun binary needs JIT entitlements)
codesign --force --deep --sign - "$APP"

echo "built $APP"
```

- [ ] **Step 2: Add package.json script**

Add to `"scripts"`: `"build:app": "bash scripts/build-app.sh"`.

- [ ] **Step 3: Make executable and run**

Run: `chmod +x scripts/build-app.sh && npm run build:app`
Expected: ends with `built dist-app/LsmcpNode.app`, exit `0`.

- [ ] **Step 4: Verify bundle**

Run: `codesign -vvv dist-app/LsmcpNode.app; ls -l dist-app/LsmcpNode.app/Contents/Resources/lsmcp-node`
Expected: codesign reports valid; embedded binary is executable.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-app.sh package.json
git commit -m "build: add macOS app bundle build script"
```

---

### Task 8: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an "macOS app" section**

Document: `npm run build:app`, output path `dist-app/LsmcpNode.app`, first-run
`xattr -dr com.apple.quarantine dist-app/LsmcpNode.app`, and that the app stores
the token at `~/.config/lsmcp-node/token`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document macOS app build and usage"
```

---

### Task 9: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the manual checklist**

1. `open dist-app/LsmcpNode.app` with no token → menubar shows `needs token`.
2. Open Settings, paste a valid Logseq token, Test connection → shows `ok: <graph>`.
3. Save → menubar shows `running`.
4. Claude Desktop (or smoke check) against `http://127.0.0.1:8765/mcp` → `health` returns `{"status":"ok"}`.
5. Stop → `stopped`; Restart → `running`.
6. Toggle Launch at login → appears in System Settings > General > Login Items.
7. Quit → `pgrep -f lsmcp-node` returns nothing.

Expected: all steps pass.

- [ ] **Step 2: Note any failures**

Record failures as follow-up tasks; do not mark this task complete until the checklist passes.
