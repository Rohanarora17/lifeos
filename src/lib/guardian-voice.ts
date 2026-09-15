import { getDayBriefing } from './longitudinal-engine';
import { getGenAI, generateWithFallback } from './ai';
import { canUseCloudTextReasoning, sanitizeTranscriptForCloud } from './cloud-privacy';
import { MODEL_PRO } from './models';
import { speak } from './tts';
import {
  adjudicateOverride,
  adjustGuardianSessionDuration,
  createSoftWatchCommitment,
  endGuardianSession,
  getActiveGuardianSession,
  getGuardianContext,
  getGuardianSession,
  listGuardianSessions,
  pauseGuardianSession,
  resumeGuardianSession,
  startGuardianSession,
  tickGuardianSession,
} from './guardian-runtime';
import { createCalendarEvent, getConflictingEvents, isCalendarConfigured } from './google-calendar';
import { sendTelegram } from './telegram';
import { getDb } from './db';
import { getIntelligenceContext, getIntelligenceProfile, touchIntelligence } from './intelligence';
import { extractMemoryFromVoice } from './memory-extractor';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { getAdaptiveTaskRecommendations } from './adaptive-task-recommendations';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from './personalization-context';
import { recordAdaptiveHabitCheckin } from './adaptive-habit-checkin';
import { buildAdaptiveTaskDefaults } from './adaptive-task-defaults';
import { getTaskTimeProgress } from './task-time-sessions';
import { generateNextDayPlan, getNextDayPlan, type NextDayPlanPayload } from './next-day-planner';
import { VisionClientUnavailableError } from './guardian-client-status';
import {
  computeFocusSessions,
  computeFocusScore,
  computeConsistencyIndex,
  computeGoalAlignment,
  classifyArchetype,
  recallMemories,
} from './behavior';


// ─── Types ────────────────────────────────────────────────────────────────────

type VoiceAction =
  // ── Session management ──
  | 'start_session'
  | 'adjust_session'
  | 'end_session'
  | 'pause_session'
  | 'resume_session'
  | 'schedule_session'
  | 'reschedule_session'
  | 'cancel_scheduled_session'
  // ── Task management ──
  | 'create_task'          // "add task X"
  | 'create_session_task'  // "schedule 25min session on X for today" → task with task_type='session'
  | 'next_day_plan'        // "what is tomorrow's plan?"
  | 'update_task'          // "mark X done", "prioritize X", "move X to tomorrow"
  | 'delete_task'          // "delete task X" (requires confirm)
  | 'show_tasks'           // "what are my tasks today/this week/high priority"
  | 'clear_done_tasks'     // "clear done tasks" (requires confirm)
  // ── Habit management ──
  | 'log_habit'            // "log meditation", "done with workout"
  | 'create_habit'         // "add a new daily habit: read for 30 min"
  | 'delete_habit'         // "delete habit X" (requires confirm)
  | 'show_habits'          // "how are my habits?"
  // ── Goal management ──
  | 'create_goal'
  | 'update_goal'          // "update progress on X", "mark X complete"
  | 'show_goals'
  | 'archive_all_goals'
  // ── Intelligence & analytics ──
  | 'deep_analysis'        // "analyse my week", "why am I distracted?", "how am I doing?"
  | 'guardian_status'
  | 'day_briefing'
  | 'multi_action'

  // ── Confirmation flow ──
  | 'confirm_pending'
  | 'reject_pending'
  // ── Other ──
  | 'request_override'
  | 'tutor'
  | 'guidance'           // on-demand screen-aware Q&A ("explain this", "help me with this")
  | 'unknown';

interface ParsedVoiceIntent {
  action: VoiceAction;
  // Session fields
  topic?: string;
  durationMinutes?: number;
  mood?: 'high' | 'medium' | 'low' | null;
  intendedStartAt?: number;
  // Override fields
  overrideTarget?: string;
  overrideReason?: string;
  requestedMinutes?: number;
  // Task fields
  taskTitle?: string;
  taskPriority?: string;           // 'low' | 'medium' | 'high'
  taskDueDate?: string;            // YYYY-MM-DD
  taskStatus?: string;             // 'todo'|'doing'|'done'
  taskId?: number;                 // for update/delete by id
  taskFilterScope?: string;        // 'today'|'this_week'|'high_priority'|'blocked'|'all'
  // Habit fields
  habitName?: string;
  habitFrequency?: string;         // 'daily' | 'weekly'
  habitGoalMinutes?: number;       // for time-based habits
  // Goal fields
  goalTitle?: string;
  goalType?: string;               // 'build_feature'|'learn_skill'|'launch_project'|'general'
  goalCategory?: string;
  goalDeadline?: string;           // YYYY-MM-DD
  goalProgressValue?: number;      // for update_goal
  // Analysis fields
  analysisQuery?: string;          // free-form question for deep_analysis
  // Freeform response (tutor / unknown)
  responseText?: string;
  // Multi-action array
  actions?: ParsedVoiceIntent[];
}

interface ProcessVoiceCommandInput {
  transcript: string;
  sessionId?: string | null;
}

interface VoiceActionResult {
  type:
  | 'session_started'
  | 'session_adjusted'
  | 'session_ended'
  | 'session_paused'
  | 'session_resumed'
  | 'habit_logged'
  | 'habit_created'
  | 'habit_deleted'
  | 'task_created'
  | 'task_updated'
  | 'task_deleted'
  | 'goal_created'
  | 'goal_updated'
  | 'tasks_cleared'
  | 'goals_archived'
  | 'session_scheduled'
  | 'guardian_status'
  | 'override_decision'
  | 'day_briefing'
  | 'deep_analysis'
  | 'tutor_response'
  | 'guidance_response'
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

// Pending confirmation state: destructive actions queue here until user confirms
interface PendingAction {
  action: VoiceAction;
  description: string; // human-readable: "delete 7 done tasks"
  payload: Record<string, unknown>;
}
const pendingActions = new Map<string, PendingAction>(); // historyKey → pending

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
 * Merges the last 3 session turns + last 4 TG turns for cross-channel continuity.
 */
function getRecentContextText(key: string): string {
  const sessionHistory = voiceHistory.get(key) ?? [];
  const tgHistory = voiceHistory.get('telegram') ?? [];

  if (!sessionHistory.length && !tgHistory.length) return '';

  const lines: string[] = [];

  // Recent TG turns (last 4) — prefixed so parser knows channel
  if (tgHistory.length) {
    const recentTg = tgHistory.slice(-4);
    recentTg.forEach(t => lines.push(`[TG] ${t.role === 'user' ? 'User' : 'Jarvis'}: ${t.text}`));
  }

  // Recent voice turns (last 6)
  if (sessionHistory.length) {
    const recentSession = sessionHistory.slice(-6);
    recentSession.forEach(t => lines.push(`${t.role === 'user' ? 'User' : 'Guardian'}: ${t.text}`));
  }

  return lines.length ? `\nRECENT CONVERSATION:\n${lines.join('\n')}` : '';
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

function buildVoicePersonalization(activeSessionId?: string | null): PersonalizationSnapshot {
  const session = activeSessionId ? getGuardianSession(activeSessionId) : null;
  const focusScore = session?.focusScoreHistory?.at(-1) ?? null;
  const elapsedMinutes = session ? Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)) : 0;

  return buildPersonalizationSnapshot({
    surface: 'voice',
    maxInsights: 2,
    includeMemoryFacts: 4,
    activeSession: session ? {
      sessionId: session.sessionId,
      targetTitle: session.targetTitle,
      focusScore,
      elapsedMinutes,
    } : null,
  });
}

function voiceModeLabel(snapshot: PersonalizationSnapshot): string {
  if (snapshot.moment.mode === 'recovery') return 'Low-energy mode';
  if (snapshot.moment.mode === 'deadline_pressure') return 'Deadline mode';
  if (snapshot.moment.mode === 'protect_focus') return 'Protected-focus mode';
  if (snapshot.moment.mode === 'planning') return 'Planning mode';
  return 'Balanced mode';
}

