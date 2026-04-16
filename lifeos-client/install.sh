#!/bin/bash
# Install lifeos-client as a macOS launchd login item (auto-starts on login)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.lifeos.client"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/.lifeos-client/logs"

echo "Building lifeos-client..."
cd "$SCRIPT_DIR"
npm install
npm run build

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/.lifeos-client"

# Create config if it doesn't exist
if [ ! -f "$HOME/.lifeos-client/config.json" ]; then
  echo '{"serverUrl":"http://YOUR_MAC_MINI_IP:3000"}' > "$HOME/.lifeos-client/config.json"
  echo "Created config at ~/.lifeos-client/config.json"
  echo "⚠️  Edit it with your Mac Mini's IP address before the client will work."
fi

# Write launchd plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>${SCRIPT_DIR}/dist/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

# Load (or reload) the agent
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo ""
echo "✅ lifeos-client installed and running."
echo "   Logs: $LOG_DIR"
echo "   Config: ~/.lifeos-client/config.json"
echo ""
echo "To set up the Cmd+Shift+G guidance hotkey, add this to Hammerspoon init.lua:"
echo '   hs.hotkey.bind({"cmd","shift"}, "G", function()'
echo '     hs.http.asyncPost("http://127.0.0.1:7891", '"'"'{"question":"explain this"}'"'"', {}, function() end)'
echo '   end)'
echo ""
echo "Or add a macOS Shortcut that runs:"
echo '   curl -s -X POST http://127.0.0.1:7891 -d '"'"'{"question":"explain this"}'"'"
