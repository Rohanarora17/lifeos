#!/bin/bash
# ============================================================
# LifeOS Mac Mini Setup — installs both launchd services:
#   com.lifeos.server  — Next.js production server (port 3000)
#   com.lifeos.daemon  — lifeosd.mjs (guardian ping + Telegram)
#
# Usage: bash scripts/setup-macos.sh
# Re-run anytime to update. Safe to run multiple times.
# ============================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$PROJECT_DIR/scripts"
LOG_DIR="$PROJECT_DIR/logs"
AGENTS_DIR="$HOME/Library/LaunchAgents"
ENV_FILE="$PROJECT_DIR/.env.local"

# ── Detect node binary ────────────────────────────────────────────────────────

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  # Common Homebrew paths for Apple Silicon and Intel
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "❌  node not found. Install via: brew install node"
  exit 1
fi

NPM_BIN="$(command -v npm 2>/dev/null || dirname "$NODE_BIN")/npm"
NEXT_BIN="$PROJECT_DIR/node_modules/.bin/next"

echo ""
echo "🛡️  LifeOS Mac Mini Setup"
echo "   Project : $PROJECT_DIR"
echo "   Node    : $NODE_BIN  ($(node --version))"
echo "   Logs    : $LOG_DIR"
echo ""

mkdir -p "$LOG_DIR" "$AGENTS_DIR"

# ── Warn if not built ─────────────────────────────────────────────────────────

if [ ! -d "$PROJECT_DIR/.next" ]; then
  echo "⚠️  No production build found. Run: npm run build"
  echo "   (The server plist will still be installed but won't start until built.)"
  echo ""
fi

# ── Warn if .env.local missing ────────────────────────────────────────────────

if [ ! -f "$ENV_FILE" ]; then
  echo "⚠️  .env.local not found — services will start without API keys."
  echo "   Create $ENV_FILE with at minimum: GEMINI_API_KEY=..."
  echo ""
fi

# ── Wrapper scripts (source .env.local before exec) ───────────────────────────

cat > "$SCRIPTS_DIR/lifeos-server.sh" << WRAPPER
#!/bin/bash
cd "$PROJECT_DIR"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
exec "$NODE_BIN" "$NEXT_BIN" start
WRAPPER
chmod +x "$SCRIPTS_DIR/lifeos-server.sh"

cat > "$SCRIPTS_DIR/lifeos-daemon.sh" << WRAPPER
#!/bin/bash
cd "$PROJECT_DIR"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
exec "$NODE_BIN" "$SCRIPTS_DIR/lifeosd.mjs"
WRAPPER
chmod +x "$SCRIPTS_DIR/lifeos-daemon.sh"

# ── com.lifeos.server.plist ───────────────────────────────────────────────────

SERVER_PLIST="$AGENTS_DIR/com.lifeos.server.plist"
launchctl unload "$SERVER_PLIST" 2>/dev/null || true

cat > "$SERVER_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lifeos.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPTS_DIR/lifeos-server.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/server-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3000</string>
    </dict>
</dict>
</plist>
PLIST

launchctl load "$SERVER_PLIST"
echo "✅  com.lifeos.server   installed and loaded"

# ── com.lifeos.daemon.plist ───────────────────────────────────────────────────

DAEMON_PLIST="$AGENTS_DIR/com.lifeos.daemon.plist"
launchctl unload "$DAEMON_PLIST" 2>/dev/null || true

cat > "$DAEMON_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lifeos.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPTS_DIR/lifeos-daemon.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
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
    <string>$LOG_DIR/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/daemon-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

launchctl load "$DAEMON_PLIST"
echo "✅  com.lifeos.daemon   installed and loaded"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "🚀  Both services are running and will auto-start on login."
echo ""
echo "   Status    : launchctl list | grep lifeos"
echo "   Server log: tail -f $LOG_DIR/server.log"
echo "   Daemon log: tail -f $LOG_DIR/daemon.log"
echo ""
echo "   Stop server : launchctl unload $SERVER_PLIST"
echo "   Stop daemon : launchctl unload $DAEMON_PLIST"
echo "   Restart all : bash $SCRIPTS_DIR/setup-macos.sh"
echo ""
echo "   First run? Build first: npm run build && bash scripts/setup-macos.sh"
echo ""
