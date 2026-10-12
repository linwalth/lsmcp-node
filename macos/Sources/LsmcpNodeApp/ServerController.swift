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
  private var stdinPipe: Pipe?

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
    env["LSMCP_PARENT_WATCH"] = "1"
    p.environment = env

    // Keep a stdin pipe open; when the app exits the write end closes and the
    // server sees EOF, so it never orphans and holds the port.
    let stdin = Pipe()
    p.standardInput = stdin
    stdinPipe = stdin

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
