/**
 * LifeOS Vision Client — MacBook-side daemon
 *
 * Runs on your MacBook (the work device). Captures the screen during active
 * LifeOS guardian sessions and POSTs screenshots to the Mac Mini server for
 * analysis. Also sends heartbeats so the Mac Mini knows this client is online.
 *
 * Setup:
 *   1. npm install && npm run build
 *   2. Edit ~/.lifeos-client/config.json with your Mac Mini server URL
 *   3. Run ./install.sh to register as a launchd login item
 *
 * Or run manually: npm start
 */

import { loadConfig } from './config';
import { captureScreen, getClipboardText } from './capture';
import {
  pollSessionState,
  sendHeartbeat,
  sendScreenshot,
  sendGuidanceRequest,
  getSessionState,
} from './session-sync';

const config = loadConfig();
console.log(`[lifeos-client] Starting. Server: ${config.serverUrl}`);

// ---------------------------------------------------------------------------
// Capture loop state
// ---------------------------------------------------------------------------

let captureTimer: ReturnType<typeof setTimeout> | null = null;

let lastNoSessionLogAt = 0;
let totalCapturesSent = 0;
let totalCapturesSkipped = 0;

async function runCaptureCycle(): Promise<void> {
  const session = getSessionState();

  if (!session.active || !session.sessionId) {
    // Log once per minute so you can see it's alive but waiting
    if (Date.now() - lastNoSessionLogAt > 60_000) {
      console.log(`[capture] No active session — waiting. (${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)`);
      lastNoSessionLogAt = Date.now();
    }
    scheduleNextCapture(config.sessionPollIntervalMs);
    return;
  }

  console.log(`[capture] Session active: "${session.goalTitle ?? session.sessionId}" — capturing screen...`);
  const result = await captureScreen(config.jpegQuality, config.sensitiveApps);
  if (!result) {
    totalCapturesSkipped++;
    console.log(`[capture] Skipped (sensitive app or screencapture error). Total skipped: ${totalCapturesSkipped}`);
    scheduleNextCapture(session.nextIntervalMs);
    return;
  }

  console.log(`[capture] Captured: app="${result.appInFocus}" window="${result.windowTitle}" — sending to server...`);
  const response = await sendScreenshot(
    config.serverUrl,
    session.sessionId,
    result.base64Jpeg,
    result.appInFocus,
    result.windowTitle,
  );

  if (response) {
    totalCapturesSent++;
    if (response.analyzed) {
      console.log(`[capture] ✓ Analyzed — captureState=${response.captureState} nextInterval=${Math.round((response.nextIntervalMs ?? session.nextIntervalMs) / 1000)}s total=${totalCapturesSent}`);
    } else {
      console.log(`[capture] → No change detected by server. nextInterval=${Math.round((response.nextIntervalMs ?? session.nextIntervalMs) / 1000)}s`);
    }
  } else {
    console.error(`[capture] ✗ Server rejected screenshot (returned null/error). Check server logs.`);
  }

  // Use server-specified interval (adaptive capture rate)
  const nextMs = response?.nextIntervalMs ?? session.nextIntervalMs;
  scheduleNextCapture(nextMs);
}

function scheduleNextCapture(intervalMs: number): void {
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => void runCaptureCycle(), intervalMs);
}

// ---------------------------------------------------------------------------
// Session polling loop
// ---------------------------------------------------------------------------

async function pollLoop(): Promise<void> {
  await pollSessionState(config.serverUrl);
  setTimeout(() => void pollLoop(), config.sessionPollIntervalMs);
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

async function heartbeatLoop(): Promise<void> {
  await sendHeartbeat(config.serverUrl);
  setTimeout(() => void heartbeatLoop(), config.heartbeatIntervalMs);
}

// ---------------------------------------------------------------------------
// Global hotkey: Cmd+Shift+G → guidance trigger
// Requires: user has set up macOS Shortcuts or Hammerspoon to POST to
// /api/guardian/vision/trigger on hotkey. See README for setup instructions.
//
// For now: expose a local HTTP listener on port 7891 that the hotkey tool
// can curl to, which then assembles the full context and forwards to Mac Mini.
// ---------------------------------------------------------------------------

import http from 'http';

const TRIGGER_PORT = 7891;

const triggerServer = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = '';
  req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  req.on('end', () => {
    void handleTrigger(body).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
});

triggerServer.listen(TRIGGER_PORT, '127.0.0.1', () => {
  console.log(`[lifeos-client] Trigger listener on 127.0.0.1:${TRIGGER_PORT}`);
  console.log(`[lifeos-client] To trigger guidance: curl -X POST http://127.0.0.1:${TRIGGER_PORT} -d '{"question":"explain this"}'`);
  console.log(`[lifeos-client] Set up a global Cmd+Shift+G hotkey (Hammerspoon/Shortcuts) to run that curl command.`);
});

async function handleTrigger(rawBody: string): Promise<void> {
  const session = getSessionState();
  if (!session.active || !session.sessionId) {
    console.log('[trigger] No active session — ignoring guidance trigger');
    return;
  }

  let question = 'Explain what I am looking at in the context of my session goal.';
  try {
    const parsed = JSON.parse(rawBody) as { question?: string };
    if (parsed.question) question = parsed.question;
  } catch { /* use default */ }

  const capture = await captureScreen(config.jpegQuality, config.sensitiveApps);
  if (!capture) {
    console.log('[trigger] Capture skipped (sensitive app or error)');
    return;
  }

  const selectedText = getClipboardText();

  await sendGuidanceRequest(
    config.serverUrl,
    session.sessionId,
    capture.base64Jpeg,
    capture.appInFocus,
    capture.windowTitle,
    selectedText,
    question,
  );
}

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

void pollLoop();
void heartbeatLoop();
scheduleNextCapture(config.sessionPollIntervalMs); // initial delay while polling stabilizes

process.on('SIGINT', () => {
  console.log('[lifeos-client] Shutting down');
  if (captureTimer) clearTimeout(captureTimer);
  triggerServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (captureTimer) clearTimeout(captureTimer);
  triggerServer.close();
  process.exit(0);
});