function voiceSessionNudge(snapshot: PersonalizationSnapshot): string {
  if (snapshot.moment.mode === 'recovery') return 'Keep it small and concrete.';
  if (snapshot.moment.mode === 'deadline_pressure') return 'Use the next move for deadline relief.';
  if (snapshot.moment.mode === 'protect_focus') return 'Stay with the current thread.';
  if (snapshot.moment.mode === 'planning') return 'Use this to set up the next clean step.';
  return snapshot.moment.guidance;
}

function voiceScheduleClarification(snapshot: PersonalizationSnapshot, missing: 'topic' | 'time' | 'both'): string {
  const ask = missing === 'topic'
    ? 'What should I schedule?'
    : missing === 'time'
      ? 'What time should I move it to?'
      : 'What should I schedule, and when should it start?';
  if (snapshot.today.plannedFocus.nextTitle) {
    return `${ask} You already have planned focus on ${snapshot.today.plannedFocus.nextTitle}${snapshot.today.plannedFocus.nextMinutes ? ` for ${snapshot.today.plannedFocus.nextMinutes} minutes` : ''}.`;
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return `${ask} Keep the block small enough for today's energy.`;
  }
  if (snapshot.moment.mode === 'deadline_pressure') return `${ask} Pick the slot that relieves the nearest deadline first.`;
  if (snapshot.moment.mode === 'planning') return `${ask} Prefer a concrete anchor for tomorrow's plan.`;
  if (snapshot.userState.nextBestFocusWindow) return `${ask} Your learned best focus window is ${snapshot.userState.nextBestFocusWindow}.`;
  return ask;
}

function voiceNoActiveSessionLine(snapshot: PersonalizationSnapshot, action: 'adjust' | 'pause' | 'resume' | 'override' | 'status'): string {
  if (snapshot.today.plannedFocus.nextTitle) {
    return `No active session right now. Next planned focus is ${snapshot.today.plannedFocus.nextTitle}; start that or schedule a different block.`;
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return 'No active session right now. If you start one, keep it small and low-friction.';
  }
  if (snapshot.moment.mode === 'deadline_pressure') return 'No active session right now. Start the deadline-relief block before optional work.';
  if (snapshot.moment.mode === 'planning') return 'No active session right now. Use this moment to lock tomorrow\'s first block.';
  if (action === 'resume' && snapshot.userState.nextBestFocusWindow) {
    return `No paused session found. Start the next useful block near ${snapshot.userState.nextBestFocusWindow}.`;
  }
  if (action === 'resume') return `No paused session found. ${snapshot.moment.guidance}`;
  return 'No active session right now. Start the next useful block when you are ready.';
}

function voiceTasksEmptyLine(snapshot: PersonalizationSnapshot, scope: string): string {
  const label = scope.replace('_', ' ');
  if (snapshot.today.plannedFocus.nextTitle) {
    return `No ${label} tasks in the voice queue. The current planned focus is ${snapshot.today.plannedFocus.nextTitle}.`;
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return `No ${label} tasks right now. Add one small time target only if today still needs a minimum win.`;
  }
  if (snapshot.moment.mode === 'deadline_pressure') return `No ${label} tasks right now. Add the nearest deadline-relief task first.`;
  if (snapshot.moment.mode === 'planning') return `No ${label} tasks right now. Turn tomorrow's intention into a scheduled block.`;
  return `No ${label} tasks right now. Add the next measurable time target when ready.`;
}

function voiceGoalsEmptyLine(snapshot: PersonalizationSnapshot): string {
  if (snapshot.userState.standupGoal) return `No active goals to archive. Today's stated goal is still ${snapshot.userState.standupGoal}.`;
  if (snapshot.moment.mode === 'deadline_pressure') return 'No active goals to archive. Add the deadline goal first so tasks can rank around it.';
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return 'No active goals to archive. Keep any new goal shrinkable for low-capacity days.';
  }
  if (snapshot.moment.mode === 'planning') return 'No active goals to archive. Planning mode needs a goal only if it clarifies tomorrow.';
  return 'No active goals to archive. Add one durable anchor when you know what the system should optimize for.';
}

function voiceEntityLookupPrompt(
  snapshot: PersonalizationSnapshot,
  kind: 'habit' | 'task' | 'goal',
  action: 'log' | 'update',
): string {
  const verb = action === 'log' ? 'log' : 'update';
  const lowCapacity = snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low';

  if (kind === 'habit') {
    if (lowCapacity) return 'Which low-friction habit should I log?';
    if (snapshot.moment.mode === 'planning') return 'Which habit should I log for tomorrow setup?';
    if (snapshot.today.plannedFocus.nextTitle) return `Which habit should I log around ${snapshot.today.plannedFocus.nextTitle}?`;
    return 'Which habit should I log? Tell me the name.';
  }

  if (kind === 'task') {
    if (snapshot.today.plannedFocus.nextTitle) return `Which task should I ${verb}? Planned focus is ${snapshot.today.plannedFocus.nextTitle}.`;
    if (snapshot.moment.mode === 'deadline_pressure') return `Which deadline-relief task should I ${verb}?`;
    if (lowCapacity) return `Which small or recovery-safe task should I ${verb}?`;
    if (snapshot.userState.nextBestFocusWindow) return `Which task should I ${verb}? Your learned best focus window is ${snapshot.userState.nextBestFocusWindow}.`;
    return `Which task should I ${verb}?`;
  }

  if (snapshot.userState.standupGoal) return `Which goal should I ${verb}? Today's stated goal is ${snapshot.userState.standupGoal}.`;
  if (snapshot.moment.mode === 'deadline_pressure') return `Which deadline goal should I ${verb}?`;
  if (snapshot.moment.mode === 'planning') return `Which tomorrow-facing goal should I ${verb}?`;
  if (lowCapacity) return `Which low-pressure goal should I ${verb}?`;
  return `Which goal should I ${verb}?`;
}

function voiceCompletionLine(snapshot: PersonalizationSnapshot, elapsed: number): string {
  if (snapshot.moment.mode === 'recovery') return `Session ended after ${elapsed} minutes. That counts as a recovery-sized win.`;
  if (snapshot.moment.mode === 'deadline_pressure') return `Session ended after ${elapsed} minutes. Capture the next deadline step while it is still fresh.`;
  if (snapshot.moment.mode === 'protect_focus') return `Session ended after ${elapsed} minutes. Good protected block.`;
  if (snapshot.moment.mode === 'planning') return `Session ended after ${elapsed} minutes. Use the notes to set up tomorrow.`;
  return `Session ended after ${elapsed} minutes. Good work.`;
}

function tomorrowIsoDate(): string {
  return new Date(Date.now() + 19800000 + 86_400_000).toISOString().slice(0, 10);
}

