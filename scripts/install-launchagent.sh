#!/bin/bash
# ============================================================
# LifeOS Auto-Start — macOS LaunchAgent
# Starts the LifeOS dev server on login
# ============================================================

set -e

LIFEOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.lifeos.server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$LIFEOS_DIR/logs"

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

echo "📦 Installing LifeOS auto-start..."
echo "   Project: $LIFEOS_DIR"
echo "   Plist:   $PLIST_PATH"
echo ""

# Unload existing if present
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>${LIFEOS_DIR}/node_modules/.bin/next</string>
        <string>dev</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${LIFEOS_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/lifeos-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/lifeos-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>NODE_ENV</key>
        <string>development</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

# Load the agent
launchctl load "$PLIST_PATH"

echo "✅ LifeOS auto-start installed!"
echo "   The server will start automatically on login."
echo ""
echo "   To check status:  launchctl list | grep lifeos"
echo "   To stop:          launchctl unload $PLIST_PATH"
echo "   To restart:       launchctl unload $PLIST_PATH && launchctl load $PLIST_PATH"
echo "   Logs at:          $LOG_DIR/"
