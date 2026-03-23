import { getDayBriefing } from './longitudinal-engine';
import { getGenAI } from './ai';
import { canUseCloudTextReasoning, sanitizeTranscriptForCloud } from './cloud-privacy';
import { MODEL_FLASH } from './models';
import { speak } from './tts';
import {
  adjudicateOverride,
  getGuardianContext,
  getGuardianSession,
  listGuardianSessions,
  startGuardianSession,
  tickGuardianSession,
} from './guardian-runtime';

type VoiceAction =
  | 'start_session'
  | 'guardian_status'
  | 'request_override'
  | 'day_briefing'
  | 'tutor'
  | 'unknown';

interface ParsedVoiceIntent {
  action: VoiceAction;
  topic?: string;
  durationMinutes?: number;
  mood?: 'high' | 'medium' | 'low' | null;
  overrideTarget?: string;
  overrideReason?: string;
  requestedMinutes?: number;
  responseText?: string;
}

interface ProcessVoiceCommandInput {
  transcript: string;
  sessionId?: string | null;
}

interface VoiceActionResult {
  type:
    | 'session_started'
    | 'guardian_status'
    | 'override_decision'
    | 'day_briefing'
    | 'tutor_response'
    | 'intent_only';
  transcript: string;
  intent: ParsedVoiceIntent;
  session?: unknown;
  decision?: unknown;
  briefing?: unknown;
  responseText: string;
}

async function maybeSpeakVoiceResponse(sessionId: string | null, text: string, priority: 'normal' | 'urgent' = 'normal') {
  if (!text) return;
  await speak(sessionId || 'voice-assistant', text, priority, 'neutral');
}

function normalizeMood(value: string | null | undefined): 'high' | 'medium' | 'low' | null {
  if (!value) return null;
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (value === 'neutral') return 'medium';
  return null;
}

function heuristicParseVoiceIntent(transcript: string): ParsedVoiceIntent {
  const lower = transcript.toLowerCase().trim();
  const durationMatch = lower.match(/(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs)/);

  let durationMinutes: number | undefined;
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2];
    durationMinutes = unit.startsWith('hour') || unit.startsWith('hr') ? value * 60 : value;
  }

  if (/(how am i doing|guardian status|status|am i focused|focus score)/.test(lower)) {
    return { action: 'guardian_status', durationMinutes };
  }

  if (/(day briefing|brief me|what's the plan today|today's plan|today plan)/.test(lower)) {
    return { action: 'day_briefing', durationMinutes };
  }

  if (/(override|allow this|let me use|unblock|i need this site)/.test(lower)) {
    return {
      action: 'request_override',
      requestedMinutes: durationMinutes,
      overrideReason: transcript,
    };
  }

  if (/(tutor|teach me|explain|help me understand|how do i solve)/.test(lower)) {
    return { action: 'tutor' };
  }

  if (/(lock in|start session|focus session|study session|we need to finish|today we have to finish)/.test(lower)) {
    const topic =
      transcript
        .replace(/^(hey\s+lifeos[, ]*)/i, '')
        .replace(/^(let'?s|we)\s+/i, '')
        .replace(/(lock in|start( a)? (focus|study) session)/gi, '')
        .trim() || undefined;

    return {
      action: 'start_session',
      topic,
      durationMinutes,
      mood: /tiring day|tired|exhausted|low energy/.test(lower) ? 'low' : null,
    };
  }

  return { action: 'unknown' };
}

async function parseGuardianVoiceIntent(transcript: string): Promise<ParsedVoiceIntent> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return heuristicParseVoiceIntent(transcript);
  }

  try {
    const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);
    const result = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: `Parse this LifeOS Guardian voice transcript into JSON only.

Transcript: "${sanitizedTranscript}"

Schema:
{
  "action": "start_session" | "guardian_status" | "request_override" | "day_briefing" | "tutor" | "unknown",
  "topic": "string or empty",
  "durationMinutes": 60,
  "mood": "high" | "medium" | "low" | null,
  "overrideTarget": "string or empty",
  "overrideReason": "string or empty",
  "requestedMinutes": 10,
  "responseText": "only for tutor/unknown lightweight answers"
}`,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse((result.text || '').trim() || '{}') as Partial<ParsedVoiceIntent>;
    if (!parsed.action) return heuristicParseVoiceIntent(transcript);

    return {
      action: parsed.action,
      topic: parsed.topic || undefined,
      durationMinutes: typeof parsed.durationMinutes === 'number' ? parsed.durationMinutes : undefined,
      mood: normalizeMood(parsed.mood),
      overrideTarget: parsed.overrideTarget || undefined,
      overrideReason: parsed.overrideReason || undefined,
      requestedMinutes: typeof parsed.requestedMinutes === 'number' ? parsed.requestedMinutes : undefined,
      responseText: parsed.responseText || undefined,
    };
  } catch {
    return heuristicParseVoiceIntent(transcript);
  }
}

function getActiveSessionId(preferredSessionId?: string | null) {
  if (preferredSessionId && getGuardianSession(preferredSessionId)) {
    return preferredSessionId;
  }
  return listGuardianSessions().find((session) => session.state === 'ACTIVE')?.sessionId || null;
}

