import {
    endGuardianSession,
    getGuardianSession,
    listGuardianSessions,
    pauseGuardianSession,
    resumeGuardianSession,
    startGuardianSession,
} from './guardian-runtime';
import { GuardianEvent, GuardianStartRequest, GuardianState } from './guardian-types';

export type TabEvent = GuardianEvent;
export type ActiveSession = GuardianState;

export function startSession(intent: GuardianStartRequest) {
    return startGuardianSession(intent);
}

export function getSession(sessionId: string) {
    return getGuardianSession(sessionId) || undefined;
}

export function pauseSession(sessionId: string) {
    pauseGuardianSession(sessionId);
}

export function resumeSession(sessionId: string) {
    resumeGuardianSession(sessionId);
}

export function endSession(sessionId: string) {
    endGuardianSession(sessionId);
}

export function listSessions() {
    return listGuardianSessions();
}
