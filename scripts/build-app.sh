#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# clean up legacy artifacts from earlier build layouts
rm -rf dist-app/LsmcpNode.app
rm -f .*.bun-build

# 1. Build the Node server bundle
npm run build

# 2. Compile the embedded single-executable (bun runtime, no node needed at runtime)
mkdir -p build
bun build dist/cli.js --compile --outfile build/lsmcp-node

# 3. Build the Swift menubar app
# --build-system native: workaround for SwiftPM 6.4 + CLT-only (swiftlang/swift-package-manager#10561)
swift build -c release --build-system native --package-path macos

# 4. Assemble the .app bundle
APP="dist-app/LSMCP-node.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/.build/release/LsmcpNodeApp "$APP/Contents/MacOS/LsmcpNode"
# strip debug info so the build path (/Users/<name>/...) is not embedded
strip -S "$APP/Contents/MacOS/LsmcpNode"
cp build/lsmcp-node "$APP/Contents/Resources/lsmcp-node"
chmod +x "$APP/Contents/Resources/lsmcp-node"
cp macos/Info.plist "$APP/Contents/Info.plist"

# 5. Ad-hoc codesign (embedded bun binary keeps JIT entitlements; sign inner-out)
codesign --force --sign - --entitlements macos/entitlements.plist "$APP/Contents/Resources/lsmcp-node"
codesign --force --sign - "$APP/Contents/MacOS/LsmcpNode"
codesign --force --sign - "$APP"

# bun leaves a temp file in the repo root; remove it
rm -f .*.bun-build

echo "built $APP"
