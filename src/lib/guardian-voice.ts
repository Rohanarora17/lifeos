import { getDayBriefing } from './longitudinal-engine';
import { getGenAI, generateWithFallback } from './ai';
import { canUseCloudTextReasoning, sanitizeTranscriptForCloud } from './cloud-privacy';
import { MODEL_FLASH } from './models';
import { speak } from './tts';
import {
  adjudicateOverride,
  createSoftWatchCommitment,
  getGuardianContext,
  getGuardianSession,
  listGuardianSessions,
  startGuardianSession,
  tickGuardianSession,
} from './guardian-runtime';
import { createCalendarEvent, getConflictingEvents, isCalendarConfigured } from './google-calendar';
import { sendTelegram } from './telegram';
import { getDb } from './db';
import { getIntelligenceContext, touchIntelligence } from './intelligence';
import { extractMemoryFromVoice } from './memory-extractor';

// ─── Types ────────────────────────────────────────────────────────────────────

type VoiceAction =
  | 'start_session'
  | 'schedule_session'
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
  intendedStartAt?: number;
}

interface ProcessVoiceCommandInput {
  transcript: string;
  sessionId?: string | null;
}

interface VoiceActionResult {
  type:
    | 'session_started'
    | 'session_scheduled'
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

// ─── Conversation memory ──────────────────────────────────────────────────────

interface VoiceTurn {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  action?: VoiceAction;
}

// In-memory ring buffer: sessionKey → last 20 turns
const voiceHistory = new Map<string, VoiceTurn[]>();
const HISTORY_LIMIT = 20;

function sessionKey(sessionId: string | null): string {
  return sessionId || 'voice-assistant';
}

/**
 * Add a turn to the in-memory buffer and persist it to the DB.
 */
function addVoiceTurn(key: string, turn: VoiceTurn): void {
  const history = voiceHistory.get(key) ?? [];
  history.push(turn);
  // Keep only last HISTORY_LIMIT turns
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  voiceHistory.set(key, history);

  // Persist asynchronously — DB write is fire-and-forget
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO voice_turns (session_key, role, text, action) VALUES (?, ?, ?, ?)'
    ).run(key, turn.role, turn.text, turn.action ?? null);
  } catch { /* non-fatal */ }
}

/**
 * Load recent turns from DB into the in-memory buffer.
 * Called once per session key on first access.
 */
function loadVoiceHistory(key: string): void {
  if (voiceHistory.has(key)) return; // already loaded
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT role, text, action, strftime('%s', created_at) * 1000 as ts
       FROM voice_turns
       WHERE session_key = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(key, HISTORY_LIMIT) as { role: string; text: string; action: string | null; ts: string }[];

    // Rows are DESC — reverse to chronological
    const turns: VoiceTurn[] = rows.reverse().map(r => ({
      role: r.role as 'user' | 'model',
      text: r.text,
      timestamp: Number(r.ts),
      action: (r.action as VoiceAction | null) ?? undefined,
    }));

    voiceHistory.set(key, turns);
  } catch {
    voiceHistory.set(key, []);
  }
}

/**
 * Return the last N turns as a Gemini multi-turn `contents` array.
 */
function getHistoryAsContents(key: string, limit = 10): Array<{ role: string; parts: { text: string }[] }> {
  const history = voiceHistory.get(key) ?? [];
  return history.slice(-limit).map(turn => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));
}

/**
 * Return a human-readable recent context string for the intent parser prompt.
 * Uses last 3 exchanges (up to 6 turns).
 */
