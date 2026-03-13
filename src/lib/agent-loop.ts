import { getSession, activeSessions, sessionEmitter, ActiveSession, TabEvent } from './session-state';
import { computeFocusScore, Trend } from './focus-score';
import { speak } from './tts';

const toneTemplates = {
    flow_confirmed: "Locked in. {elapsed} clean minutes. Keep this pace.",
    direct_push: "You've hit {site} {count} times. Push through the next 10.",
    grounding_nudge: "You're scattered. Close the other tabs. One thing.",
    break_suggestion: "You're slowing down. Take {breakMins} minutes, then finish.",
    midpoint_checkin: "Halfway. Score {score} — {comparison}. {remaining} more.",
    final_push: "{remaining} minutes left. Finish what you started.",
    personal_best: "That's your best session on this topic. Remember this feeling.",
    session_end: "{elapsed} minutes. Score {score}. {topicName} covered. That's a locked-in session.",
};

const SPEECH_COOLDOWN_MS = 90_000;
const FLOW_SILENCE_THRESHOLD = 85;

const globalLoop = global as unknown as { lastSpeechMap: Map<string, number> };
export const lastSpeechMap = globalLoop.lastSpeechMap || new Map<string, number>();
if (process.env.NODE_ENV !== 'production') globalLoop.lastSpeechMap = lastSpeechMap;

function shouldSpeak(state: any) {
    const lastSpeechAt = lastSpeechMap.get(state.sessionId) || 0;
    const cooldownPassed = (Date.now() - lastSpeechAt) > SPEECH_COOLDOWN_MS;
    const notInFlow = state.focusScore < FLOW_SILENCE_THRESHOLD;
    return cooldownPassed && notInFlow;
}

export function observe(sessionId: string) {
    const session = getSession(sessionId);
    if (!session) return null;

    const now = Date.now();
    const elapsedMinutes = (now - session.startedAt) / 60000;

    const { score: focusScore, trend: focusTrend } = computeFocusScore(session);
    session.focusScoreHistory.push(focusScore);

    const fiveMinAgo = now - 300000;
    const recentEvents = session.tabEventLog.filter(e => e.timestamp >= fiveMinAgo && e.url !== 'lifeos://idle');
    const tabSwitchesLast5Min = recentEvents.length;

    const distractionRevisits = session.tabEventLog.filter(e =>
        e.url.includes('youtube.com') || e.url.includes('twitter.com') || e.url.includes('reddit.com')
    ).length;

    const latestEvent = session.tabEventLog[session.tabEventLog.length - 1];
    const urlClassification = (latestEvent?.url.includes('youtube') || latestEvent?.url.includes('twitter') || latestEvent?.url.includes('reddit')) ? 'distraction' : 'on_topic';

    const state = {
        sessionId,
        tick: session.tick + 1,
        currentUrl: latestEvent?.url || '',
        currentTitle: latestEvent?.title || '',
        urlClassification,
        dwellSeconds: latestEvent?.dwellSeconds || 0,
        tabSwitchesLast5Min,
        distractionRevisits,
        idleSeconds: latestEvent?.idleSeconds || 0,
        elapsedMinutes,
        plannedMinutes: session.durationMinutes,
        focusScore,
        focusScoreHistory: session.focusScoreHistory,
        focusTrend,
        energyLevel: session.mood || 'medium',
        mood: session.mood
    };

    session.tick++;
    return state;
}

export function decide(state: any) {
    if (state.distractionRevisits >= 3 && state.urlClassification === 'distraction') {
        return { action: 'block', reason: 'Repeated distraction visits', tone: toneTemplates.direct_push };
    }

    if (state.tabSwitchesLast5Min > 4 && state.urlClassification === 'distraction') {
        return { action: 'block', reason: 'Rapid context switching', tone: toneTemplates.grounding_nudge };
    }

    if (state.tabSwitchesLast5Min > 6 && shouldSpeak(state)) {
        return { action: 'speak', text: toneTemplates.grounding_nudge, tone: 'grounding_nudge' };
    }

    if (state.idleSeconds > 480 && shouldSpeak(state)) {
        return { action: 'speak', text: "You've been idle for a while. Are you focusing elsewhere?", tone: 'check_in_concern' };
    }

    const hist = state.focusScoreHistory;
    if (hist.length >= 3 && (hist[hist.length - 3] - state.focusScore) > 15 && shouldSpeak(state)) {
        return { action: 'speak', text: "Focus is slipping. Pull it back.", tone: 'motivational_push' };
    }

    if (state.focusTrend === 'falling' && state.focusScore < 60 && shouldSpeak(state)) {
        return { action: 'speak', text: toneTemplates.break_suggestion.replace('{breakMins}', '5'), tone: 'break_suggestion' };
    }

    if (Math.floor(state.elapsedMinutes) === Math.floor(state.plannedMinutes * 0.5) && shouldSpeak(state)) {
        let text = toneTemplates.midpoint_checkin.replace('{score}', String(state.focusScore))
            .replace('{comparison}', 'strong session')
            .replace('{remaining}', String(Math.floor(state.plannedMinutes - state.elapsedMinutes)));
        return { action: 'speak', text, tone: 'midpoint_checkin' };
    }

    if (Math.floor(state.elapsedMinutes) === Math.floor(state.plannedMinutes * 0.8) && shouldSpeak(state)) {
        let text = toneTemplates.final_push.replace('{remaining}', String(Math.floor(state.plannedMinutes - state.elapsedMinutes)));
        return { action: 'speak', text, tone: 'final_push' };
    }

    if (state.urlClassification === 'on_topic' && state.dwellSeconds > 240 && state.focusScore > 85) {
        return { action: 'classify', url: state.currentUrl, nodeId: 'mock_node_id' };
    }

    if (state.focusTrend === 'rising' && state.focusScore > 88 && hist.length >= 3 && hist[hist.length - 3] > 88 && shouldSpeak(state)) {
        let text = toneTemplates.flow_confirmed.replace('{elapsed}', String(Math.floor(state.elapsedMinutes)));
        return { action: 'speak', text, tone: 'flow_confirmed' };
    }

    return { action: 'silence' };
}

export async function act(decision: any, state: any) {
    if (decision.action === 'silence') return;

    if (decision.action === 'speak') {
        speak(state.sessionId, decision.text, 'normal', decision.tone);
        lastSpeechMap.set(state.sessionId, Date.now());
    }

    if (decision.action === 'block') {
        sessionEmitter.emit('agent_event', state.sessionId, {
            type: 'intervention', action: 'block', payload: { reason: decision.reason }
        });

        // Also send block to extension via a hack from the frontend or direct push
        // Currently frontend SSE listener triggers extension messages

        if (decision.tone) {
            speak(state.sessionId, decision.tone, 'urgent', 'direct_push');
            lastSpeechMap.set(state.sessionId, Date.now());
        }
    }

    if (decision.action === 'classify') {
        sessionEmitter.emit('agent_event', state.sessionId, {
            type: 'intervention', action: 'classify', payload: { url: decision.url, nodeId: decision.nodeId, conceptTitle: 'Polynomial Math' }
        });
    }
}

export async function tickAgentLoop(sessionId: string) {
    const state = observe(sessionId);
    if (!state) return null;

    sessionEmitter.emit('agent_event', sessionId, {
        type: 'focus_score',
        score: state.focusScore,
        delta: state.focusScoreHistory.length > 1 ? state.focusScore - state.focusScoreHistory[state.focusScoreHistory.length - 2] : 0
    });

    const decision = decide(state);
    await act(decision, state);
    return { focusScore: state.focusScore, trend: state.focusTrend, actionTaken: decision.action };
}
