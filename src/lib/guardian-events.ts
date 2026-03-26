import { GuardianEvent, GuardianEventType } from './guardian-types';

const GUARDIAN_EVENT_TYPES: GuardianEventType[] = [
  'tab',
  'idle',
  'heartbeat',
  'voice',
  'override_request',
  'override_decision',
  'session_state',
];

export function isGuardianEventType(value: unknown): value is GuardianEventType {
  return typeof value === 'string' && GUARDIAN_EVENT_TYPES.includes(value as GuardianEventType);
}

export function normalizeGuardianEventInput(body: Record<string, unknown>): GuardianEvent | null {
  if (typeof body.sessionId !== 'string' || !body.sessionId) return null;
  if (!isGuardianEventType(body.type)) return null;

  return {
    sessionId: body.sessionId,
    type: body.type,
    timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
    url: typeof body.url === 'string' ? body.url : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    dwellSeconds: typeof body.dwellSeconds === 'number' ? body.dwellSeconds : undefined,
    prevUrl: typeof body.prevUrl === 'string' ? body.prevUrl : undefined,
    prevTitle: typeof body.prevTitle === 'string' ? body.prevTitle : undefined,
    idleSeconds: typeof body.idleSeconds === 'number' ? body.idleSeconds : undefined,
    transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
    tabGroupId: typeof body.tabGroupId === 'number' ? body.tabGroupId : undefined,
    tabGroupTitle: typeof body.tabGroupTitle === 'string' ? body.tabGroupTitle : undefined,
    tabGroupColor: typeof body.tabGroupColor === 'string' ? body.tabGroupColor : undefined,
    payload: typeof body.payload === 'object' && body.payload !== null ? (body.payload as Record<string, unknown>) : undefined,
  };
}
