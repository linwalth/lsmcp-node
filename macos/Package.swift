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
