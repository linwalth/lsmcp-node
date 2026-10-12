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
    setupMainMenu()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.imagePosition = .imageOnly
    statusItem.button?.image = drawGlyph(size: 18, color: .secondaryLabelColor)
    NSApp.applicationIconImage = drawGlyph(size: 128, color: .labelColor)
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

  private func setupMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu

    NSApp.mainMenu = mainMenu
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

  private func drawGlyph(size: CGFloat, color: NSColor) -> NSImage {
    let px = Int(size * 2)
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
      return NSImage(size: NSSize(width: size, height: size))
    }
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = size / 24.0
    color.setStroke()
    let circle = NSBezierPath(ovalIn: NSRect(x: 2 * s, y: 2 * s, width: 20 * s, height: 20 * s))
    circle.lineWidth = 2 * s
    circle.stroke()
    let l1 = NSBezierPath()
    l1.move(to: NSPoint(x: 7 * s, y: 14 * s))
    l1.line(to: NSPoint(x: 17 * s, y: 14 * s))
    l1.lineWidth = 2 * s
    l1.stroke()
    let l2 = NSBezierPath()
    l2.move(to: NSPoint(x: 7 * s, y: 10 * s))
    l2.line(to: NSPoint(x: 13 * s, y: 10 * s))
    l2.lineWidth = 2 * s
    l2.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let img = NSImage(size: NSSize(width: size, height: size))
    img.addRepresentation(rep)
    img.isTemplate = false
    return img
  }

  private func refreshStatus() {
    let title: String
    let color: NSColor
    switch server.state {
    case .running:
      title = "running"; color = .labelColor
    case .stopped:
      title = ConfigStore.loadToken() == nil ? "needs token" : "stopped"
      color = .secondaryLabelColor
    case .error(let msg):
      title = "error: \(msg)"; color = .systemRed
    }
    statusItem.button?.image = drawGlyph(size: 18, color: color)
    statusItem.button?.toolTip = "lsmcp-node: \(title)"
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
