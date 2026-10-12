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
    if token.isEmpty {
      statusLabel.stringValue = "token field is empty (\(tokenField.stringValue.count) chars raw)"
      return
    }
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
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["method": "logseq.App.getCurrentGraph", "args": []])
    URLSession.shared.dataTask(with: req) { data, _, error in
      if let error { completion(.failure(error)); return }
      guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        completion(.failure(NSError(domain: "lsmcp", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "unexpected response"])))
        return
      }
      let graph = (obj["result"] as? [String: Any]) ?? obj
      if let name = graph["name"] as? String {
        completion(.success(name))
        return
      }
      let raw = String(data: data, encoding: .utf8) ?? "?"
      completion(.success("raw: \(raw.prefix(300))"))
    }.resume()
  }
}
