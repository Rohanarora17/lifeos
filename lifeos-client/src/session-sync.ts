export interface SessionState {
  active: boolean;
  sessionId?: string;
  goalTitle?: string;
  topic?: string;
  captureState: 'deep_focus' | 'normal' | 'heightened' | 'guidance_burst';
  nextIntervalMs: number;
  focusScore?: number;
}

const DEFAULT_STATE: SessionState = {
  active: false,
  captureState: 'normal',
  nextIntervalMs: 15_000,
};

let current: SessionState = { ...DEFAULT_STATE };
let lastPollWasActive = false;
let serverUnreachableLoggedAt = 0;

export function getSessionState(): SessionState {
  return current;
}

export async function pollSessionState(serverUrl: string): Promise<SessionState> {
  try {
    const res = await fetch(`${serverUrl}/api/guardian/vision`, { method: 'GET', signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      if (lastPollWasActive) console.log('[session-sync] Server returned non-OK — clearing session state');
      current = { ...DEFAULT_STATE };
      lastPollWasActive = false;
      return current;
    }
    const next = (await res.json()) as SessionState;
    // Log transitions
    if (next.active && !lastPollWasActive) {
      console.log(`[session-sync] Session STARTED: "${next.goalTitle ?? next.sessionId}" captureInterval=${Math.round(next.nextIntervalMs / 1000)}s`);
    } else if (!next.active && lastPollWasActive) {
      console.log('[session-sync] Session ENDED — capture paused');
    }
    lastPollWasActive = next.active;
    current = next;
    return current;
  } catch (err) {
    // Only log once per minute to avoid spamming when server is down
    if (Date.now() - serverUnreachableLoggedAt > 60_000) {
      console.error(`[session-sync] Server unreachable at ${serverUrl} — ${(err as Error).message}`);
      serverUnreachableLoggedAt = Date.now();
    }
    if (lastPollWasActive) { console.log('[session-sync] Lost server connection — clearing session state'); lastPollWasActive = false; }
    current = { ...DEFAULT_STATE };
    return current;
  }
}

export async function sendHeartbeat(serverUrl: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/guardian/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'heartbeat' }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* non-fatal */ }
}

export async function sendScreenshot(
  serverUrl: string,
  sessionId: string,
  base64Jpeg: string,
  appInFocus: string,
  windowTitle: string,
): Promise<{ analyzed: boolean; captureState?: string; nextIntervalMs?: number } | null> {
  try {
    const res = await fetch(`${serverUrl}/api/guardian/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, base64Jpeg, appInFocus, windowTitle }),
      signal: AbortSignal.timeout(15_000), // Gemini analysis can take a few seconds
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[session-sync] Screenshot rejected — HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return await res.json() as { analyzed: boolean; captureState?: string; nextIntervalMs?: number };
  } catch (err) {
    console.error('[session-sync] Failed to send screenshot:', (err as Error).message);
    return null;
  }
}

export async function sendGuidanceRequest(
  serverUrl: string,
  sessionId: string,
  base64Jpeg: string,
  appInFocus: string,
  windowTitle: string,
  selectedText: string,
  question: string,
): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/guardian/guidance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, base64Jpeg, appInFocus, windowTitle, selectedText, question, source: 'client_hotkey' }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error('[session-sync] Failed to send guidance request:', err);
  }
}