function getRecentContextText(key: string): string {
  const history = voiceHistory.get(key) ?? [];
  if (!history.length) return '';

  const recent = history.slice(-6);
  const lines = recent.map(t => `${t.role === 'user' ? 'User' : 'Guardian'}: ${t.text}`);
  return `\nRECENT CONVERSATION:\n${lines.join('\n')}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Heuristic intent parser (offline fallback) ───────────────────────────────

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

  if (/(schedule|remind me|plan a session|set a session|i want to study|i'll work on|i plan to)/.test(lower)) {
    let intendedStartAt: number | undefined;
    const atTimeMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    const inHoursMatch = lower.match(/in\s+(\d+)\s*hours?/);
    if (atTimeMatch) {
      let hour = parseInt(atTimeMatch[1], 10);
      const minute = atTimeMatch[2] ? parseInt(atTimeMatch[2], 10) : 0;
      const meridiem = atTimeMatch[3];
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      const d = new Date();
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
      intendedStartAt = d.getTime();
    } else if (inHoursMatch) {
      intendedStartAt = Date.now() + parseInt(inHoursMatch[1], 10) * 3_600_000;
    }

    const topic = transcript
      .replace(/^(hey\s+lifeos[, ]*)/i, '')
      .replace(/(schedule|remind me|plan a session|set a session|i want to study|i'll work on|i plan to)/gi, '')
      .replace(/at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
      .replace(/in\s+\d+\s*hours?/gi, '')
      .replace(/for\s+\d+\s*(minute|min|hour|hr)s?/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || undefined;

    return { action: 'schedule_session', topic, durationMinutes, intendedStartAt };
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

// ─── Cloud intent parser (context-aware, multi-turn) ─────────────────────────

async function parseGuardianVoiceIntent(transcript: string, historyKey: string): Promise<ParsedVoiceIntent> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return heuristicParseVoiceIntent(transcript);
  }

  try {
    const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);

    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const localTimeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

    // UIL gives the parser full user context: goals, topics, energy, patterns
    const contextBlock = getIntelligenceContext({ maxInsights: 0, includeToday: true, includeThresholds: false });

    // Recent conversation context — so "do that again" or "change to 90 minutes" resolves correctly
    const recentContext = getRecentContextText(historyKey);

    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: `You are the LifeOS Guardian intent parser. Extract structured intent from the user's voice transcript.

CURRENT TIME: ${localTimeStr} (Unix ms: ${nowMs}, ISO: ${nowIso})
TIMEZONE: Asia/Kolkata (IST, UTC+5:30)
${contextBlock}
${recentContext}

TRANSCRIPT: "${sanitizedTranscript}"

RULES:
- Resolve all relative times ("today", "tonight", "in 2 hours", "at 5:30pm") to absolute Unix ms using the current time above.
- If the user says "from X to Y", compute durationMinutes as (Y - X) in minutes.
- For topic, extract the clean study/work subject. If it matches an active goal or task, use that exact name.
- durationMinutes: derive from explicit duration ("for 2 hours" = 120) or start/end range ("5:30 to 7:30" = 120). Default 60.
- mood: infer from words like "tired", "energised", "rough day". Default null.
- intendedStartAt: Unix ms. 0 if not specified.
- responseText: only for "tutor" or "unknown" actions — a brief direct answer.
- If the transcript references something from RECENT CONVERSATION (e.g. "that topic", "same duration", "remind me again"), resolve it using context.

OUTPUT JSON only, no markdown:
{
  "action": "start_session" | "schedule_session" | "guardian_status" | "request_override" | "day_briefing" | "tutor" | "unknown",
  "topic": "clean topic string, or empty",
  "durationMinutes": 60,
  "mood": "high" | "medium" | "low" | null,
  "overrideTarget": "url or domain string, or empty",
  "overrideReason": "reason string, or empty",
  "requestedMinutes": 10,
  "intendedStartAt": 0,
  "responseText": ""
}`,
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    });

    const parsed = JSON.parse((result.text || '').trim() || '{}') as Partial<ParsedVoiceIntent>;
    if (!parsed.action) return heuristicParseVoiceIntent(transcript);

    return {
      action: parsed.action,
      topic: parsed.topic || undefined,
      durationMinutes: typeof parsed.durationMinutes === 'number' && parsed.durationMinutes > 0 ? parsed.durationMinutes : undefined,
      mood: normalizeMood(parsed.mood),
      overrideTarget: parsed.overrideTarget || undefined,
      overrideReason: parsed.overrideReason || undefined,
      requestedMinutes: typeof parsed.requestedMinutes === 'number' ? parsed.requestedMinutes : undefined,
      intendedStartAt: typeof parsed.intendedStartAt === 'number' && parsed.intendedStartAt > 0 ? parsed.intendedStartAt : undefined,
      responseText: parsed.responseText || undefined,
    };
  } catch {
    return heuristicParseVoiceIntent(transcript);
  }
}

// ─── Tutor — multi-turn conversation with full history ────────────────────────

async function runTutorMode(
  transcript: string,
  historyKey: string,
  activeSessionId: string | null,
  activeGoalTitles: string[],
  activeTaskTitles: string[],
  sessionTarget: string | null
): Promise<string> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return 'Tutor mode is ready, but cloud reasoning is not available right now.';
  }

  try {
    const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);

    // Build full conversation history for multi-turn
    const historyContents = getHistoryAsContents(historyKey, 12);

    // The current user turn is NOT yet in history — add it as the final turn
    const contents = [
      ...historyContents,
      { role: 'user', parts: [{ text: sanitizedTranscript }] },
    ];

    const uilContext = getIntelligenceContext({ maxInsights: 2, includeToday: true });
    const systemInstruction = [
      'You are the LifeOS Guardian Tutor — a precise, concise coach for deep work sessions.',
      'Answer questions directly. Prefer examples over theory. Keep answers under 100 words unless asked for more.',
      'If the user is building on a prior question, continue that thread seamlessly.',
      `Active session: ${sessionTarget || 'none'}`,
      `Active goals: ${activeGoalTitles.join(', ') || 'none'}`,
      `Active tasks: ${activeTaskTitles.join(', ') || 'none'}`,
      '',
      uilContext,
    ].join('\n');

    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents,
      config: {
        systemInstruction,
        temperature: 0.2,
      },
    });

    return (result.text || '').trim() || 'Tutor mode is ready — ask me anything.';
  } catch {
    return 'I encountered an issue answering that. Try rephrasing?';
  }
}

// ─── Free-form conversation fallback (for unknown intents) ────────────────────

async function runFreeformConversation(
  transcript: string,
  historyKey: string,
  activeSessionId: string | null,
): Promise<string> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return 'I heard you, but could not process that right now.';
  }

  try {
    const sanitizedTranscript = sanitizeTranscriptForCloud(transcript);
    const { activeSession, activeGoals, activeTasks } = getGuardianContext();
    const goalTitles = (Array.isArray(activeGoals) ? activeGoals as Array<{ title: string }> : []).map(g => g.title);
    const taskTitles = (Array.isArray(activeTasks) ? activeTasks as Array<{ title: string }> : []).map(t => t.title);

    const historyContents = getHistoryAsContents(historyKey, 10);
    const contents = [
      ...historyContents,
      { role: 'user', parts: [{ text: sanitizedTranscript }] },
    ];

    const systemInstruction = [
      'You are the LifeOS Guardian — a focus coach with access to the user\'s session context.',
      'If the user asks a general question, answer it using context from the conversation.',
      'If the intent is unclear, ask a single clarifying question.',
      'Keep all responses under 60 words. No bullet points — speak naturally as a voice response.',
      `Current session: ${activeSession?.targetTitle || 'none'}`,
      `Goals: ${goalTitles.join(', ') || 'none'}`,
      `Tasks: ${taskTitles.join(', ') || 'none'}`,
    ].join('\n');

    const result = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents,
      config: {
        systemInstruction,
        temperature: 0.3,
      },
    });

    return (result.text || '').trim() || 'I heard you, but could not map that to an action.';
  } catch {
    return 'I heard you, but encountered an issue processing that.';
  }
}

// ─── Session helpers ──────────────────────────────────────────────────────────

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

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processGuardianVoiceCommand(input: ProcessVoiceCommandInput): Promise<VoiceActionResult> {
  const transcript = input.transcript.trim();
  const activeSessionId = getActiveSessionId(input.sessionId);
  const hKey = sessionKey(activeSessionId);

  // Load history from DB on first access for this session key
  loadVoiceHistory(hKey);

  // Record this user turn before parsing (so the parser can see it in context for the NEXT call)
  addVoiceTurn(hKey, { role: 'user', text: transcript, timestamp: Date.now() });

  // Signal UIL every 5 user turns — voice content enriches study topic tracking
  const turnCount = (voiceHistory.get(hKey) ?? []).filter(t => t.role === 'user').length;
  if (turnCount % 5 === 0) {
    touchIntelligence('voice_turns');
    // Extract semantic memory from recent voice turns (background)
    const recentTurns = (voiceHistory.get(hKey) ?? []).slice(-20).map(t => ({ role: t.role, text: t.text }));
    extractMemoryFromVoice(recentTurns, activeSessionId ?? hKey).catch(() => {});
  }

  const intent = await parseGuardianVoiceIntent(transcript, hKey);

  if (activeSessionId) {
    await emitVoiceEvent(activeSessionId, transcript);
  }

  // ── schedule_session ─────────────────────────────────────────────────────

  if (intent.action === 'schedule_session') {
    if (!intent.topic) {
      const response = 'What topic should I schedule the session for?';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    const intendedStartAt = intent.intendedStartAt || Date.now() + 60 * 60_000;
    const plannedMinutes = intent.durationMinutes || 60;
    const commitment = createSoftWatchCommitment({
      targetTitle: intent.topic,
      intendedStartAt,
      plannedMinutes,
      source: 'voice',
    });

    const startTime = new Date(intendedStartAt);
    const endTime = new Date(intendedStartAt + plannedMinutes * 60_000);
    const startStr = startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const endStr = endTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    if (isCalendarConfigured()) {
      const conflicts = await getConflictingEvents(startTime, endTime);
      if (conflicts.length > 0) {
        const conflictList = conflicts
          .map(e => {
            const s = new Date(e.start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const en = new Date(e.end).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            return `"${e.title}" (${s}–${en})`;
          })
          .join(', ');

        void sendTelegram(
          `⚠️ <b>Schedule Conflict</b>\n\n` +
          `You already have something at that time:\n${conflicts.map(e => `• ${e.title}`).join('\n')}\n\n` +
          `<b>${commitment.targetTitle}</b> (${startStr}–${endStr}) was NOT scheduled. Pick a different time.`
        );

        const response = `You already have ${conflictList} at that time. ${commitment.targetTitle} was not scheduled — pick a different slot.`;
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }
    }

    void (async () => {
      if (isCalendarConfigured()) {
        await createCalendarEvent({
          summary: `📚 ${commitment.targetTitle}`,
          description: `LifeOS Guardian session — ${plannedMinutes} min\nScheduled via voice.`,
          startTime,
          endTime,
          colorId: '9',
        });
      }
      await sendTelegram(
        `📅 <b>Session Scheduled</b>\n\n` +
        `📚 <b>${commitment.targetTitle}</b>\n` +
        `🕐 ${startStr} – ${endStr} (${plannedMinutes} min)\n\n` +
        `I'll remind you 30 min and 15 min before. Calendar event created. 🗓️`
      );
    })();

    const response = `Scheduled. ${commitment.targetTitle} from ${startStr} to ${endStr}. Calendar event created with reminders.`;
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_scheduled', transcript, intent, session: commitment, responseText: response };
  }

  // ── start_session ────────────────────────────────────────────────────────

  if (intent.action === 'start_session' && intent.topic) {
    const session = startGuardianSession({
      topic: intent.topic,
      durationMinutes: intent.durationMinutes || 60,
      mood: intent.mood || null,
      source: 'voice',
    });

    const response = `Starting a guarded session for ${session.targetTitle} for ${session.durationMinutes} minutes.`;
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_started', transcript, intent, session, responseText: response };
  }

  // ── guardian_status ──────────────────────────────────────────────────────

  if (intent.action === 'guardian_status') {
    const session = activeSessionId ? getGuardianSession(activeSessionId) : null;
    const latestScore = session?.focusScoreHistory[session.focusScoreHistory.length - 1] ?? null;
    const responseText = session
      ? `You are ${session.currentClassification === 'distraction' ? 'drifting' : 'currently'} on ${session.targetTitle}. Focus score is ${latestScore ?? 100}.`
      : 'No active guardian session right now.';

    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: intent.action });
    return { type: 'guardian_status', transcript, intent, session, responseText };
  }

  // ── request_override ─────────────────────────────────────────────────────

  if (intent.action === 'request_override') {
    if (!activeSessionId) {
      const response = 'There is no active guardian session to override right now.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const session = getGuardianSession(activeSessionId);
    const targetUrl = intent.overrideTarget || session?.currentUrl;
    if (!targetUrl) {
      const response = 'I need the current blocked target to review that override.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const decision = await adjudicateOverride({
      sessionId: activeSessionId,
      url: targetUrl,
      title: session?.currentTitle || undefined,
      reason: intent.overrideReason || transcript,
      requestedMinutes: intent.requestedMinutes,
    });

    await maybeSpeakVoiceResponse(activeSessionId, decision.explainability, decision.approved ? 'normal' : 'urgent');
    addVoiceTurn(hKey, { role: 'model', text: decision.explainability, timestamp: Date.now(), action: intent.action });
    return { type: 'override_decision', transcript, intent, decision, responseText: decision.explainability };
  }

  // ── day_briefing ─────────────────────────────────────────────────────────

  if (intent.action === 'day_briefing') {
    const briefing = getDayBriefing('default');
    const responseText = `You have ${briefing.recentSessions} recent sessions, an average focus score of ${Math.round(
      briefing.avgFocusScore
    )}, and active goals: ${briefing.activeGoals.join(', ') || 'none yet'}.`;
    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: intent.action });
    return { type: 'day_briefing', transcript, intent, briefing, responseText };
  }

  // ── tutor (multi-turn, context-aware) ────────────────────────────────────

  if (intent.action === 'tutor') {
    const { activeGoals, activeTasks, activeSession } = getGuardianContext();
    const goalTitles = (Array.isArray(activeGoals) ? activeGoals as Array<{ title: string }> : []).map(g => g.title).filter(Boolean);
    const taskTitles = (Array.isArray(activeTasks) ? activeTasks as Array<{ title: string }> : []).map(t => t.title).filter(Boolean);

    const responseText = await runTutorMode(
      transcript,
      hKey,
      activeSessionId,
      goalTitles,
      taskTitles,
      activeSession?.targetTitle ?? null
    );

    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: intent.action });
    return { type: 'tutor_response', transcript, intent, responseText };
  }

  // ── unknown — try free-form conversation before giving up ────────────────

  const responseText = await runFreeformConversation(transcript, hKey, activeSessionId);
  await maybeSpeakVoiceResponse(activeSessionId, responseText);
  addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: 'unknown' });

  return {
    type: 'intent_only',
    transcript,
    intent,
    responseText,
  };
}

/**
 * Clear in-memory history for a session key (call on session end).
 * DB turns are kept for longitudinal memory.
 */
export function clearVoiceHistory(sessionId: string | null): void {
  voiceHistory.delete(sessionKey(sessionId));
}
