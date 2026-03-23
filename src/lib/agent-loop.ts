import { appendGuardianEvent, getGuardianSession, tickGuardianSession } from './guardian-runtime';
import { GuardianDecision, GuardianEvent, GuardianState } from './guardian-types';

// Legacy compatibility wrappers around the new guardian runtime.

export function observe(sessionId: string) {
    return getGuardianSession(sessionId);
}

export function decide(state: GuardianState | null): GuardianDecision | { action: 'silence' } {
    return state?.lastIntervention || { action: 'silence' };
}

export async function act(decision: GuardianDecision | { action: 'silence' }, state: GuardianState | null) {
    return { decision, state };
}

export async function tickAgentLoop(sessionId: string) {
    const result = await tickGuardianSession(sessionId, { sessionId, type: 'heartbeat', timestamp: Date.now() });
    return result.session
        ? {
            focusScore: result.session.focusScoreHistory[result.session.focusScoreHistory.length - 1] ?? 100,
            trend: 'stable',
            actionTaken: result.decision.type,
        }
        : null;
}

export function ingestTabEvent(event: GuardianEvent) {
    return appendGuardianEvent(event);
}