async function emitVoiceEvent(sessionId: string, transcript: string) {
  await tickGuardianSession(sessionId, {
    sessionId,
    type: 'voice',
    timestamp: Date.now(),
    transcript,
  });
}

export async function processGuardianVoiceCommand(input: ProcessVoiceCommandInput): Promise<VoiceActionResult> {
  const transcript = input.transcript.trim();
  const intent = await parseGuardianVoiceIntent(transcript);
  const activeSessionId = getActiveSessionId(input.sessionId);

  if (activeSessionId) {
    await emitVoiceEvent(activeSessionId, transcript);
  }

  if (intent.action === 'start_session' && intent.topic) {
    const session = startGuardianSession({
      topic: intent.topic,
      durationMinutes: intent.durationMinutes || 60,
      mood: intent.mood || null,
      source: 'voice',
    });

    return {
      type: 'session_started',
      transcript,
      intent,
      session,
      responseText: `Starting a guarded session for ${session.targetTitle} for ${session.durationMinutes} minutes.`,
    };
  }

  if (intent.action === 'guardian_status') {
    const session = activeSessionId ? getGuardianSession(activeSessionId) : null;
    const latestScore = session?.focusScoreHistory[session.focusScoreHistory.length - 1] ?? null;
    const responseText = session
      ? `You are ${session.currentClassification === 'distraction' ? 'drifting' : 'currently'} on ${session.targetTitle}. Focus score is ${latestScore ?? 100}.`
      : 'No active guardian session right now.';

    await maybeSpeakVoiceResponse(activeSessionId, responseText);

    return {
      type: 'guardian_status',
      transcript,
      intent,
      session,
      responseText,
    };
  }

  if (intent.action === 'request_override') {
    if (!activeSessionId) {
      return {
        type: 'intent_only',
        transcript,
        intent,
        responseText: 'There is no active guardian session to override right now.',
      };
    }

    const session = getGuardianSession(activeSessionId);
    const targetUrl = intent.overrideTarget || session?.currentUrl;
    if (!targetUrl) {
      return {
        type: 'intent_only',
        transcript,
        intent,
        responseText: 'I need the current blocked target to review that override.',
      };
    }

    const decision = await adjudicateOverride({
      sessionId: activeSessionId,
      url: targetUrl,
      title: session?.currentTitle || undefined,
      reason: intent.overrideReason || transcript,
      requestedMinutes: intent.requestedMinutes,
    });

    await maybeSpeakVoiceResponse(activeSessionId, decision.explainability, decision.approved ? 'normal' : 'urgent');

    return {
      type: 'override_decision',
      transcript,
      intent,
      decision,
      responseText: decision.explainability,
    };
  }

  if (intent.action === 'day_briefing') {
    const briefing = getDayBriefing('default');
    const responseText = `You have ${briefing.recentSessions} recent sessions, an average focus score of ${Math.round(
      briefing.avgFocusScore
    )}, and active goals: ${briefing.activeGoals.join(', ') || 'none yet'}.`;
    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    return {
      type: 'day_briefing',
      transcript,
      intent,
      briefing,
      responseText,
    };
  }

  if (intent.action === 'tutor') {
    const { activeGoals, activeTasks, activeSession } = getGuardianContext();
    const goalTitles = (Array.isArray(activeGoals) ? activeGoals : []).map((goal) =>
      typeof goal === 'object' && goal !== null && 'title' in goal ? String(goal.title) : ''
    ).filter(Boolean);
    const taskTitles = (Array.isArray(activeTasks) ? activeTasks : []).map((task) =>
      typeof task === 'object' && task !== null && 'title' in task ? String(task.title) : ''
    ).filter(Boolean);
    const ai = getGenAI();

    if (ai && canUseCloudTextReasoning()) {
      try {
        const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);
        const result = await ai.models.generateContent({
          model: MODEL_FLASH,
          contents: `You are LifeOS Tutor Mode. Answer briefly and concretely.

Transcript: ${sanitizedTranscript}
Active session target: ${activeSession?.targetTitle || 'none'}
Active goals: ${goalTitles.join(', ') || 'none'}
Active tasks: ${taskTitles.join(', ') || 'none'}

Return only the user-facing answer.`,
          config: {
            temperature: 0.2,
          },
        });

        const responseText = (result.text || '').trim() || 'Tutor mode is ready, but I need a more specific question.';
        await maybeSpeakVoiceResponse(activeSessionId, responseText);

        return {
          type: 'tutor_response',
          transcript,
          intent,
          responseText,
        };
      } catch {
        // fall through to default
      }
    }

    await maybeSpeakVoiceResponse(activeSessionId, intent.responseText || 'Tutor mode is available, but I need a more specific question.');

    return {
      type: 'tutor_response',
      transcript,
      intent,
      responseText: intent.responseText || 'Tutor mode is available, but I need a more specific question.',
    };
  }

  return {
    type: 'intent_only',
    transcript,
    intent,
    responseText: intent.responseText || 'I heard you, but I could not map that to a guardian action yet.',
  };
}
