import { EventEmitter } from 'events';

export type SessionStateEnum = 'INACTIVE' | 'SOFT_WATCH' | 'ACTIVE' | 'BREAK' | 'COMPLETE';

export interface TabEvent {
    url: string;
    title: string;
    timestamp: number;
    dwellSeconds?: number;
    idleSeconds?: number;
}

export interface ActiveSession {
    sessionId: string;
    state: SessionStateEnum;
    goalId: string | null;
    conceptNodeId: string | null;
    conceptNodeName: string | null;
    durationMinutes: number;
    mood: 'high' | 'medium' | 'low' | null;
    startedAt: number;
    tick: number;
    tabEventLog: TabEvent[];
    focusScoreHistory: number[];
    blockedCount: number;
}

// Global store to persist across HMR in development
const globalForSessions = global as unknown as {
    activeSessions: Map<string, ActiveSession>;
    sessionEmitter: EventEmitter;
};

export const activeSessions = globalForSessions.activeSessions || new Map<string, ActiveSession>();
export const sessionEmitter = globalForSessions.sessionEmitter || new EventEmitter();

if (process.env.NODE_ENV !== 'production') {
    globalForSessions.activeSessions = activeSessions;
    globalForSessions.sessionEmitter = sessionEmitter;
}

export function startSession(intent: any) {
    const sessionId = Math.random().toString(36).substring(2, 15);
    const session: ActiveSession = {
        sessionId,
        state: 'ACTIVE',
        goalId: intent.goalId || null,
        conceptNodeId: intent.conceptNodeId || null,
        conceptNodeName: intent.conceptNodeName || null,
        durationMinutes: intent.durationMinutes || 60,
        mood: intent.mood || null,
        startedAt: Date.now(),
        tick: 0,
        tabEventLog: [],
        focusScoreHistory: [],
        blockedCount: 0
    };
    activeSessions.set(sessionId, session);
    return session;
}

export function getSession(sessionId: string) {
    return activeSessions.get(sessionId);
}

export function pauseSession(sessionId: string) {
    const session = activeSessions.get(sessionId);
    if (session) session.state = 'BREAK';
}

export function resumeSession(sessionId: string) {
    const session = activeSessions.get(sessionId);
    if (session) session.state = 'ACTIVE';
}

export function endSession(sessionId: string) {
    const session = activeSessions.get(sessionId);
    if (session) session.state = 'COMPLETE';
}
