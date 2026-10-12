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
