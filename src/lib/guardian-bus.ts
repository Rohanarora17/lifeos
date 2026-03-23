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
