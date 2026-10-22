#!/usr/bin/env python3
"""Loopback-only synthetic API for --study-chat-preview. Never reads LifeOS data."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

state = {
    "ok": True, "enabled": True, "date": "2026-10-22", "revision": 7,
    "messages": [{"id": 1, "role": "assistant", "text": "Your agreed return is due. Ready to study?", "createdAt": "2026-10-22T07:40:00Z"}],
    "activity": None,
    "pendingPrompt": {"id": "preview-return-1", "kind": "return", "text": "Your agreed return is due. Ready to study?", "createdAt": "2026-10-22T07:40:00Z"},
    "pendingQuestion": None, "plan": None,
    "remainingSeconds": 28800, "measuredSeconds": 0, "selfReportedSeconds": 0, "classSeconds": 0,
}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path != "/api/study-chat":
            self.send_error(404)
            return
        self.respond(state)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body.get("action") != "ack_prompt" or body.get("promptId") != "preview-return-1":
            self.send_error(400)
            return
        print("ACK displayed preview prompt", flush=True)
        state["pendingPrompt"] = None
        self.respond({"ok": True})

    def respond(self, payload):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=0)
parser.add_argument("--prompt-kind", choices=["return", "clarification"], default="return")
args = parser.parse_args()
if args.prompt_kind == "clarification":
    state["pendingPrompt"]["kind"] = "clarification"
    state["pendingPrompt"]["text"] = "Your return time is still unconfirmed. When will you return?"
    state["messages"][0]["text"] = state["pendingPrompt"]["text"]
server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
print(f"http://127.0.0.1:{server.server_port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
