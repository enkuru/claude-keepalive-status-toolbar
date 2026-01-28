#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.enes.claude-keepalive.plist"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found on PATH. Please install Node.js 18+."
  exit 1
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.enes.claude-keepalive</string>
    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${REPO_ROOT}/scripts/active-session-keeper.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-keepalive.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-keepalive.err</string>
  </dict>
</plist>
PLIST

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
launchctl start com.enes.claude-keepalive

echo "Installed keepalive LaunchAgent: $PLIST"
