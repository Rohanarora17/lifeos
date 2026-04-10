#!/usr/bin/env python3
# macbook-daemon.py — LifeOS MacBook screen observer
# Runs as a LaunchAgent on MacBook. Every 60s:
#   1. Captures full screenshot (JPEG, quality 50)
#   2. Gets frontmost app + window title via AppleScript
#   3. POSTs both to Mac Mini server
#   4. Deletes screenshot immediately

import subprocess
import tempfile
import os
import time
import urllib.request
import urllib.error
import json

SERVER_URL = "http://192.168.0.205:3000/api/daemon/ingest"
INTERVAL_SECONDS = 60
WAKING_HOURS = (7, 23)  # Only run 7am–11pm

# ── Helpers ───────────────────────────────────────────────────────────────────

def get_active_app():
    """Get frontmost app name and window title via AppleScript."""
    script = '''
    tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
    end tell
    tell application frontApp
        try
            set winTitle to name of front window
        on error
            set winTitle to ""
        end try
    end tell
    return frontApp & "|" & winTitle
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        parts = result.stdout.strip().split("|", 1)
        app = parts[0].strip() if parts else ""
        title = parts[1].strip() if len(parts) > 1 else ""
        return app, title
    except Exception as e:
        print(f"[MacBook Daemon] AppleScript failed: {e}")
        return "", ""


def get_idle_seconds():
    """Get system idle time in seconds."""
    try:
        result = subprocess.run(
            ["ioreg", "-c", "IOHIDSystem"],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.splitlines():
            if "HIDIdleTime" in line:
                ns = int(line.split("=")[-1].strip())
                return ns // 1_000_000_000
    except Exception:
        pass
    return 0


def capture_screenshot(path):
    """Take a JPEG screenshot. Returns True on success."""
    try:
        result = subprocess.run(
            ["/usr/sbin/screencapture", "-x", "-t", "jpg", path],
            capture_output=True, timeout=10
        )
        return result.returncode == 0 and os.path.exists(path)
    except Exception as e:
        print(f"[MacBook Daemon] screencapture failed: {e}")
        return False


def post_to_server(screenshot_path, app, title, idle_seconds):
    """Send screenshot + metadata to Mac Mini via multipart POST."""
    boundary = "----LifeOSBoundary"
    body_parts = []

    def field(name, value):
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode()

    body_parts.append(field("source", "macbook_daemon"))
    body_parts.append(field("app", app))
    body_parts.append(field("title", title))
    body_parts.append(field("idle_seconds", str(idle_seconds)))

    # Attach screenshot
    with open(screenshot_path, "rb") as f:
        img_data = f.read()

    body_parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="screenshot"; filename="screen.jpg"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode() + img_data + b"\r\n"
    )
    body_parts.append(f"--{boundary}--\r\n".encode())

    body = b"".join(body_parts)

    req = urllib.request.Request(
        SERVER_URL,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"[MacBook Daemon] Sent: {app} / {title[:40]} → {resp.status}")
            return True
    except urllib.error.URLError as e:
        print(f"[MacBook Daemon] POST failed: {e.reason}")
        return False
    except Exception as e:
        print(f"[MacBook Daemon] POST error: {e}")
        return False


# ── Main loop ─────────────────────────────────────────────────────────────────

def run():
    print(f"[MacBook Daemon] Started. Posting to {SERVER_URL} every {INTERVAL_SECONDS}s")

    while True:
        try:
            hour = time.localtime().tm_hour
            if WAKING_HOURS[0] <= hour < WAKING_HOURS[1]:
                idle = get_idle_seconds()
                app, title = get_active_app()

                # Always send app/title even if screenshot fails
                tmp = tempfile.mktemp(suffix=".jpg", prefix="lifeos_")
                screenshot_ok = capture_screenshot(tmp)

                if screenshot_ok:
                    post_to_server(tmp, app, title, idle)
                    try:
                        os.unlink(tmp)
                    except Exception:
                        pass
                else:
                    # Send metadata only (no screenshot)
                    payload = json.dumps({
                        "source": "macbook_daemon",
                        "frontmost_app": app,
                        "window_title": title,
                        "idle_seconds": idle,
                        "machine_state": "idle" if idle > 300 else "active",
                        "audio_playing": False,
                        "running_apps": [],
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    }).encode()
                    req = urllib.request.Request(
                        SERVER_URL, data=payload,
                        headers={"Content-Type": "application/json"}, method="POST"
                    )
                    try:
                        urllib.request.urlopen(req, timeout=10)
                    except Exception:
                        pass
        except Exception as e:
            print(f"[MacBook Daemon] Loop error: {e}")

        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