function formatVoiceNextDayPlan(plan: NextDayPlanPayload): string {
  const date = plan.plan?.plan_date ?? tomorrowIsoDate();
  const context = [
    plan.plan?.wake_estimate ? `wake ${plan.plan.wake_estimate}` : null,
    plan.plan?.sleep_time ? `sleep ${plan.plan.sleep_time}` : null,
    `${plan.personalization.energy} energy`,
    plan.personalization.bestFocusWindow ? `best window ${plan.personalization.bestFocusWindow}` : null,
  ].filter(Boolean).join(', ');

  if (plan.sessions.length === 0) {
    return `Tomorrow, ${date}, has no focus blocks yet. ${context}. Tell me sleep, wake, mood, and the one task to protect.`;
  }

  const firstBlocks = plan.sessions.slice(0, 3).map(session => {
    const time = new Date(session.planned_start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${time}, ${session.title} for ${session.duration_minutes} minutes`;
  });
  const extra = plan.sessions.length > 3 ? `, plus ${plan.sessions.length - 3} more` : '';
  return `Tomorrow, ${date}: ${firstBlocks.join('; ')}${extra}. ${context}.`;
}

// ─── Heuristic intent parser (offline fallback, session-aware) ──────────────

function heuristicParseVoiceIntent(transcript: string): ParsedVoiceIntent {
  const lower = transcript.toLowerCase().trim();
  const durationMatch = lower.match(/(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs)/);

  let durationMinutes: number | undefined;
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2];
    durationMinutes = unit.startsWith('hour') || unit.startsWith('hr') ? value * 60 : value;
  }

  // Check live session — determines adjust vs start
  const liveSession = getActiveGuardianSession();
  const hasActiveSession = !!liveSession;

  if (/(how am i doing|guardian status|status|am i focused|focus score)/.test(lower)) {
    return { action: 'guardian_status', durationMinutes };
  }

  if (/(day briefing|brief me|what's the plan today|today's plan|today plan)/.test(lower)) {
    return { action: 'day_briefing', durationMinutes };
  }

  if (/(tomorrow'?s plan|tomorrow plan|plan tomorrow|next day plan|what'?s planned tomorrow)/.test(lower)) {
    return { action: 'next_day_plan' };
  }

  if (/(what are my tasks|show( me)? tasks|task list|tasks today|today'?s tasks|what should i work on)/.test(lower)) {
    const taskFilterScope = /high priority|urgent|important/.test(lower)
      ? 'high_priority'
      : /blocked|stuck/.test(lower)
        ? 'blocked'
        : /week|this week/.test(lower)
          ? 'this_week'
          : 'today';
    return { action: 'show_tasks', taskFilterScope };
  }

  if (/(override|allow this|let me use|unblock|i need this site)/.test(lower)) {
    return {
      action: 'request_override',
      requestedMinutes: durationMinutes,
      overrideReason: transcript,
    };
  }

  // guidance — screen-aware on-demand Q&A ("explain this", "what is this", "help me with")
  if (/(explain this|what is this|help me with this|what am i looking at|what does this (mean|do|say)|show me how|help me debug|what('s| is) going on here)/.test(lower)) {
    return { action: 'guidance' };
  }

  if (/(tutor|teach me|explain|help me understand|how do i solve)/.test(lower)) {
    return { action: 'tutor' };
  }

  // end_session — must check before adjust/start to avoid conflict
  if (/(stop session|end session|cancel session|we're done|i'm done|that's enough|stop the session)/.test(lower)) {
    return { action: 'end_session' };
  }

  // adjust_session — only if a session exists AND a new duration is mentioned
  if (hasActiveSession && durationMinutes && /(change|adjust|make it|reduce|cut|extend|set it to|update)/.test(lower)) {
    return { action: 'adjust_session', durationMinutes };
  }

  // Pause / resume
  if (/(taking a break|take a break|pause session|\bpause\b|brb|stepping out|step away)/.test(lower)) {
    return { action: 'pause_session' };
  }
  if (/(i'?m back|i am back|\bresume\b|let'?s continue|back at it|back to work|continuing)/.test(lower)) {
    return { action: 'resume_session' };
  }

  if (/(schedule|plan a session|set a session|i want to study|i'll work on|i plan to)/.test(lower)) {
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
      .replace(/(schedule|plan a session|set a session|i want to study|i'll work on|i plan to)/gi, '')
      .replace(/at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
      .replace(/in\s+\d+\s*hours?/gi, '')
      .replace(/for\s+\d+\s*(minute|min|hour|hr)s?/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || undefined;

    return { action: 'schedule_session', topic, durationMinutes, intendedStartAt };
  }

  if (/(lock in|start session|focus session|study session|we need to finish|today we have to finish)/.test(lower)) {
    // If a session is already active — treat as adjust if duration mentioned, else status
    if (hasActiveSession && durationMinutes) return { action: 'adjust_session', durationMinutes };
    if (hasActiveSession) return { action: 'guardian_status' };

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

  // Log habit
  const habitLogMatch = lower.match(/(?:log|mark|done with|completed?|finished?)\s+(?:my\s+)?(.+?)(?:\s+habit)?(?:\s+today)?$/);
  if (habitLogMatch && /(log|mark|done with|completed?|finished?)/.test(lower)) {
    return { action: 'log_habit', habitName: habitLogMatch[1].trim() };
  }

  // Create task
  const taskMatch = lower.match(/(?:add task|create task|note:|remind me to|add to my list)\s*[:.\-]?\s*(.+)/);
  if (taskMatch) {
    return { action: 'create_task', taskTitle: taskMatch[1].trim() };
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

    // Recent conversation context — ESSENTIAL: allows "do that", "no don't", corrections
    const recentContext = getRecentContextText(historyKey);

    // Pending action — tells parser if we're awaiting confirmation
    const pending = pendingActions.get(historyKey);
    const pendingBlock = pending
      ? `PENDING CONFIRMATION: "${pending.description}" — if user confirms (yes/go ahead/do it/confirm) use action=confirm_pending. If user cancels (no/stop/cancel/don't) use action=reject_pending.`
      : '';

    // Live session state
    const liveSession = getActiveGuardianSession();
    const sessionBlock = liveSession
      ? [
        'ACTIVE SESSION:',
        `  topic:     "${liveSession.targetTitle}"`,
        `  elapsed:   ${Math.max(0, Math.round((Date.now() - liveSession.startedAt) / 60_000))} min`,
        `  remaining: ${Math.max(0, liveSession.durationMinutes - Math.round((Date.now() - liveSession.startedAt) / 60_000))} min (of ${liveSession.durationMinutes} planned)`,
        `  focus:     ${liveSession.focusScoreHistory.at(-1) ?? 100}/100`,
        `  state:     ${liveSession.state}`,
      ].join('\n')
      : 'ACTIVE SESSION: none';

    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: `You are the LifeOS Guardian — an extremely intelligent, conversational personal AI assistant that manages every aspect of a person's productivity, habits, tasks, goals and self-improvement. You understand multi-turn voice conversations and always reason from full context.

CURRENT TIME: ${localTimeStr} (Unix ms: ${nowMs}, ISO: ${nowIso})
TIMEZONE: Asia/Kolkata (IST, UTC+5:30)
${sessionBlock}
${contextBlock}
${recentContext}
${pendingBlock}

TRANSCRIPT: "${sanitizedTranscript}"

━━━ ACTIONS ━━━

SESSION:
- start_session: Start a new live focus session RIGHT NOW. ONLY if user explicitly says "start", "lock in", "let's begin" on a topic+duration. topic, durationMinutes, mood.
- adjust_session: Change duration/topic of the ACTIVE session. durationMinutes = new total.
- end_session: Stop current session.
- pause_session / resume_session: Temporary break/return.
- schedule_session: Schedule a session for a FUTURE time. topic, durationMinutes, intendedStartAt (unix ms).
- reschedule_session: Reschedule an existing upcoming scheduled session. topic, durationMinutes (optional), intendedStartAt (unix ms, new time).
- cancel_scheduled_session: Cancel an existing upcoming scheduled session. topic.

TASK MANAGEMENT (full CRUD):
- create_task: Plain task (not session-linked). taskTitle, taskPriority (low/medium/high), taskDueDate (YYYY-MM-DD).
- create_session_task: "Schedule a 25min session on Polkadot for today" → creates a task with type=session and estimated_minutes. Fields: taskTitle (topic), durationMinutes (the session length), taskDueDate (when to do it, YYYY-MM-DD). This is the primary way to plan work.
- next_day_plan: Show tomorrow's adaptive plan and planned focus sessions. Prefer this when the user asks for tomorrow's plan, next-day plan, or what is scheduled tomorrow.
- update_task: Modify an existing task. taskTitle (name to search), taskStatus (todo/doing/done), taskPriority (low/medium/high), taskDueDate. Use when user says "mark X done", "move X to tomorrow", "prioritize X", "block X".
- delete_task: Delete a specific task by name. taskTitle. Requires confirm — set responseText asking.
- show_tasks: Read current tasks. taskFilterScope: "today" | "this_week" | "high_priority" | "blocked" | "all". Default "today".
- clear_done_tasks: Archive all done tasks. Requires confirm — set responseText asking.

HABIT MANAGEMENT (full CRUD):
- log_habit: Mark a habit as done today. habitName.
- create_habit: Add a new habit. habitName, habitFrequency (daily/weekly), habitGoalMinutes (for time-based, else 0).
- delete_habit: Remove a habit permanently. habitName. Requires confirm — set responseText asking.
- show_habits: See habit list + today's completion status.

GOAL MANAGEMENT:
- create_goal: New goal/objective. goalTitle, goalType (build_feature/learn_skill/launch_project/general), goalCategory (study/work/health/personal), goalDeadline (YYYY-MM-DD, end of stated period).
- update_goal: Update progress or status. goalTitle, goalProgressValue (0-100 percent).
- show_goals: List current goals.
- archive_all_goals: Archive everything. Requires confirm — set responseText asking.

INTELLIGENCE & ANALYTICS (all voice-accessible):
- deep_analysis: User asks about patterns, behaviour, why they're distracted, weekly review, goal progress analysis, focus trends, memory insights, coaching. analysisQuery = the core question verbatim.
- guardian_status: Live session status + focus score + UIL coaching.
- day_briefing: Today's session count, focus avg, habits, tasks summary.

CONFIRMATION:
- confirm_pending: User says yes/go ahead/do it/yeah/confirm.
- reject_pending: User says no/cancel/stop/don't/never mind.

KNOWLEDGE:
- guidance: User asks about what is on their screen RIGHT NOW — "explain this", "what is this", "what am I looking at", "help me with this", "what does this mean", "help me debug this". This uses the live screen capture.
- tutor: User asks a general academic/technical question NOT specifically about what is on screen.
- request_override: Unblock a blocked site. overrideTarget, overrideReason, requestedMinutes.
- unknown: Nothing fits. Use responseText for a short helpful reply.

━━━ RULES ━━━
1. DO NOT start_session unless explicitly asked. "I want to focus on X" = create_session_task.
2. DO NOT schedule_session unless a future time is mentioned. Same day = create_session_task. Tomorrow planning questions = next_day_plan.
3. Destructive ops (delete_task, clear_done_tasks, archive_all_goals, delete_habit): set that action AND set responseText asking for confirmation. System queues it as pending.
4. Resolve "that", "it", "same topic" from RECENT CONVERSATION context.
5. "mark X done" = update_task with taskStatus=done, but completion only succeeds if linked focus minutes have reached the task target. "block X" = update_task with taskStatus=doing.
6. Responses ≤ 35 words. No filler. Voice only.
7. If user gives a complex multi-step command, handle step 1 and signal what comes next.

━━━ JSON OUTPUT ━━━
{
  "action": "<action>",
  "topic": "",
  "durationMinutes": 0,
  "mood": null,
  "intendedStartAt": 0,
  "overrideTarget": "",
  "overrideReason": "",
  "requestedMinutes": 0,
  "taskTitle": "",
  "taskPriority": "medium",
  "taskDueDate": null,
  "taskStatus": "",
  "taskFilterScope": "today",
  "habitName": "",
  "habitFrequency": "daily",
  "habitGoalMinutes": 0,
  "goalTitle": "",
  "goalCategory": "study",
  "goalDeadline": null,
  "goalProgressValue": 0,
  "analysisQuery": "",
  "responseText": ""
}`,
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    }, { feature: 'voice_intent' });

    const parsed = JSON.parse((result.text || '').trim() || '{}') as Partial<ParsedVoiceIntent>;
    if (!parsed.action) return heuristicParseVoiceIntent(transcript);

    const p = parsed as Record<string, unknown>;
    return {
      action: parsed.action,
      topic: (p.topic as string) || undefined,
      durationMinutes: typeof p.durationMinutes === 'number' && (p.durationMinutes as number) > 0 ? p.durationMinutes as number : undefined,
      mood: normalizeMood(parsed.mood),
      intendedStartAt: typeof p.intendedStartAt === 'number' && (p.intendedStartAt as number) > 0 ? p.intendedStartAt as number : undefined,
      overrideTarget: (p.overrideTarget as string) || undefined,
      overrideReason: (p.overrideReason as string) || undefined,
      requestedMinutes: typeof p.requestedMinutes === 'number' ? p.requestedMinutes as number : undefined,
      responseText: (p.responseText as string) || undefined,
      taskTitle: (p.taskTitle as string) || undefined,
      taskPriority: (p.taskPriority as string) || undefined,
      taskDueDate: (p.taskDueDate as string) || undefined,
      taskStatus: (p.taskStatus as string) || undefined,
      taskFilterScope: (p.taskFilterScope as string) || undefined,
      habitName: (p.habitName as string) || undefined,
      habitFrequency: (p.habitFrequency as string) || undefined,
      habitGoalMinutes: typeof p.habitGoalMinutes === 'number' ? p.habitGoalMinutes as number : undefined,
      goalTitle: (p.goalTitle as string) || undefined,
      goalCategory: (p.goalCategory as string) || undefined,
      goalDeadline: (p.goalDeadline as string) || undefined,
      goalProgressValue: typeof p.goalProgressValue === 'number' ? p.goalProgressValue as number : undefined,
      analysisQuery: (p.analysisQuery as string) || undefined,
    };
  } catch {
    return heuristicParseVoiceIntent(transcript);
  }
}

// ─── Guidance — screen-aware on-demand Q&A ────────────────────────────────────

async function runGuidanceMode(
  transcript: string,
  activeSessionId: string | null,
): Promise<string> {
  const { assembleGuidanceResponse } = await import('./screen-guidance');

  // For voice-triggered guidance: no screenshot available (PTT doesn't capture),
  // but we still have the session screenContext (rolling observations, narrative)
  const guidance = await assembleGuidanceResponse({
    sessionId: activeSessionId,
    question: transcript,
    source: 'voice',
  });

  return guidance.spokenAnswer || guidance.answer || 'I could not find enough context to answer that.';
}

// ─── Tutor — multi-turn conversation with full history ────────────────────────

function voiceTutorUnavailableLine(snapshot: PersonalizationSnapshot): string {
  if (snapshot.today.plannedFocus.nextTitle) {
    return `Tutor mode needs cloud reasoning right now. For ${snapshot.today.plannedFocus.nextTitle}, capture the exact concept you want explained and I will pick it back up when reasoning is available.`;
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return 'Tutor mode needs cloud reasoning right now. Keep the question small and write the confusing term down so this stays recovery-safe.';
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return 'Tutor mode needs cloud reasoning right now. Save the blocker as the next deadline question instead of widening the search.';
  }
  if (snapshot.moment.mode === 'planning') {
    return 'Tutor mode needs cloud reasoning right now. Put this question into tomorrow\'s first learning block.';
  }
  return 'Tutor mode needs cloud reasoning right now. Capture the question and continue with the next concrete step.';
}

async function runTutorMode(
  transcript: string,
  historyKey: string,
  activeSessionId: string | null,
  activeGoalTitles: string[],
  activeTaskTitles: string[],
  sessionTarget: string | null,
  personalization: PersonalizationSnapshot,
): Promise<string> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return voiceTutorUnavailableLine(personalization);
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
      model: MODEL_PRO,
      contents,
      config: {
        systemInstruction,
        temperature: 0.2,
      },
    }, { feature: 'voice_tutor' });

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
    const personalization = buildVoicePersonalization(activeSessionId);
    const personalizationContext = formatPersonalizationContext(personalization);

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
      personalizationContext,
    ].join('\n');

    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents,
      config: {
        systemInstruction,
        temperature: 0.3,
      },
    }, { feature: 'voice_conversation' });

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
  const personalization = buildVoicePersonalization(activeSessionId);

  // Load history from DB on first access for this session key
  loadVoiceHistory(hKey);
  loadVoiceHistory('telegram'); // cross-channel: make TG context available to parser

  // Record this user turn before parsing (so the parser can see it in context for the NEXT call)
  addVoiceTurn(hKey, { role: 'user', text: transcript, timestamp: Date.now() });

  // Signal UIL every 5 user turns — voice content enriches study topic tracking
  const turnCount = (voiceHistory.get(hKey) ?? []).filter(t => t.role === 'user').length;
  if (turnCount % 5 === 0) {
    touchIntelligence('voice_turns');
    // Extract semantic memory from recent voice turns (background)
    const recentTurns = (voiceHistory.get(hKey) ?? []).slice(-20).map(t => ({ role: t.role, text: t.text }));
    extractMemoryFromVoice(recentTurns, activeSessionId ?? hKey).catch(() => { });
  }

  const intent = await parseGuardianVoiceIntent(transcript, hKey);

  if (activeSessionId) {
    await emitVoiceEvent(activeSessionId, transcript);
  }

  // ── next_day_plan ────────────────────────────────────────────────────────

  if (intent.action === 'next_day_plan') {
    try {
      const planDate = tomorrowIsoDate();
      let plan = getNextDayPlan(planDate);
      if (!plan.plan || plan.sessions.length === 0) {
        plan = await generateNextDayPlan({
          planDate,
          syncCalendar: false,
          regenerate: true,
        });
      }
      const response = formatVoiceNextDayPlan(plan);
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch (err) {
      console.error('[GuardianVoice] next_day_plan failed:', err);
      const response = 'Could not load tomorrow’s plan right now.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── schedule_session ─────────────────────────────────────────────────────

  if (intent.action === 'schedule_session') {
    if (!intent.topic) {
      const response = voiceScheduleClarification(personalization, 'topic');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    const intendedStartAt = intent.intendedStartAt || Date.now() + 60 * 60_000;
    const plannedMinutes = getAdaptiveSessionMinutes(intent.durationMinutes);
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
        const eventId = await createCalendarEvent({
          summary: `📚 ${commitment.targetTitle}`,
          description: `LifeOS Guardian session — ${plannedMinutes} min\nScheduled via voice.`,
          startTime,
          endTime,
          colorId: '9',
        });
        if (eventId) {
          const { attachCalendarEventId } = await import('./guardian-runtime');
          attachCalendarEventId(commitment.id, eventId);
        }
      }
      await sendTelegram(
        `📅 <b>Session Scheduled</b>\n\n` +
        `📚 <b>${commitment.targetTitle}</b>\n` +
        `🕐 ${startStr} – ${endStr} (${plannedMinutes} min)\n\n` +
        `Calendar reminders were adapted to your current day. 🗓️`
      );
    })();

    const response = `Scheduled. ${commitment.targetTitle} from ${startStr} to ${endStr} for ${plannedMinutes} minutes. ${voiceModeLabel(personalization)} shaped that duration and the calendar reminders.`;
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_scheduled', transcript, intent, session: commitment, responseText: response };
  }

  // ── reschedule_session ───────────────────────────────────────────────────

  if (intent.action === 'reschedule_session') {
    if (!intent.topic || !intent.intendedStartAt) {
      const resp = voiceScheduleClarification(personalization, !intent.topic && !intent.intendedStartAt ? 'both' : !intent.topic ? 'topic' : 'time');
      addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: resp };
    }
    const { listSoftWatchCommitments, rescheduleSoftWatchCommitmentWithCalendar } = await import('./guardian-runtime');
    const comms = listSoftWatchCommitments();
    const search = intent.topic.toLowerCase();
    const match = comms.find(c => c.targetTitle.toLowerCase().includes(search));
    
    if (!match) {
      const resp = `I couldn't find a scheduled session matching ${intent.topic}.`;
      addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: resp };
    }
    
    const rescheduled = await rescheduleSoftWatchCommitmentWithCalendar(match.id, intent.intendedStartAt, intent.durationMinutes);
    if (!rescheduled.ok) {
      const resp = `I couldn't reschedule ${match.targetTitle}. Please try again.`;
      addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: resp };
    }
    const dateStr = new Date(intent.intendedStartAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const calendarLine = rescheduled.calendarStatus === 'synced'
      ? 'Calendar synced.'
      : rescheduled.calendarStatus === 'failed'
        ? 'LifeOS was updated, but calendar sync failed.'
        : 'Saved in LifeOS; no linked calendar event was configured.';
    const resp = `Done. I've rescheduled ${match.targetTitle} to ${dateStr}. ${calendarLine}`;
    addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
    return { type: 'session_scheduled', transcript, intent, session: match, responseText: resp };
  }

  // ── cancel_scheduled_session ─────────────────────────────────────────────

  if (intent.action === 'cancel_scheduled_session') {
    if (!intent.topic) {
      const resp = personalization.today.plannedFocus.nextTitle
        ? `Which upcoming session do you want to cancel? Planned focus currently points at ${personalization.today.plannedFocus.nextTitle}.`
        : voiceScheduleClarification(personalization, 'topic');
      addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: resp };
    }
    const { listSoftWatchCommitments, dismissSoftWatchCommitment } = await import('./guardian-runtime');
    const comms = listSoftWatchCommitments();
    const search = intent.topic.toLowerCase();
    const match = comms.find(c => c.targetTitle.toLowerCase().includes(search));
    
    if (!match) {
      const resp = `I couldn't find a scheduled session matching ${intent.topic}.`;
      addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: resp };
    }
    
    dismissSoftWatchCommitment(match.id);
    const resp = `Got it. I've cancelled ${match.targetTitle} and removed it from your calendar.`;
    addVoiceTurn(hKey, { role: 'model', text: resp, timestamp: Date.now(), action: intent.action });
    return { type: 'session_scheduled', transcript, intent, session: match, responseText: resp };
  }

  // ── adjust_session ────────────────────────────────────────────────────────

  if (intent.action === 'adjust_session') {
    if (!activeSessionId) {
      const response = voiceNoActiveSessionLine(personalization, 'adjust');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const newDuration = intent.durationMinutes;
    if (!newDuration || newDuration < 1) {
      const response = personalization.moment.mode === 'recovery' || personalization.userState.energy === 'low' || personalization.userState.mood === 'low'
        ? 'What smaller duration should I use for this low-capacity window?'
        : personalization.moment.mode === 'deadline_pressure'
          ? 'What duration gives enough deadline relief without drifting?'
          : 'What duration should I change the session to?';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const adjusted = adjustGuardianSessionDuration(activeSessionId, newDuration);
    if (!adjusted) {
      const response = 'Could not find the active session to adjust.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const elapsed = Math.max(0, Math.round((Date.now() - adjusted.startedAt) / 60_000));
    const remaining = Math.max(0, newDuration - elapsed);
    const response = `${voiceModeLabel(personalization)}. Session adjusted to ${newDuration} minutes; ${remaining} minutes remaining. ${voiceSessionNudge(personalization)}`;
    await maybeSpeakVoiceResponse(activeSessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_adjusted', transcript, intent, session: adjusted, responseText: response };
  }

  // ── end_session ───────────────────────────────────────────────────────────

  if (intent.action === 'end_session') {
    if (!activeSessionId) {
      const response = 'There is no active session to end.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    const ended = endGuardianSession(activeSessionId);
    const elapsed = ended ? Math.max(1, Math.round((Date.now() - (ended as { startedAt: number }).startedAt) / 60_000)) : 0;
    const response = voiceCompletionLine(personalization, elapsed);
    await maybeSpeakVoiceResponse(activeSessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_ended', transcript, intent, session: ended, responseText: response };
  }

  // ── pause_session ─────────────────────────────────────────────────────────

  if (intent.action === 'pause_session') {
    if (!activeSessionId) {
      const response = voiceNoActiveSessionLine(personalization, 'pause');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    pauseGuardianSession(activeSessionId);
    const response = personalization.moment.mode === 'recovery'
      ? 'Session paused. Take the reset without guilt; come back with one small next step.'
      : `Session paused. ${voiceSessionNudge(personalization)}`;
    await maybeSpeakVoiceResponse(activeSessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_paused', transcript, intent, responseText: response };
  }

  // ── resume_session ────────────────────────────────────────────────────────

  if (intent.action === 'resume_session') {
    if (!activeSessionId) {
      const response = voiceNoActiveSessionLine(personalization, 'resume');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    resumeGuardianSession(activeSessionId);
    const session = getGuardianSession(activeSessionId);
    const remaining = session ? Math.max(0, session.durationMinutes - Math.round((Date.now() - session.startedAt) / 60_000)) : 0;
    const response = `Welcome back. ${remaining} minutes remaining on ${session?.targetTitle || 'your session'}. ${voiceSessionNudge(personalization)}`;
    await maybeSpeakVoiceResponse(activeSessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_resumed', transcript, intent, responseText: response };
  }

  // ── log_habit ─────────────────────────────────────────────────────────────

  if (intent.action === 'log_habit') {
    const habitName = intent.habitName?.trim();
    if (!habitName) {
      const response = voiceEntityLookupPrompt(personalization, 'habit', 'log');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    try {
      const db = getDb();
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const habit = db.prepare(
        `SELECT id, name FROM habits WHERE archived = 0 AND LOWER(name) LIKE ? LIMIT 1`
      ).get(`%${habitName.toLowerCase()}%`) as { id: number; name: string } | undefined;

      if (!habit) {
        const response = `I couldn't find a habit matching "${habitName}". Check the name and try again.`;
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }

      const checkin = recordAdaptiveHabitCheckin({
        habitId: habit.id,
        date: today,
        source: 'voice',
        forceComplete: true,
      });

      const response = personalization.moment.mode === 'recovery'
        ? `Logged ${habit.name}. ${checkin.adaptiveIntensity ?? 'minimum'} target today: ${checkin.value}/${checkin.adaptiveTarget}.`
        : `Logged ${habit.name}. ${checkin.value}/${checkin.adaptiveTarget}. ${voiceSessionNudge(personalization)}`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'habit_logged', transcript, intent, responseText: response };
    } catch {
      const response = 'Failed to log the habit. Try again in a moment.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── update_task ───────────────────────────────────────────────────────────

  if (intent.action === 'update_task') {
    const taskTitle = intent.taskTitle?.trim();
    if (!taskTitle) {
      const response = voiceEntityLookupPrompt(personalization, 'task', 'update');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    try {
      const db = getDb();
      const task = db.prepare(`
        SELECT id, title, status
        FROM tasks
        WHERE LOWER(title) LIKE ? AND status != 'done'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(`%${taskTitle.toLowerCase()}%`) as { id: number; title: string; status: string } | undefined;

      if (!task) {
        const response = `I couldn't find an active task matching ${taskTitle}.`;
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }

      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      const status = intent.taskStatus && ['todo', 'doing', 'done'].includes(intent.taskStatus)
        ? intent.taskStatus
        : null;

      if (status === 'done') {
        const progress = getTaskTimeProgress(task.id);
        if (progress.targetMinutes === null) {
          const response = `${task.title} needs a time target before it can complete. Add the target, then finish linked focus sessions against it.`;
          await maybeSpeakVoiceResponse(activeSessionId, response);
          addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
          return { type: 'intent_only', transcript, intent, responseText: response };
        }
        if (progress.creditedMinutes < progress.targetMinutes) {
          const response = `${task.title} stays active: ${progress.remainingMinutes} minutes more linked focus time needed.`;
          await maybeSpeakVoiceResponse(activeSessionId, response);
          addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
          return { type: 'intent_only', transcript, intent, responseText: response };
        }
        sets.push("status = 'done'");
        sets.push("completed_at = datetime('now')");
      } else if (status) {
        sets.push('status = ?');
        vals.push(status);
        sets.push('completed_at = NULL');
      }

      if (intent.taskPriority && ['low', 'medium', 'high', 'critical'].includes(intent.taskPriority)) {
        sets.push('priority = ?');
        vals.push(intent.taskPriority);
      }
      if (intent.taskDueDate !== undefined) {
        sets.push('due_date = ?');
        vals.push(intent.taskDueDate || null);
      }

      if (sets.length === 0) {
        const response = `No update values provided for ${task.title}.`;
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }

      sets.push("updated_at = datetime('now')");
      vals.push(task.id);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      touchIntelligence(status === 'done' ? 'voice_task_completion_checked' : 'voice_task_updated');

      const response = status === 'done'
        ? `Completed ${task.title} by its linked focus time target.`
        : `Updated ${task.title}.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch (err) {
      console.error('[GuardianVoice] update_task failed:', err);
      const response = 'Could not update that task right now.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── show_tasks ─────────────────────────────────────────────

  if (intent.action === 'show_tasks') {
    try {
      const db = getDb();
      const scope = intent.taskFilterScope || 'today';
      const adaptiveTasks = getAdaptiveTaskRecommendations(personalization, 10);
      const blockedTasks = scope === 'blocked'
        ? db.prepare(`
          SELECT id, title, priority, status, due_date
          FROM tasks
          WHERE status IN ('todo','doing') AND blocked_since IS NOT NULL
          ORDER BY blocked_since ASC
          LIMIT 7
        `).all() as { id: number; title: string; priority: string; status: string; due_date: string | null }[]
        : [];
      const tasks = scope === 'blocked'
        ? blockedTasks.map(task => ({
          title: task.title,
          priority: task.priority,
          status: task.status,
          dueDate: task.due_date,
          reason: 'blocked and needs a decision',
        }))
        : adaptiveTasks
          .filter(task => {
            if (scope === 'high_priority') return task.priority === 'high' || task.priority === 'critical';
            if (scope === 'this_week') return true;
            return true;
          })
          .slice(0, 7)
          .map(task => ({
            title: task.title,
            priority: task.priority,
            status: task.status,
            dueDate: null,
            reason: task.reason,
          }));

      let response: string;
      if (tasks.length === 0) {
        response = voiceTasksEmptyLine(personalization, scope);
      } else {
        const taskLines = tasks.map((t, i) => {
          const dueStr = t.dueDate ? `, due ${t.dueDate}` : '';
          const prioStr = t.priority === 'critical' || t.priority === 'high' ? ` [${t.priority}]` : '';
          const reasonStr = t.reason ? ` — ${t.reason}` : '';
          return `${i + 1}. ${t.title}${prioStr}${dueStr}${reasonStr}`;
        });
        response = `${voiceModeLabel(personalization)}. I would use this order: ${taskLines.join('; ')}.`;
      }
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch {
      const response = 'Could not load tasks right now.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── show_goals ─────────────────────────────────────────────

  if (intent.action === 'show_goals') {
    try {
      const db = getDb();
      const goals = db.prepare(`
        SELECT g.title, g.category, g.deadline,
               COUNT(t.id) as total_tasks,
               SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_tasks
        FROM goals g
        LEFT JOIN tasks t ON t.goal_id = g.id
        WHERE g.active = 1 AND (g.archived = 0 OR g.archived IS NULL)
        GROUP BY g.id
        ORDER BY g.created_at DESC
        LIMIT 5
      `).all() as { title: string; category: string; deadline: string | null; total_tasks: number; done_tasks: number }[];

      let response: string;
      if (goals.length === 0) {
        response = 'You have no active goals right now.';
      } else {
        const goalLines = goals.map((g, i) => {
          const pct = g.total_tasks > 0 ? Math.round((g.done_tasks / g.total_tasks) * 100) : 0;
          const progressStr = g.total_tasks > 0 ? `, ${pct}% done` : '';
          const deadlineStr = g.deadline ? `, due ${g.deadline}` : '';
          return `${i + 1}. ${g.title}${progressStr}${deadlineStr}`;
        });
        response = `You have ${goals.length} active goal${goals.length > 1 ? 's' : ''}: ${goalLines.join('; ')}.`;
      }
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch {
      const response = 'Could not load goals right now.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── create_session_task ──────────────────────────────────────────────────

  if (intent.action === 'create_session_task') {
    const taskTitle = intent.taskTitle?.trim();
    if (!taskTitle) {
      const response = 'What should the session be called?';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    try {
      const db = getDb();
      const defaults = buildAdaptiveTaskDefaults({
        title: taskTitle,
        taskType: 'session',
        dueDate: intent.taskDueDate || null,
        explicitEstimateMinutes: intent.durationMinutes,
        snapshot: personalization,
      });
      const duration = defaults.estimatedMinutes;
      const result = db.prepare(
        `INSERT INTO tasks (title, status, priority, task_type, estimated_minutes, energy_required, due_date) VALUES (?, 'todo', ?, 'session', ?, ?, ?)`
      ).run(taskTitle, defaults.priority, duration, defaults.energyRequired, intent.taskDueDate || null);
      const taskId = Number(result.lastInsertRowid);
      try { const { autoLinkTaskToGoal } = await import('./task-auto-linker'); autoLinkTaskToGoal(taskId).catch(() => { }); } catch { /* ignore */ }
      
      const response = `Scheduled session task: ${taskTitle} for ${duration} minutes. ${defaults.priority} priority, ${defaults.energyRequired} energy. ${defaults.reason}.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'task_created', transcript, intent, responseText: response };
    } catch {
      const response = 'Failed to create session task. Try again.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── clear_done_tasks (asks confirmation first) ─────────────────────

  if (intent.action === 'clear_done_tasks') {
    try {
      const db = getDb();
      const count = (db.prepare(`SELECT COUNT(*) as n FROM tasks WHERE status = 'done'`).get() as { n: number }).n;
      if (count === 0) {
        const response = 'No done tasks to clear.';
        await maybeSpeakVoiceResponse(activeSessionId, response);
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }
      pendingActions.set(hKey, { action: 'clear_done_tasks', description: `delete ${count} done tasks`, payload: {} });
      const response = intent.responseText || `You have ${count} done tasks. Should I delete them all?`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch {
      const response = 'Could not read task list.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── update_goal ──────────────────────────────────────────────────────────

  if (intent.action === 'update_goal') {
    const goalTitle = intent.goalTitle?.trim();
    if (!goalTitle) {
      const response = voiceEntityLookupPrompt(personalization, 'goal', 'update');
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    const db = getDb();
    const goal = db.prepare(`SELECT id, title FROM goals WHERE LOWER(title) LIKE ? AND archived = 0 LIMIT 1`).get(`%${goalTitle.toLowerCase()}%`) as { id: number; title: string } | undefined;
    if (!goal) {
      const response = `Goal matching ${goalTitle} not found.`;
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (intent.goalProgressValue !== undefined) {
      sets.push('progress_value = ?');
      vals.push(intent.goalProgressValue);
    }
    if (intent.goalDeadline !== undefined) {
      sets.push('deadline = ?');
      vals.push(intent.goalDeadline);
    }
    
    if (sets.length > 0) {
      vals.push(goal.id);
      db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const response = `Updated goal: ${goal.title}.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } else {
      const response = `No update values provided for goal ${goal.title}.`;
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── archive_all_goals (asks confirmation first) ───────────────────

  if (intent.action === 'archive_all_goals') {
    try {
      const db = getDb();
      const count = (db.prepare(`SELECT COUNT(*) as n FROM goals WHERE archived = 0`).get() as { n: number }).n;
      if (count === 0) {
        const response = voiceGoalsEmptyLine(personalization);
        await maybeSpeakVoiceResponse(activeSessionId, response);
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
        return { type: 'intent_only', transcript, intent, responseText: response };
      }
      pendingActions.set(hKey, { action: 'archive_all_goals', description: `archive all ${count} active goals`, payload: {} });
      const response = intent.responseText || `You have ${count} active goals. Archive all of them?`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    } catch {
      const response = 'Could not read goals.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── confirm_pending ─────────────────────────────────────────

  if (intent.action === 'confirm_pending') {
    const pending = pendingActions.get(hKey);
    if (!pending) {
      const response = 'Nothing pending to confirm.';
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    pendingActions.delete(hKey);
    const db = getDb();

    if (pending.action === 'clear_done_tasks') {
      const deleted = db.prepare(`DELETE FROM tasks WHERE status = 'done'`).run();
      const response = `Done. Removed ${deleted.changes} completed tasks.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'tasks_cleared', transcript, intent, responseText: response };
    }

    if (pending.action === 'archive_all_goals') {
      const archived = db.prepare(`UPDATE goals SET archived = 1, active = 0 WHERE archived = 0 OR active = 1`).run();
      const response = archived.changes > 0
        ? `Done. Archived ${archived.changes} goal${archived.changes > 1 ? 's' : ''}. They're gone from the dashboard — refresh the page if they're still showing. You're starting fresh.`
        : `Nothing to archive — no active goals found. Ready for new ones whenever you are.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'goals_archived', transcript, intent, responseText: response };
    }

    if (pending.action === 'delete_task') {
      const taskId = pending.payload.taskId as number | undefined;
      if (taskId) {
        db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
        const response = `Done. Task deleted.`;
        await maybeSpeakVoiceResponse(activeSessionId, response);
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
        return { type: 'task_deleted', transcript, intent, responseText: response };
      }
    }

    if (pending.action === 'delete_habit') {
      const habitId = pending.payload.habitId as number | undefined;
      if (habitId) {
        db.prepare(`UPDATE habits SET archived = 1 WHERE id = ?`).run(habitId);
        const response = `Done. Habit archived.`;
        await maybeSpeakVoiceResponse(activeSessionId, response);
        addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
        return { type: 'habit_deleted', transcript, intent, responseText: response };
      }
    }

    const response = 'Done.';
    await maybeSpeakVoiceResponse(activeSessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
    return { type: 'intent_only', transcript, intent, responseText: response };
  }

  // ── create_goal ─────────────────────────────────────────────

  if (intent.action === 'create_goal') {
    const goalTitle = intent.goalTitle?.trim();
    if (!goalTitle) {
      const response = 'What should the goal be called?';
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    const type = intent.goalType?.trim();
    if (!type || !['build_feature', 'learn_skill', 'launch_project', 'general'].includes(type)) {
      const response = `What type of goal is "${goalTitle}"? Options are: build feature, learn skill, launch project, or general.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    try {
      const db = getDb();
      const safeCategory = ['study', 'work', 'health', 'personal'].includes(intent.goalCategory ?? '') ? intent.goalCategory : 'study';
      db.prepare(
        `INSERT INTO goals (title, type, category, deadline, archived, active) VALUES (?, ?, ?, ?, 0, 1)`
      ).run(goalTitle, type, safeCategory, intent.goalDeadline ?? null);
      // Auto-link existing tasks to this goal
      try { const { autoLinkAllUnlinkedTasks } = await import('./task-auto-linker'); autoLinkAllUnlinkedTasks().catch(() => { }); } catch { /* non-fatal */ }
      const deadlineStr = intent.goalDeadline ? `, deadline ${intent.goalDeadline}` : '';
      const response = `Goal created: "${goalTitle}"${deadlineStr}. What tasks should I add for it?`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'goal_created', transcript, intent, responseText: response };
    } catch {
      const response = 'Failed to create the goal.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── create_task ───────────────────────────────────────────────────────────

  if (intent.action === 'create_task') {
    const taskTitle = intent.taskTitle?.trim();
    if (!taskTitle) {
      const response = 'What should I call the task?';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    try {
      const db = getDb();
      const defaults = buildAdaptiveTaskDefaults({
        title: taskTitle,
        taskType: 'task',
        dueDate: intent.taskDueDate ?? null,
        explicitPriority: intent.taskPriority,
        snapshot: personalization,
      });
      const result = db.prepare(
        `INSERT INTO tasks (title, status, priority, task_type, due_date, estimated_minutes, energy_required) VALUES (?, 'todo', ?, 'task', ?, ?, ?)`
      ).run(taskTitle, defaults.priority, intent.taskDueDate ?? null, defaults.estimatedMinutes, defaults.energyRequired);
      const taskId = Number(result.lastInsertRowid);
      // Background: auto-link to goal and re-rank
      try { const { autoLinkTaskToGoal } = await import('./task-auto-linker'); autoLinkTaskToGoal(taskId).catch(() => { }); } catch { /* non-fatal */ }
      try { const { triggerPrioritize } = await import('./task-priority-ranker'); triggerPrioritize(); } catch { /* non-fatal */ }

      const dueStr = intent.taskDueDate ? `, due ${intent.taskDueDate}` : '';
      const response = `Task added: "${taskTitle}"${dueStr}. ${defaults.priority} priority, ${defaults.estimatedMinutes} minutes, ${defaults.energyRequired} energy. ${defaults.reason}.`;
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'task_created', transcript, intent, responseText: response };
    } catch {
      const response = 'Failed to create the task. Try again.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── start_session ────────────────────────────────────────────────────────

  if (intent.action === 'start_session' && intent.topic) {
    let session;
    try {
      session = startGuardianSession({
        topic: intent.topic,
        durationMinutes: intent.durationMinutes ? getAdaptiveSessionMinutes(intent.durationMinutes) : undefined,
        mood: intent.mood || null,
        source: 'voice',
        sessionContext: transcript, // full voice utterance carries nuance: "I'll be switching tabs", tools, etc.
      });
    } catch (error) {
      if (!(error instanceof VisionClientUnavailableError)) throw error;
      const response = error.readiness.screenRecordingStatus !== 'authorized'
        ? 'I cannot start Guardian until LifeOSCopilot has Screen Recording permission on the MacBook.'
        : 'I cannot start Guardian because the MacBook vision client is offline. Open LifeOSCopilot and try again.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }

    // Proactive coaching: speak top UIL insight with the session start confirmation
    const profile = getIntelligenceProfile();
    const topInsight = profile.coachingInsights?.[0];
    const response = `Starting a guarded session for ${session.targetTitle} for ${session.durationMinutes} minutes. ${voiceSessionNudge(personalization)}` +
      (topInsight ? ` ${topInsight}` : '');
    await maybeSpeakVoiceResponse(session.sessionId, response);
    addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
    return { type: 'session_started', transcript, intent, session, responseText: response };
  }

  // ── deep_analysis (full intelligence + behavior query) ──────────────

  if (intent.action === 'deep_analysis') {
    const query = (intent.analysisQuery || transcript).trim();
    const ai = getGenAI();
    if (!ai || !canUseCloudTextReasoning()) {
      const response = 'Deep analysis needs cloud reasoning. Check your API key.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
    try {
      // Pull everything the brain knows
      const profile = getIntelligenceProfile();
      const contextBlock = getIntelligenceContext({ maxInsights: 5, includeToday: true, includeThresholds: true });
      // Focus score last 7 days
      const focusTrend: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() + 19800000 - i * 86400000).toISOString().slice(0, 10);
        try {
          const sessions = computeFocusSessions(d);
          const score = computeFocusScore(sessions);
          focusTrend.push(`${d}: ${Math.round(score.score)}/100`);
        } catch { focusTrend.push(`${d}: n/a`); }
      }
      // Consistency + archetype
      let consistencyStr = 'n/a';
      let archetypeStr = 'n/a';
      let goalAlignStr = 'n/a';
      let memoriesStr = 'n/a';
      try { const c = computeConsistencyIndex(14); consistencyStr = `${Math.round(c.overallScore)}% overall (${c.streakDays}d streak, ${c.trend})`; } catch { /* */ }
      try { const a = classifyArchetype(14); archetypeStr = `${a.primary} — ${a.description}`; } catch { /* */ }
      try { const g = computeGoalAlignment(); goalAlignStr = `${Math.round(g.alignmentScore * 100)}% aligned`; } catch { /* */ }
      try { const mems = recallMemories(undefined, 10).map(m => m.content).join('; '); memoriesStr = mems || 'none'; } catch { /* */ }

      const db = getDb();
      const recentSessions = db.prepare(`
        SELECT target_title, elapsed_minutes, final_focus_score AS focus_score, completed_at
        FROM guardian_session_summaries
        WHERE date(completed_at, 'localtime') >= date('now', '-7 days', 'localtime')
        ORDER BY completed_at DESC LIMIT 8
      `).all() as { target_title: string; elapsed_minutes: number; focus_score: number; completed_at: string }[];
      const sessionsStr = recentSessions.map(s =>
        `${s.completed_at.slice(0, 10)}: ${s.target_title} (${s.elapsed_minutes}min, score ${Math.round(s.focus_score)})`
      ).join('\n');

      let cognitiveGrounding = '';
      try {
        const { formatCognitiveSelfAnswerForPrompt, isCognitiveSelfQuestion, buildCognitiveSelfAnswer } =
          await import('./cognitive-self-answer');
        if (isCognitiveSelfQuestion(query)) {
          // Prefer deterministic grounded answer for self-map questions (no invented patterns)
          const grounded = buildCognitiveSelfAnswer(query);
          const response = grounded.plainText.replace(/\n+/g, ' ').slice(0, 400);
          await maybeSpeakVoiceResponse(activeSessionId, response);
          addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
          return { type: 'deep_analysis', transcript, intent, responseText: response };
        }
        cognitiveGrounding = formatCognitiveSelfAnswerForPrompt(query);
      } catch { /* cognitive map optional */ }

      const analysisPrompt = `You are LifeOS's deep intelligence layer. Answer this exact question from the user with brutally honest, data-driven insights.

USER QUESTION: "${query}"

DATA YOU HAVE:
${contextBlock}

${cognitiveGrounding}

FOCUS TREND (7 days):
${focusTrend.join('\n')}

RECENT SESSIONS:
${sessionsStr || 'No recent sessions.'}

CONSISTENCY: ${consistencyStr}
ARCHETYPE: ${archetypeStr}
GOAL ALIGNMENT: ${goalAlignStr}
MEMORY PATTERNS: ${memoriesStr}
COACHING INSIGHTS: ${profile.coachingInsights?.join('; ') || 'none'}

RESPOND: Voice-friendly, direct, 2-4 sentences. No bullet lists. Refer to specific data. Be a great coach. If COGNITIVE SELF-ANSWER is present, do not invent patterns that contradict it.`;

      const result = await generateWithFallback(ai, { model: MODEL_PRO, contents: analysisPrompt, config: { temperature: 0.3 } }, { feature: 'voice_session_analysis' });
      const response = (result.text || '').trim().replace(/[•\*\-] /g, '').replace(/\n+/g, ' ').slice(0, 300);
      await maybeSpeakVoiceResponse(activeSessionId, response);
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now(), action: intent.action });
      return { type: 'deep_analysis', transcript, intent, responseText: response };
    } catch {
      const response = 'Could not run deep analysis right now. Try again.';
      addVoiceTurn(hKey, { role: 'model', text: response, timestamp: Date.now() });
      return { type: 'intent_only', transcript, intent, responseText: response };
    }
  }

  // ── guardian_status ──────────────────────────────────────────────────────

  if (intent.action === 'guardian_status') {
    const session = activeSessionId ? getGuardianSession(activeSessionId) : null;
    const profile = getIntelligenceProfile();
    const latestScore = session?.focusScoreHistory[session.focusScoreHistory.length - 1] ?? null;

    let responseText: string;
    if (session) {
      const elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000));
      const remaining = Math.max(0, session.durationMinutes - elapsed);
      const classification = session.currentClassification === 'distraction' ? 'drifting' : 'focused';
      const topInsight = profile.coachingInsights?.[0];
      responseText = `You're ${classification} on ${session.targetTitle}. ` +
        `Focus score ${latestScore ?? 100}. ${elapsed} minutes in, ${remaining} remaining.` +
        (topInsight ? ` ${topInsight}` : '');
    } else {
      const topInsight = profile.coachingInsights?.[0];
      const nextWindow = profile.nextBestFocusWindow;
      responseText = voiceNoActiveSessionLine(personalization, 'status') +
        (nextWindow ? ` Best focus window: ${nextWindow}.` : '') +
        (topInsight ? ` ${topInsight}` : '');
    }

    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: intent.action });
    return { type: 'guardian_status', transcript, intent, session, responseText };
  }

  // ── request_override ─────────────────────────────────────────────────────

  if (intent.action === 'request_override') {
    if (!activeSessionId) {
      const response = voiceNoActiveSessionLine(personalization, 'override');
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

  // ── guidance (screen-aware, triggered by "explain this" / "what is this") ──

  if (intent.action === 'guidance') {
    const responseText = await runGuidanceMode(transcript, activeSessionId);
    await maybeSpeakVoiceResponse(activeSessionId, responseText);
    addVoiceTurn(hKey, { role: 'model', text: responseText, timestamp: Date.now(), action: intent.action });
    return { type: 'guidance_response', transcript, intent, responseText };
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
      activeSession?.targetTitle ?? null,
      personalization,
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
