#!/usr/bin/env python3
"""
LifeOS macOS Daemon — always-on app/window tracker
Sends structured observations to LifeOS API every 60 seconds.
"""

import json
import subprocess
import time
import urllib.request
import urllib.error
from datetime import datetime

LIFEOS_API_URL = "http://localhost:3000/api/daemon/ingest"
INTERVAL_SECONDS = 60

def get_frontmost_app():
    """Get frontmost app name and window title via AppleScript."""
    script = '''
    tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
    end tell

    set windowTitle to ""
    try
        tell application frontApp
            set windowTitle to name of front window
        end tell
    end try

    return frontApp & "|||" & windowTitle
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            parts = result.stdout.strip().split("|||")
            app = parts[0].strip() if len(parts) > 0 else ""
            title = parts[1].strip() if len(parts) > 1 else ""
            return app, title
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    return "", ""

def get_idle_seconds():
    """Get system idle time in seconds."""
    try:
        result = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.split("\n"):
            if "HIDIdleTime" in line:
                idle_ns = int(line.split("=")[-1].strip())
                return idle_ns // 1_000_000_000
    except Exception:
        pass
    return 0

def get_running_apps():
    """Get list of running application names."""
    script = '''
    tell application "System Events"
        set appNames to name of every application process whose background only is false
    end tell
    return appNames
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            apps = [a.strip() for a in result.stdout.strip().split(",")]
            return apps[:20]  # Limit to 20 apps
    except Exception:
        pass
    return []

def send_observation(payload):
    """Send observation to LifeOS API."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        LIFEOS_API_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except urllib.error.URLError:
        return False
    except Exception:
        return False

def main():
    print(f"[LifeOS Daemon] Starting. Posting to {LIFEOS_API_URL} every {INTERVAL_SECONDS}s")

    while True:
        try:
            app, window_title = get_frontmost_app()
            idle_seconds = get_idle_seconds()
            running_apps = get_running_apps()

            now = datetime.now()

            payload = {
                "timestamp": now.isoformat(),
                "frontmost_app": app,
                "window_title": window_title,
                "idle_seconds": idle_seconds,
                "machine_state": "idle" if idle_seconds > 300 else "active",
                "audio_playing": False,
                "running_apps": running_apps,
            }

            sent = send_observation(payload)
            if not sent:
                print(f"[LifeOS Daemon] Failed to send observation at {now.isoformat()}")

        except Exception as e:
            print(f"[LifeOS Daemon] Error: {e}")

        time.sleep(INTERVAL_SECONDS)

if __name__ == "__main__":
    main()
