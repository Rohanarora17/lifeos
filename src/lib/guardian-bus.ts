import { EventEmitter } from 'events';

type GuardianEventListener = (sessionId: string, eventData: unknown) => void;

const globalGuardianBus = global as unknown as {
  guardianEmitter?: EventEmitter;
};

const guardianEmitter = globalGuardianBus.guardianEmitter || new EventEmitter();

if (process.env.NODE_ENV !== 'production') {
  globalGuardianBus.guardianEmitter = guardianEmitter;
}

export function emitGuardianRuntimeEvent(sessionId: string, eventData: unknown) {
  guardianEmitter.emit('guardian_event', sessionId, eventData);
}

export function subscribeToGuardianRuntimeEvents(listener: GuardianEventListener) {
  guardianEmitter.on('guardian_event', listener);
  return () => guardianEmitter.off('guardian_event', listener);
}

// ─── Dashboard pending speech ─────────────────────────────────────────────────
// ElevenLabs TTS fires an SSE event that only reaches clients with an open
// extension SSE connection. Dashboard sessions poll /api/guardian/state rather
// than holding SSE, so they miss the event. Store the text here so the next
// poll can deliver it to the dashboard, which speaks it via the Web Speech API.
const pendingSpeechMap = new Map<string, string>();

export function setPendingSpeech(sessionId: string, text: string) {
  pendingSpeechMap.set(sessionId, text);
}

export function consumePendingSpeech(sessionId: string): string | null {
  const text = pendingSpeechMap.get(sessionId) ?? null;
  if (text !== null) pendingSpeechMap.delete(sessionId);
  return text;
}
