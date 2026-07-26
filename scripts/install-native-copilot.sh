#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$PROJECT_DIR/macos/LifeOSCopilot"
BUILD_BIN="$PACKAGE_DIR/.build/arm64-apple-macosx/release/LifeOSCopilot"
INSTALL_DIR="$HOME/Library/Application Support/LifeOS"
INSTALL_BIN="$INSTALL_DIR/LifeOSCopilot"
CONFIG_DIR="$HOME/.config/lifeos"
ENV_FILE="$CONFIG_DIR/client.env"
WRAPPER="$INSTALL_DIR/run-copilot.sh"
LOG_DIR="$HOME/Library/Logs/LifeOSCopilot"
PLIST="$HOME/Library/LaunchAgents/com.lifeos.copilot.plist"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Create it with LIFEOS_SERVER_URL and LIFEOS_DEVICE_TOKEN, then rerun."
  exit 1
fi

if [ "$(stat -f '%Lp' "$ENV_FILE")" != "600" ]; then
  echo "$ENV_FILE must have mode 600."
  exit 1
fi

swift build --package-path "$PACKAGE_DIR" -c release

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
install -m 700 "$BUILD_BIN" "$INSTALL_BIN"

cat > "$WRAPPER" <<EOF
#!/bin/bash
set -a
source "$ENV_FILE"
set +a
exec "$INSTALL_BIN"
EOF
chmod 700 "$WRAPPER"

launchctl bootout "gui/$(id -u)/com.lifeos.copilot" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lifeos.copilot</string>
    <key>ProgramArguments</key>
    <array>
        <string>$WRAPPER</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>15</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/copilot.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/copilot-error.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "LifeOSCopilot installed and started."
echo "Status: launchctl print gui/$(id -u)/com.lifeos.copilot"
echo "Logs: $LOG_DIR"
