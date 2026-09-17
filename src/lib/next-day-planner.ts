import { randomUUID } from 'crypto';
import { getDb, getSetting } from './db';
import { getCalendarEvents } from './calendar';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  isCalendarConfigured,
  updateCalendarEvent,
} from './google-calendar';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import {
  buildPersonalizationSnapshot,
  refreshCognitiveOnSnapshot,
  formatPersonalizationContext,
  type PersonalizationSnapshot,
} from './personalization-context';
import { getIntelligenceContext } from './intelligence';
import { getAdaptiveRewardDecision, getAdaptiveTaskRewardBase } from './adaptive-rewards';
import type { PlannerExperimentBias } from './cognitive-experiments';
import {
  getCombinedPlannerBias,
  getVoluntaryRewardMultiplier,
  taskMatchesCoachBias,
} from './cognitive-active-coach';
import { tryGetGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import {
  reconcilePlanningState,
  type PlanningReconciliationOutcome,
} from './planning-reconciliation';
import {
  extractTypedPlanConstraints,
  interpretPlanningContext,
  stripConstraintText,
  type PlannerCalendarEvent,
  type TypedPlanConstraint,
} from './planner-context';

export { extractTypedPlanConstraints, interpretPlanningContext } from './planner-context';

type SessionStatus = 'planned' | 'started' | 'completed' | 'skipped' | 'cancelled';

type CalendarEventRow = PlannerCalendarEvent;

export interface PlanningLoadSlice {
  sessionCount: number;
  focusedMinutes: number;
  averageFocusScore: number | null;
  sessionTitles: string[];
}

export interface PlanningFocusLoad {
  currentPlanningDay: PlanningLoadSlice;
  last24Hours: PlanningLoadSlice;
}

export interface PlanningDayContext {
  relation: 'today' | 'tomorrow' | 'future' | 'past';
  windowStart: string;
  windowEnd: string;
  spansMidnight: boolean;
  signals: string[];
  ignoredCalendarEventIds: string[];
  focusLoad: PlanningFocusLoad;
}

interface LLMProposedTask {
  title: string;
  sourceQuote: string;
}

interface LLMConstraintSpec {
  title: string;
  startIso: string;
  endIso: string;
  sourceQuote: string;
}

interface LLMPlannedSessionSpec {
  title: string;
  startIso: string;
  endIso: string;
  durationMinutes: number;
  sessionType?: 'problem_practice' | 'research_reading' | 'coding_build' | 'study';
  reason?: string;
  taskId?: number | null;
  proposedTask?: LLMProposedTask | null;
}

interface LLMPlannerSynthesis {
  constraints: LLMConstraintSpec[];
  focusSessions: LLMPlannedSessionSpec[];
  reasoning?: string;
}

const ALLOWED_SESSION_TYPES = new Set(['problem_practice', 'research_reading', 'coding_build', 'study']);

export function validatePlannerSynthesis(input: {
  result: LLMPlannerSynthesis;
  freshText: string;
  candidateTaskIds: number[];
  windowStart: Date;
  windowEnd: Date;
  notBefore: Date | null;
  calendarEvents: CalendarEventRow[];
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const freshText = input.freshText.trim();
  const candidateIds = new Set(input.candidateTaskIds);
  if (!Array.isArray(input.result.constraints) || !Array.isArray(input.result.focusSessions)) {
    return { valid: false, errors: ['planner result must contain constraints[] and focusSessions[]'] };
  }

  const constraintEvents: CalendarEventRow[] = [];
  for (const constraint of input.result.constraints) {
    const sourceQuote = constraint.sourceQuote?.trim();
    if (!sourceQuote || !freshText.includes(sourceQuote)) {
      errors.push(`invented source quote for constraint ${constraint.title || '<untitled>'}`);
    }
    const start = new Date(constraint.startIso);
    const end = new Date(constraint.endIso);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      errors.push(`invalid constraint time for ${constraint.title || '<untitled>'}`);
    } else {
      constraintEvents.push({ title: constraint.title, start_time: constraint.startIso, end_time: constraint.endIso });
    }
  }

  for (const session of input.result.focusSessions) {
    if (!session.sessionType || !ALLOWED_SESSION_TYPES.has(session.sessionType)) {
      errors.push(`unknown session type for ${session.title || '<untitled>'}`);
    }
    const existingTask = typeof session.taskId === 'number' && candidateIds.has(session.taskId);
    const proposed = session.proposedTask;
    const groundedProposal = Boolean(
      proposed?.title?.trim()
      && proposed.sourceQuote?.trim()
      && freshText.includes(proposed.sourceQuote.trim())
    );
    if (!existingTask && !groundedProposal) {
      errors.push(`missing or invalid task linkage for ${session.title || '<untitled>'}`);
    }
    if (proposed && !groundedProposal) {
      errors.push(`invented source quote for proposed task ${proposed.title || '<untitled>'}`);
    }
  }

  const temporal = validatePlannedSessionSpecs({
    specs: input.result.focusSessions,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    notBefore: input.notBefore,
    calendarEvents: [...input.calendarEvents, ...constraintEvents],
  });
  for (const rejected of temporal.rejected) errors.push(`${rejected.spec.title}: ${rejected.reason}`);

  const sorted = input.result.focusSessions
    .map(session => ({ session, start: new Date(session.startIso), end: new Date(session.endIso) }))
    .filter(item => Number.isFinite(item.start.getTime()) && Number.isFinite(item.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) {
      errors.push(`${sorted[index].session.title}: overlaps another focus session`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validatePlannedSessionSpecs(input: {
  specs: LLMPlannedSessionSpec[];
  windowStart: Date;
  windowEnd: Date;
  notBefore: Date | null;
  calendarEvents: CalendarEventRow[];
}): {
  valid: LLMPlannedSessionSpec[];
  rejected: Array<{ spec: LLMPlannedSessionSpec; reason: string }>;
} {
  const valid: LLMPlannedSessionSpec[] = [];
  const rejected: Array<{ spec: LLMPlannedSessionSpec; reason: string }> = [];

  for (const spec of input.specs) {
    const start = new Date(spec.startIso);
    const end = new Date(spec.endIso);
    let reason: string | null = null;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      reason = 'invalid time range';
    } else if (start < input.windowStart || end > input.windowEnd) {
      reason = 'outside wake-to-sleep planning window';
    } else if (input.notBefore && start < input.notBefore) {
      reason = 'before live replanning boundary';
    } else {
      const conflict = input.calendarEvents.find(event => {
        const eventStart = new Date(event.start_time);
        const eventEnd = new Date(event.end_time);
        return start < eventEnd && end > eventStart;
      });
      if (conflict) reason = `overlaps ${conflict.title}`;
    }

    if (reason) rejected.push({ spec, reason });
    else valid.push(spec);
  }
  return { valid, rejected };
}

async function synthesizePlanWithLLM(input: {
  planDate: string;
  intention: string | null;
  eveningNotes: string | null;
  sleepTime: string;
  wakeEstimate: string;
  calendarEvents: CalendarEventRow[];
  candidateTasks: CandidateTask[];
  snapshot: PersonalizationSnapshot;
  focusLoad: PlanningFocusLoad;
  appliedSignals: string[];
  notBefore: Date | null;
  freshText: string;
}): Promise<LLMPlannedSessionSpec[] | null> {
  const ai = tryGetGenAI();
  if (!ai) return null;

  const uilContext = getIntelligenceContext({ maxInsights: 3, includeToday: true, includeThresholds: true });
  const personalizationContext = formatPersonalizationContext(input.snapshot);

  const prompt = `You are the LifeOS AI Next-Day Planning Engine.
Your job is to read the user's natural language intention, evening notes, class schedule, and unified cognitive profile, then synthesize an intelligent, highly realistic focus session schedule for tomorrow.

DATE: ${input.planDate}
USER SLEEP WINDOW: Sleep around ${input.sleepTime}, Wake around ${input.wakeEstimate}.
USER INTENTION FOR TOMORROW: "${input.intention || 'None'}"
EVENING NOTES / TODAY'S REFLECTION: "${input.eveningNotes || 'None'}"
APPLIED CONTEXT: ${input.appliedSignals.length ? input.appliedSignals.join('; ') : 'No explicit overrides'}
EARLIEST ALLOWED NEW START: ${input.notBefore?.toISOString() ?? 'Start of the wake-to-sleep planning window'}

=== RECENT FOCUS LOAD (USE AS CAPACITY EVIDENCE) ===
- Current wake-to-sleep planning day: ${input.focusLoad.currentPlanningDay.sessionCount} sessions, ${input.focusLoad.currentPlanningDay.focusedMinutes} focused minutes, average focus ${input.focusLoad.currentPlanningDay.averageFocusScore ?? 'unknown'}.
- Rolling last 24 hours: ${input.focusLoad.last24Hours.sessionCount} sessions, ${input.focusLoad.last24Hours.focusedMinutes} focused minutes, average focus ${input.focusLoad.last24Hours.averageFocusScore ?? 'unknown'}.
- Recent targets: ${input.focusLoad.last24Hours.sessionTitles.join(', ') || 'none'}.

=== UNIFIED INTELLIGENCE LAYER (SHARED COGNITIVE MODEL) ===
${personalizationContext}

${uilContext}

=== EFFECTIVE FIXED CALENDAR COMMITMENTS (USER-IGNORED EVENTS ARE ALREADY REMOVED) ===
${input.calendarEvents.length > 0 ? input.calendarEvents.map(e => `- ${e.title}: ${e.start_time} to ${e.end_time}`).join('\n') : '- No fixed calendar commitments'}

=== CANDIDATE TASKS / WORKLOAD ===
${input.candidateTasks.map(t => `- [ID:${t.id}] ${t.title} (${t.remaining_minutes}m target, ${t.priority} priority, ${t.reason})`).join('\n')}

CRITICAL INSTRUCTIONS FOR NATURAL LANGUAGE SCHEDULE REASONING:
1. Parse the user's intention and notes carefully for specific time constraints, preferences, or routines (e.g. "free at 11pm", "work 11pm to 2am", "study in morning gaps", "gym at 8 then dinner").
2. DO NOT schedule sessions during times the user said they are busy, tired, at the gym, or eating dinner.
3. If the user explicitly requested late-night work (e.g. 11pm to 2am) or morning gaps, YOU MUST schedule sessions during those exact requested time windows!
4. Align session placement with the Shared Cognitive Model's peak focus hours, learned energy patterns, and risk thresholds.
5. Treat recent completed focus as real cognitive load. Do not reschedule work already credited, and reduce optional load when the rolling 24-hour load is already substantial unless the user explicitly asks to push further.
6. Do not overlap with the effective fixed calendar commitments below, sleep hours, or the earliest allowed start.
7. All startIso and endIso timestamps MUST be ISO 8601 strings in IST timezone (+05:30), format: YYYY-MM-DDTHH:mm:ss.000+05:30.
8. Every fixed commitment must quote an exact substring from the fresh dated input in sourceQuote. Never add specificity absent from that quote.
9. Every focus session must use either a listed candidate taskId or a proposedTask with a sourceQuote copied exactly from the fresh dated input.
10. Return ONLY a valid JSON object matching this schema:
{
  "reasoning": "Brief 1-2 sentence explanation of how you parsed the natural language intention and placed sessions",
  "constraints": [
    {
      "title": "<generic fixed commitment title>",
      "startIso": "<ISO timestamp>",
      "endIso": "<ISO timestamp>",
      "sourceQuote": "<exact quote from fresh dated input>"
    }
  ],
  "focusSessions": [
    {
      "taskId": <candidate task ID as integer or null>,
      "proposedTask": <null or {"title":"<work title>","sourceQuote":"<exact work quote>"}>,
      "title": "<session title>",
      "startIso": "<ISO timestamp>",
      "endIso": "<ISO timestamp>",
      "durationMinutes": <integer>,
      "sessionType": "study|problem_practice|research_reading|coding_build",
      "reason": "<specific reason referencing user request, e.g. Requested late-night 11pm-2am study block after gym & dinner>"
    }
  ]
}`;

  const res = await generateWithFallback(ai, {
    model: MODEL_PRO,
    contents: prompt,
    config: {
      systemInstruction: 'You are a precise, context-aware focus session scheduling engine.',
      responseMimeType: 'application/json',
    },
  }, { feature: 'next_day_planner' });

  const text = (res.text || '').trim();
  if (!text) {
    throw new Error('AI Next-Day Planning Engine returned empty output.');
  }

  const parsed = JSON.parse(text) as LLMPlannerSynthesis;
  if (!Array.isArray(parsed.focusSessions) || parsed.focusSessions.length === 0) {
    throw new Error('AI Next-Day Planning Engine returned 0 planned sessions.');
  }

  const planningWindow = buildPlanningDayWindow(input.planDate, input.wakeEstimate, input.sleepTime);
  const validation = validatePlannerSynthesis({
    result: parsed,
    freshText: input.freshText,
    candidateTaskIds: input.candidateTasks.map(task => task.id).filter(id => id > 0),
    windowStart: planningWindow.start,
    windowEnd: planningWindow.end,
    notBefore: input.notBefore,
    calendarEvents: input.calendarEvents,
  });
  if (!validation.valid) {
    throw new Error(`AI Next-Day Planning Engine returned unsafe schedule blocks: ${validation.errors.join('; ')}`);
  }

  console.log(`[LLM Planner] Successfully synthesized ${parsed.focusSessions.length} sessions via Gemini. Reasoning: ${parsed.reasoning}`);
  return parsed.focusSessions;
}

interface CandidateTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  task_type: string;
  course: string | null;
  goal_id: number | null;
  goal_title: string | null;
  energy_required: string;
  estimated_minutes: number;
  credited_minutes: number;
  linked_sessions: number;
  avg_focus_score: number | null;
  last_credited_at: string | null;
  remaining_minutes: number;
  session_feedback_duration_delta: number;
  session_feedback_reason: string | null;
  due_date: string | null;
  score: number;
  reason: string;
}

interface PlannedOutcomeBias {
  completed: number;
  skipped: number;
  lastStatus: SessionStatus | null;
}

interface TaskFeedbackBias {
  helpful: number;
  started: number;
  completed: number;
  notNow: number;
  wrong: number;
  dismissed: number;
}

interface SessionFeedbackBias {
  targetTitle: string;
  tooLong: number;
  tooShort: number;
  aboutRight: number;
  focusOverestimated: number;
  focusUnderestimated: number;
}

export interface NextDayPlanInput {
  planDate?: string;
  sleepTime?: string | null;
  wakeEstimate?: string | null;
  mood?: string | null;
  energy?: string | null;
  eveningNotes?: string | null;
  tomorrowIntention?: string | null;
  selectedTaskIds?: number[];
  syncCalendar?: boolean;
  regenerate?: boolean;
}

export interface PlannedFocusSession {
  id: string;
  plan_id: number;
  task_id: number | null;
  title: string;
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  session_type: string;
  rule_json: string;
  reward_xp: number;
  reward_coins: number;
  calendar_event_id: string | null;
  calendar_status: 'not_configured' | 'created' | 'synced' | 'failed' | 'deleted';
  soft_watch_id: string | null;
  status: SessionStatus;
  origin?: string;
  invalidated_reason?: string | null;
  invalidated_at?: string | null;
}

export interface PlanConstraint {
  id: string;
  plan_id: number;
  title: string;
  start_time: string;
  end_time: string;
  source_text: string;
  source_checkin_id: number | null;
  status: 'active' | 'superseded' | 'cancelled';
}

export interface DailyPlan {
  id: number;
  plan_date: string;
  source_checkin_id: number | null;
  sleep_time: string | null;
  wake_estimate: string | null;
  mood: string | null;
  energy: string | null;
  evening_notes: string | null;
  tomorrow_intention: string | null;
  generated_summary: string | null;
  status: 'draft' | 'active' | 'archived';
  generation_source?: string;
}

export interface NextDayPlanPayload {
  plan: DailyPlan | null;
  sessions: PlannedFocusSession[];
  constraints: PlanConstraint[];
  calendarEvents: CalendarEventRow[];
  candidateTasks: CandidateTask[];
  personalization: {
    mode: PersonalizationSnapshot['moment']['mode'];
    energy: PersonalizationSnapshot['userState']['energy'];
    mood: PersonalizationSnapshot['userState']['mood'];
    learnedSprintMinutes: number;
    bestFocusWindow: string;
  };
  suggestedInputs: PlanningSuggestedInputs;
  calendarConfigured: boolean;
  dayContext: PlanningDayContext;
  contextProvenance: {
    source: 'submitted_input' | 'saved_plan' | 'exact_date_checkin' | 'live_truth';
    appliesToPlanDate: string;
    sourceCheckinId: number | null;
    fresh: boolean;
  };
  reconciliation: PlanningReconciliationOutcome;
}

export interface PlanningSuggestedInputs {
  sleepTime: string;
  wakeEstimate: string;
  mood: PersonalizationSnapshot['userState']['mood'] | 'medium';
  energy: PersonalizationSnapshot['userState']['energy'];
  source: 'existing_plan' | 'exact_date_checkin' | 'sleep_history' | 'adaptive_baseline';
  reason: string;
}

interface Window {
  start: Date;
  end: Date;
}

interface SessionRule {
  mode: 'problem_practice' | 'research_reading' | 'coding_build' | 'study';
  preferredMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  breakMinutes: number;
  guidance: string;
  tools: string[];
  rewardReason?: string;
}

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 40,
  high: 30,
  medium: 18,
  low: 8,
};

const STATUS_WEIGHT: Record<string, number> = {
  doing: 28,
  today: 24,
  todo: 18,
  this_week: 14,
  next: 8,
  backlog: 2,
};

function todayIst(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeDate(date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return addDays(todayIst(), 1);
}

function normalizeTime(value: string | null | undefined, fallback: string): string {
  if (value && /^\d{2}:\d{2}$/.test(value)) return value;
  return fallback;
}

function timeToMinutes(value: string, sleepTime = false): number {
  const [h, m] = value.split(':').map(Number);
  const minutes = (h * 60) + m;
  return sleepTime && h < 12 ? minutes + 1440 : minutes;
}

function minutesToTime(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function shiftTime(value: string, deltaMinutes: number): string {
  return minutesToTime(timeToMinutes(value) + deltaMinutes);
}

function istDate(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

export function buildPlanningDayWindow(date: string, wakeEstimate: string, sleepTime: string): {
  start: Date;
  end: Date;
  spansMidnight: boolean;
} {
  const start = istDate(date, wakeEstimate);
  let end = istDate(date, sleepTime);
  const spansMidnight = end <= start;
  if (spansMidnight) end = new Date(end.getTime() + 24 * 3600_000);
  return { start, end, spansMidnight };
}

export function filterCalendarEventsForPlanningWindow(
  events: CalendarEventRow[],
  window: { start: Date; end: Date },
): CalendarEventRow[] {
  return events.filter(event => {
    const start = new Date(event.start_time);
    const end = new Date(event.end_time);
    return Number.isFinite(start.getTime())
      && Number.isFinite(end.getTime())
      && end > window.start
      && start < window.end;
  });
}

function planningDateRelation(date: string): PlanningDayContext['relation'] {
  const today = todayIst();
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return date < today ? 'past' : 'future';
}

function summarizeFocusRows(rows: Array<{
  target_title: string;
  elapsed_minutes: number;
  final_focus_score: number;
}>): PlanningLoadSlice {
  const minutes = rows.reduce((sum, row) => sum + Math.max(0, Number(row.elapsed_minutes || 0)), 0);
  const scored = rows.map(row => Number(row.final_focus_score)).filter(Number.isFinite);
  return {
    sessionCount: rows.length,
    focusedMinutes: Math.round(minutes),
    averageFocusScore: scored.length
      ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length)
      : null,
    sessionTitles: rows.map(row => row.target_title).filter(Boolean).slice(0, 6),
  };
}

export function loadPlanningFocusLoad(input: {
  windowStart: Date;
  now?: Date;
}): PlanningFocusLoad {
  const db = getDb();
  const now = input.now ?? new Date();
  const since24Hours = new Date(now.getTime() - 24 * 3600_000);
  const loadRows = (since: Date) => {
    try {
      return db.prepare(`
        SELECT target_title, elapsed_minutes, final_focus_score
        FROM guardian_session_summaries
        WHERE julianday(COALESCE(completed_at, started_at)) >= julianday(?)
          AND julianday(COALESCE(completed_at, started_at)) <= julianday(?)
        ORDER BY COALESCE(completed_at, started_at) DESC
      `).all(since.toISOString(), now.toISOString()) as Array<{
        target_title: string;
        elapsed_minutes: number;
        final_focus_score: number;
      }>;
    } catch {
      return [];
    }
  };

  return {
    currentPlanningDay: summarizeFocusRows(input.windowStart <= now ? loadRows(input.windowStart) : []),
    last24Hours: summarizeFocusRows(loadRows(since24Hours)),
  };
}


function toSqlDateTime(date: Date): string {
  return date.toISOString();
}

function clampMinutes(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value / 5) * 5));
}

function applyPlanningStateToSnapshot(
  snapshot: PersonalizationSnapshot,
  input: { mood?: string | null; energy?: string | null }
): PersonalizationSnapshot {
  const mood = input.mood === 'high' || input.mood === 'medium' || input.mood === 'low'
    ? input.mood
    : snapshot.userState.mood;
  const energy = input.energy === 'high' || input.energy === 'medium' || input.energy === 'low'
    ? input.energy
    : snapshot.userState.energy;
  const recovery = energy === 'low' || mood === 'low';

  const next: PersonalizationSnapshot = {
    ...snapshot,
    userState: {
      ...snapshot.userState,
      mood,
      energy,
    },
    moment: recovery
      ? {
        mode: 'recovery',
        guidance: 'Use low-friction recommendations. Convert goals into minimum viable actions.',
      }
      : snapshot.moment,
  };
  // Keep active coach aligned with the overridden day state (shared model, not a stale silo)
  return refreshCognitiveOnSnapshot(next);
}

function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}

function textMatches(text: string, query: string | null | undefined): boolean {
  if (!query) return false;
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length >= 4)
    .some(term => haystack.includes(term));
}

function loadEveningCheckinForPlanDate(planDate: string) {
  return getDb().prepare(`
    SELECT id, sleep_time, wake_estimate, mood, energy, day_events, tomorrow_intention,
           raw_transcript, applies_to_plan_date
    FROM daily_checkins
    WHERE checkin_type = 'evening' AND applies_to_plan_date = ?
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get(planDate) as {
    id: number;
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    day_events: string | null;
    tomorrow_intention: string | null;
    raw_transcript: string | null;
    applies_to_plan_date: string;
  } | undefined;
}

function loadSleepWakeAverages(): { sleepTime: string | null; wakeEstimate: string | null; samples: number } {
  const rows = getDb().prepare(`
    SELECT sleep_time, wake_estimate
    FROM daily_checkins
    WHERE checkin_type = 'evening'
      AND (sleep_time IS NOT NULL OR wake_estimate IS NOT NULL)
    ORDER BY received_at DESC, id DESC
    LIMIT 14
  `).all() as Array<{ sleep_time: string | null; wake_estimate: string | null }>;

  const sleeps = rows
    .map(row => row.sleep_time)
    .filter((value): value is string => Boolean(value && /^\d{2}:\d{2}$/.test(value)))
    .map(value => timeToMinutes(value, true));
  const wakes = rows
    .map(row => row.wake_estimate)
    .filter((value): value is string => Boolean(value && /^\d{2}:\d{2}$/.test(value)))
    .map(value => timeToMinutes(value));

  return {
    sleepTime: sleeps.length ? minutesToTime(sleeps.reduce((sum, value) => sum + value, 0) / sleeps.length) : null,
    wakeEstimate: wakes.length ? minutesToTime(wakes.reduce((sum, value) => sum + value, 0) / wakes.length) : null,
    samples: rows.length,
  };
}

function buildPlanningSuggestedInputs(input: {
  plan?: DailyPlan | null;
  exactCheckin?: ReturnType<typeof loadEveningCheckinForPlanDate>;
  snapshot: PersonalizationSnapshot;
}): PlanningSuggestedInputs {
  if (input.plan?.sleep_time || input.plan?.wake_estimate) {
    const wake = normalizeTime(input.plan.wake_estimate, normalizeTime(getSetting('morning_brief_time'), '08:00'));
    return {
      sleepTime: normalizeTime(input.plan.sleep_time, shiftTime(wake, -8 * 60)),
      wakeEstimate: wake,
      mood: (input.plan.mood as PlanningSuggestedInputs['mood']) || input.snapshot.userState.mood || 'medium',
      energy: (input.plan.energy as PlanningSuggestedInputs['energy']) || input.snapshot.userState.energy,
      source: 'existing_plan',
      reason: 'using the saved plan for this date',
    };
  }

  if (input.exactCheckin?.sleep_time || input.exactCheckin?.wake_estimate) {
    const wake = normalizeTime(input.exactCheckin.wake_estimate, normalizeTime(getSetting('morning_brief_time'), '08:00'));
    return {
      sleepTime: normalizeTime(input.exactCheckin.sleep_time, shiftTime(wake, -8 * 60)),
      wakeEstimate: wake,
      mood: (input.exactCheckin.mood as PlanningSuggestedInputs['mood']) || input.snapshot.userState.mood || 'medium',
      energy: (input.exactCheckin.energy as PlanningSuggestedInputs['energy']) || input.snapshot.userState.energy,
      source: 'exact_date_checkin',
      reason: 'using the evening update bound to this plan date',
    };
  }

  const history = loadSleepWakeAverages();
  if (history.sleepTime || history.wakeEstimate) {
    const wake = normalizeTime(history.wakeEstimate, normalizeTime(getSetting('morning_brief_time'), '08:00'));
    return {
      sleepTime: normalizeTime(history.sleepTime, shiftTime(wake, -8 * 60)),
      wakeEstimate: wake,
      mood: input.snapshot.userState.mood || 'medium',
      energy: input.snapshot.userState.energy,
      source: 'sleep_history',
      reason: `using recent sleep/wake history from ${history.samples} evening check-in${history.samples === 1 ? '' : 's'}`,
    };
  }

  const wake = normalizeTime(getSetting('morning_brief_time'), '08:00');
  const sleepDebtBuffer = input.snapshot.userState.energy === 'low' || input.snapshot.userState.mood === 'low' ? 9 * 60 : 8 * 60;
  return {
    sleepTime: shiftTime(wake, -sleepDebtBuffer),
    wakeEstimate: wake,
    mood: input.snapshot.userState.mood || 'medium',
    energy: input.snapshot.userState.energy,
    source: 'adaptive_baseline',
    reason: input.snapshot.userState.energy === 'low' || input.snapshot.userState.mood === 'low'
      ? 'derived from morning setting with extra sleep buffer because recovery signals are present'
      : 'derived from morning setting until you give a fresher evening update',
  };
}

function upsertEveningCheckin(input: NextDayPlanInput, planDate: string): number | null {
  const hasCheckinSignal = input.sleepTime || input.wakeEstimate || input.mood || input.energy || input.tomorrowIntention || input.eveningNotes;
  if (!hasCheckinSignal) return null;

  const db = getDb();
  const today = todayIst();
  const raw = [
    input.eveningNotes?.trim(),
    input.tomorrowIntention ? `Tomorrow: ${input.tomorrowIntention.trim()}` : null,
    input.mood ? `Mood: ${input.mood}` : null,
    input.energy ? `Energy: ${input.energy}` : null,
    input.sleepTime ? `Sleep: ${input.sleepTime}` : null,
    input.wakeEstimate ? `Wake: ${input.wakeEstimate}` : null,
    `Planning date: ${planDate}`,
  ].filter(Boolean).join('\n');

  const existing = db.prepare(`
    SELECT id FROM daily_checkins
    WHERE checkin_date = ? AND checkin_type = 'evening' AND applies_to_plan_date = ?
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get(today, planDate) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE daily_checkins
      SET sleep_time = COALESCE(?, sleep_time),
          wake_estimate = COALESCE(?, wake_estimate),
          mood = COALESCE(?, mood),
          energy = COALESCE(?, energy),
          day_events = COALESCE(?, day_events),
          tomorrow_intention = COALESCE(?, tomorrow_intention),
          applies_to_plan_date = ?,
          raw_transcript = CASE WHEN ? != '' THEN ? ELSE raw_transcript END
      WHERE id = ?
    `).run(
      input.sleepTime ?? null,
      input.wakeEstimate ?? null,
      input.mood ?? null,
      input.energy ?? null,
      input.eveningNotes ?? null,
      input.tomorrowIntention ?? null,
      planDate,
      raw,
      raw,
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO daily_checkins (
      checkin_date, checkin_type, sleep_time, wake_estimate, mood, energy,
      day_events, tomorrow_intention, applies_to_plan_date, raw_transcript
    )
    VALUES (?, 'evening', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    today,
    input.sleepTime ?? null,
    input.wakeEstimate ?? null,
    input.mood ?? null,
    input.energy ?? null,
    input.eveningNotes ?? null,
    input.tomorrowIntention ?? null,
    planDate,
    raw
  );
  return Number(result.lastInsertRowid);
}

function loadCandidateTasks(
  snapshot: PersonalizationSnapshot,
  intention: string | null,
  selectedTaskIds: number[] | undefined,
  planDate: string,
  experimentBias: PlannerExperimentBias & { applyToNonUrgent?: boolean; source?: string } = getCombinedPlannerBias(),
): CandidateTask[] {
  const db = getDb();
  const selected = selectedTaskIds && selectedTaskIds.length > 0 ? new Set(selectedTaskIds) : null;
  const learnedEstimate = getAdaptiveSessionMinutes();
  const plannedOutcomeBias = loadPlannedOutcomeBias(planDate);
  const feedbackBias = loadTaskFeedbackBias();
  const sessionFeedbackBias = loadSessionFeedbackBias();
  const rows = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      COALESCE(t.priority, 'medium') as priority,
      COALESCE(t.task_type, 'task') as task_type,
      t.course,
      t.goal_id,
      g.title as goal_title,
      COALESCE(t.energy_required, 'medium') as energy_required,
      COALESCE(t.estimated_minutes, ?) as estimated_minutes,
      COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
      COUNT(l.id) as linked_sessions,
      AVG(l.focus_score) as avg_focus_score,
      MAX(l.credited_at) as last_credited_at,
      t.due_date
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    LEFT JOIN task_session_logs l ON l.task_id = t.id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND t.blocked_since IS NULL
    GROUP BY t.id
    ORDER BY t.position ASC, t.id DESC
    LIMIT 160
  `).all(learnedEstimate) as Array<Omit<CandidateTask, 'remaining_minutes' | 'score' | 'reason'>>;

  const energy = snapshot.userState.energy;
  const candidateTasks = rows
    .map((task) => {
      const target = Math.max(15, Math.round(Number(task.estimated_minutes || learnedEstimate)));
      const credited = Math.round(Number(task.credited_minutes || 0));
      const remaining = Math.max(0, target - credited);
      const reasons: string[] = [];
      let score = 0;
      let sessionFeedbackDurationDelta = 0;
      let sessionFeedbackReason: string | null = null;

      score += PRIORITY_WEIGHT[task.priority] ?? PRIORITY_WEIGHT.medium;
      score += STATUS_WEIGHT[task.status] ?? 10;
      if (selected?.has(task.id)) { score += 80; reasons.push('chosen for tomorrow'); }
      if (textMatches(task.title, intention) || textMatches(task.goal_title ?? '', intention)) {
        score += 35;
        reasons.push('matches tomorrow intention');
      }
      if (textMatches(task.task_type, intention) || textMatches(task.course ?? '', intention)) {
        score += 18;
        reasons.push('matches stated task kind/course');
      }
      if (task.status === 'doing') reasons.push('already in progress');
      if (task.due_date && task.due_date <= planDate) { score += 22; reasons.push('due soon'); }
      if (energy === 'high' && task.energy_required === 'high') { score += 12; reasons.push('high-energy fit'); }
      if (energy === 'low' && task.energy_required === 'low') { score += 12; reasons.push('low-energy fit'); }
      if (energy === 'low' && task.energy_required === 'high') { score -= 18; reasons.push('defer if drained'); }
      if (task.avg_focus_score !== null && task.avg_focus_score >= 75) {
        score += energy === 'low' ? 8 : 14;
        reasons.push(`works well historically (${Math.round(task.avg_focus_score)} focus)`);
      }
      if (task.avg_focus_score !== null && task.avg_focus_score < 55 && energy === 'low') {
        score -= 14;
        reasons.push(`low-energy risk from past ${Math.round(task.avg_focus_score)} focus`);
      }
      if (task.linked_sessions > 0 && remaining <= Math.max(learnedEstimate, Math.round(target * 0.35))) {
        score += 16;
        reasons.push(`${task.linked_sessions} linked session${task.linked_sessions === 1 ? '' : 's'}; finishable`);
      }

      const feedback = feedbackBias.get(task.id);
      if (feedback) {
        const positive = feedback.helpful + feedback.started + feedback.completed;
        const negative = feedback.notNow + feedback.wrong + feedback.dismissed;
        if (positive > negative) {
          score += Math.min(24, positive * 8);
          reasons.push('previous feedback says this task fits');
        }
        if (negative > positive && !selected?.has(task.id)) {
          const penalty = (feedback.wrong * 18) + (feedback.notNow * 12) + (feedback.dismissed * 8);
          score -= Math.min(36, penalty);
          if (feedback.wrong > 0) reasons.push('previously marked wrong fit');
          else if (feedback.notNow > 0) reasons.push('previously deferred');
          else reasons.push('often dismissed');
        }
      }

      const sessionFeedback = matchSessionFeedbackBias(task, sessionFeedbackBias);
      if (sessionFeedback) {
        if (sessionFeedback.aboutRight > Math.max(sessionFeedback.tooLong, sessionFeedback.tooShort)) {
          score += Math.min(12, sessionFeedback.aboutRight * 4);
          reasons.push('session feedback says this block length fits');
          sessionFeedbackReason = 'recent Guardian feedback said similar session length fit well';
        } else if (sessionFeedback.tooLong > sessionFeedback.tooShort) {
          sessionFeedbackDurationDelta = -10;
          score += snapshot.userState.energy === 'low' ? 6 : 0;
          reasons.push('session feedback says shorter blocks work better');
          sessionFeedbackReason = 'recent Guardian feedback said similar sessions were too long';
        } else if (sessionFeedback.tooShort > sessionFeedback.tooLong) {
          sessionFeedbackDurationDelta = 10;
          score += 4;
          reasons.push('session feedback says longer blocks are tolerable');
          sessionFeedbackReason = 'recent Guardian feedback said similar sessions were too short';
        }
        if (sessionFeedback.focusOverestimated > sessionFeedback.focusUnderestimated) {
          score -= snapshot.userState.energy === 'low' ? 10 : 4;
          reasons.push('past feedback reported lower focus than expected');
        }
        if (sessionFeedback.focusUnderestimated > sessionFeedback.focusOverestimated) {
          score += 6;
          reasons.push('past feedback reported better focus than expected');
        }
      }

      const outcome = plannedOutcomeBias.get(task.id);
      if (outcome) {
        if (outcome.completed > outcome.skipped) {
          score += Math.min(18, outcome.completed * 6);
          reasons.push(`${outcome.completed} recent planned block${outcome.completed === 1 ? '' : 's'} completed`);
        }
        if (outcome.skipped > outcome.completed && !selected?.has(task.id)) {
          score -= Math.min(24, outcome.skipped * 8);
          reasons.push(`${outcome.skipped} recent planned block${outcome.skipped === 1 ? '' : 's'} skipped`);
        }
      }
      if (task.last_credited_at) {
        const daysSinceCredit = Math.max(0, Math.round((new Date(`${planDate}T00:00:00+05:30`).getTime() - new Date(task.last_credited_at).getTime()) / 86400000));
        if (daysSinceCredit >= 3) {
          score += 7;
          reasons.push(`not touched for ${daysSinceCredit}d`);
        }
      }
      if (experimentBias.active && taskMatchesCoachBias(task, experimentBias as ReturnType<typeof getCombinedPlannerBias>, planDate)) {
        score += experimentBias.scoreBoost;
        const source = (experimentBias as { source?: string }).source || 'experiment';
        if (source === 'active_coach') {
          if (experimentBias.kind === 'activation_block') {
            reasons.push('active coach: auto activation block for non-urgent work');
          } else if (experimentBias.kind === 'early_synthetic_deadline') {
            reasons.push(
              experimentBias.syntheticDueDate
                ? `active coach: early commitment (synthetic due ${experimentBias.syntheticDueDate})`
                : 'active coach: early commitment boost',
            );
          } else {
            reasons.push('active coach rewiring target');
          }
        } else if (experimentBias.kind === 'activation_block') {
          reasons.push('active light experiment: activation block target');
        } else if (experimentBias.kind === 'early_synthetic_deadline') {
          reasons.push(
            experimentBias.syntheticDueDate
              ? `active light experiment: synthetic due ${experimentBias.syntheticDueDate}`
              : 'active light experiment: early synthetic deadline',
          );
        } else {
          reasons.push('active light experiment target');
        }
      }
      if (remaining <= 0) score -= 100;
      if (remaining > 0 && remaining <= getAdaptiveSessionMinutes()) { score += 8; reasons.push('close to completion'); }

      return {
        ...task,
        estimated_minutes: target,
        credited_minutes: credited,
        remaining_minutes: remaining,
        session_feedback_duration_delta: sessionFeedbackDurationDelta,
        session_feedback_reason: sessionFeedbackReason,
        score,
        reason: reasons.join(', ') || 'open time-target task',
      };
    })
    .filter(task => task.remaining_minutes > 0)
    .filter(task => !selected || selected.has(task.id))
    .sort((a, b) => b.score - a.score);

  if (candidateTasks.length === 0 && intention && intention.trim().length > 0) {
    const cleanIntention = intention.trim();
    let estimatedMinutes = learnedEstimate;
    const hourMatch = cleanIntention.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)/i);
    const minMatch = cleanIntention.match(/(\d+)\s*(?:minutes?|mins?|m)/i);
    if (hourMatch) {
      estimatedMinutes = Math.round(parseFloat(hourMatch[1]) * 60);
    } else if (minMatch) {
      estimatedMinutes = parseInt(minMatch[1], 10);
    }
    estimatedMinutes = Math.max(15, Math.min(240, estimatedMinutes));

    candidateTasks.push({
      id: -1,
      title: cleanIntention.length > 70 ? cleanIntention.slice(0, 67) + '...' : cleanIntention,
      status: 'todo',
      priority: 'high',
      task_type: 'study',
      course: null,
      goal_id: null,
      goal_title: null,
      energy_required: energy,
      estimated_minutes: estimatedMinutes,
      credited_minutes: 0,
      linked_sessions: 0,
      avg_focus_score: null,
      last_credited_at: null,
      remaining_minutes: estimatedMinutes,
      session_feedback_duration_delta: 0,
      session_feedback_reason: null,
      due_date: planDate,
      score: 100,
      reason: `derived from tomorrow intention (${estimatedMinutes}m target)`,
    });
  }

  return candidateTasks;
}

function shouldScheduleCandidate(input: {
  task: CandidateTask;
  snapshot: PersonalizationSnapshot;
  selectedTaskIds?: number[];
  planDate: string;
}): boolean {
  const { task, snapshot, selectedTaskIds, planDate } = input;
  const selected = Boolean(selectedTaskIds?.includes(task.id));
  const dueNow = Boolean(task.due_date && task.due_date <= planDate);
  const recoveryMode = snapshot.moment.mode === 'recovery'
    || snapshot.userState.energy === 'low'
    || snapshot.userState.mood === 'low';

  if (
    recoveryMode
    && task.energy_required === 'high'
    && task.status !== 'doing'
    && !selected
    && !dueNow
  ) {
    return false;
  }

  return true;
}

function loadSessionFeedbackBias(): SessionFeedbackBias[] {
  try {
    const rows = getDb().prepare(`
      SELECT
        gss.target_title as targetTitle,
        SUM(CASE WHEN sf.session_length_fit = 'too_long' THEN 1 ELSE 0 END) as tooLong,
        SUM(CASE WHEN sf.session_length_fit = 'too_short' THEN 1 ELSE 0 END) as tooShort,
        SUM(CASE WHEN sf.session_length_fit = 'about_right' THEN 1 ELSE 0 END) as aboutRight,
        SUM(CASE WHEN sf.prediction_error_focus > 0 THEN 1 ELSE 0 END) as focusOverestimated,
        SUM(CASE WHEN sf.prediction_error_focus < 0 THEN 1 ELSE 0 END) as focusUnderestimated
      FROM session_feedback sf
      JOIN guardian_session_summaries gss ON gss.session_id = sf.session_id
      WHERE sf.created_at >= datetime('now', '-45 days')
      GROUP BY gss.target_title
    `).all() as Array<{
      targetTitle: string;
      tooLong: number | null;
      tooShort: number | null;
      aboutRight: number | null;
      focusOverestimated: number | null;
      focusUnderestimated: number | null;
    }>;

    return rows
      .map(row => ({
        targetTitle: row.targetTitle,
        tooLong: Number(row.tooLong ?? 0),
        tooShort: Number(row.tooShort ?? 0),
        aboutRight: Number(row.aboutRight ?? 0),
        focusOverestimated: Number(row.focusOverestimated ?? 0),
        focusUnderestimated: Number(row.focusUnderestimated ?? 0),
      }))
      .filter(row => row.targetTitle.trim().length > 0);
  } catch {
    return [];
  }
}

function matchSessionFeedbackBias(task: Pick<CandidateTask, 'title' | 'task_type' | 'course' | 'goal_title'>, rows: SessionFeedbackBias[]): SessionFeedbackBias | null {
  const taskText = `${task.title} ${task.task_type} ${task.course ?? ''} ${task.goal_title ?? ''}`;
  return rows.find(row => textMatches(taskText, row.targetTitle) || textMatches(row.targetTitle, task.title)) ?? null;
}

function loadPlannedOutcomeBias(planDate: string): Map<number, PlannedOutcomeBias> {
  const bias = new Map<number, PlannedOutcomeBias>();
  try {
    const rows = getDb().prepare(`
      SELECT
        pfs.task_id as taskId,
        pfs.status,
        COUNT(*) as count,
        MAX(pfs.updated_at) as lastUpdatedAt
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      WHERE pfs.task_id IS NOT NULL
        AND pfs.status IN ('completed', 'skipped')
        AND dp.plan_date < ?
        AND dp.plan_date >= date(?, '-21 days')
      GROUP BY pfs.task_id, pfs.status
      ORDER BY lastUpdatedAt DESC
    `).all(planDate, planDate) as Array<{
      taskId: number;
      status: SessionStatus;
      count: number;
      lastUpdatedAt: string | null;
    }>;

    for (const row of rows) {
      const current = bias.get(row.taskId) ?? { completed: 0, skipped: 0, lastStatus: null };
      if (row.status === 'completed') current.completed += Number(row.count || 0);
      if (row.status === 'skipped') current.skipped += Number(row.count || 0);
      if (!current.lastStatus) current.lastStatus = row.status;
      bias.set(row.taskId, current);
    }
  } catch { /* planned outcomes are optional during migration */ }
  return bias;
}

function loadTaskFeedbackBias(): Map<number, TaskFeedbackBias> {
  const bias = new Map<number, TaskFeedbackBias>();
  try {
    const rows = getDb().prepare(`
      SELECT task_id as taskId, feedback, COUNT(*) as count
      FROM task_recommendation_feedback
      WHERE created_at >= datetime('now', '-45 days')
      GROUP BY task_id, feedback
    `).all() as Array<{ taskId: number; feedback: string; count: number }>;

    for (const row of rows) {
      const current = bias.get(row.taskId) ?? {
        helpful: 0,
        started: 0,
        completed: 0,
        notNow: 0,
        wrong: 0,
        dismissed: 0,
      };
      if (row.feedback === 'helpful') current.helpful += Number(row.count || 0);
      if (row.feedback === 'started') current.started += Number(row.count || 0);
      if (row.feedback === 'completed') current.completed += Number(row.count || 0);
      if (row.feedback === 'not_now') current.notNow += Number(row.count || 0);
      if (row.feedback === 'wrong') current.wrong += Number(row.count || 0);
      if (row.feedback === 'dismissed') current.dismissed += Number(row.count || 0);
      bias.set(row.taskId, current);
    }
  } catch { /* task recommendation feedback is optional during migration */ }
  return bias;
}

function applyExperimentToRule(
  rule: SessionRule,
  task: CandidateTask,
  experimentBias: PlannerExperimentBias & { applyToNonUrgent?: boolean; source?: string },
  planDate?: string,
): SessionRule {
  if (!experimentBias.active) return rule;
  if (!taskMatchesCoachBias(task, experimentBias as ReturnType<typeof getCombinedPlannerBias>, planDate)) {
    return rule;
  }

  if (experimentBias.kind === 'activation_block' && experimentBias.preferredActivationMinutes) {
    const minutes = clampMinutes(experimentBias.preferredActivationMinutes, 10, 25);
    const prefix = experimentBias.source === 'active_coach'
      ? 'Active coach auto activation block.'
      : 'Activation block experiment.';
    return {
      ...rule,
      preferredMinutes: minutes,
      minMinutes: Math.min(rule.minMinutes, 10),
      maxMinutes: Math.min(rule.maxMinutes, 25),
      guidance: `${experimentBias.guidance || prefix} ${rule.guidance}`,
    };
  }

  if (experimentBias.kind === 'early_synthetic_deadline') {
    const prefix = experimentBias.source === 'active_coach'
      ? 'Active coach early commitment.'
      : 'Early synthetic deadline experiment.';
    return {
      ...rule,
      guidance: `${experimentBias.guidance || prefix} ${rule.guidance}`,
    };
  }

  return rule;
}

function deriveSessionRule(
  task: CandidateTask,
  snapshot: PersonalizationSnapshot,
  experimentBias: PlannerExperimentBias & { applyToNonUrgent?: boolean; source?: string } = getCombinedPlannerBias(),
  planDate?: string,
): SessionRule {
  const text = `${task.title} ${task.goal_title ?? ''} ${task.task_type} ${task.course ?? ''}`.toLowerCase();
  const learned = getAdaptiveSessionMinutes();
  const energy = snapshot.userState.energy;
  const energyMultiplier = energy === 'high' ? 1.1 : energy === 'low' ? 0.8 : 1;

  let rule: SessionRule;
  if (/(math|problem|academy|exercise|drill|proof)/.test(text)) {
    rule = applySessionFeedbackToRule({
      mode: 'problem_practice',
      preferredMinutes: clampMinutes(30 * energyMultiplier, 20, 40),
      minMinutes: 20,
      maxMinutes: 45,
      breakMinutes: 7,
      guidance: 'Use short, closed-loop practice blocks and review mistakes before extending.',
      tools: ['Math Academy', 'notes'],
    }, task);
  } else if (/(paper|research|read|reading|domain|concept|google|literature|survey)/.test(text)) {
    rule = applySessionFeedbackToRule({
      mode: 'research_reading',
      preferredMinutes: clampMinutes(Math.max(45, learned) * energyMultiplier, 35, 70),
      minMinutes: 30,
      maxMinutes: 75,
      breakMinutes: 10,
      guidance: 'Use longer exploration blocks with explicit concept capture and unclear-question follow-up.',
      tools: ['browser', 'ChatGPT', 'notes'],
    }, task);
  } else if (/(code|build|debug|implement|ship|pr|repo|test)/.test(text)) {
    rule = applySessionFeedbackToRule({
      mode: 'coding_build',
      preferredMinutes: clampMinutes(Math.max(45, learned) * energyMultiplier, 35, 80),
      minMinutes: 30,
      maxMinutes: 90,
      breakMinutes: 10,
      guidance: 'Use build/test checkpoints and stop with the next concrete handoff written down.',
      tools: ['editor', 'terminal', 'tests'],
    }, task);
  } else {
    rule = applySessionFeedbackToRule({
      mode: 'study',
      preferredMinutes: clampMinutes(learned * energyMultiplier, 25, 60),
      minMinutes: 20,
      maxMinutes: 70,
      breakMinutes: 8,
      guidance: 'Use a focused study block and end by logging what changed in understanding.',
      tools: ['notes'],
    }, task);
  }

  return applyExperimentToRule(rule, task, experimentBias, planDate);
}

function applySessionFeedbackToRule(rule: SessionRule, task: CandidateTask): SessionRule {
  if (!task.session_feedback_duration_delta) return rule;
  const preferredMinutes = clampMinutes(
    rule.preferredMinutes + task.session_feedback_duration_delta,
    rule.minMinutes,
    rule.maxMinutes
  );
  return {
    ...rule,
    preferredMinutes,
    guidance: task.session_feedback_reason
      ? `${rule.guidance} ${task.session_feedback_reason}.`
      : rule.guidance,
  };
}

function computeAdaptiveSessionXp(input: {
  task: CandidateTask;
  durationMinutes: number;
  rule: SessionRule;
  snapshot: PersonalizationSnapshot;
}): { xp: number; reason: string } {
  const { task, durationMinutes, rule, snapshot } = input;
  const priority = PRIORITY_WEIGHT[task.priority] ?? PRIORITY_WEIGHT.medium;
  const difficulty = task.energy_required === 'high' ? 18 : task.energy_required === 'low' ? 6 : 12;
  const modeBonus = rule.mode === 'research_reading' || rule.mode === 'coding_build' ? 12 : 8;
  let multiplier = 1;
  const reasons: string[] = [];

  if (task.avg_focus_score !== null && task.avg_focus_score >= 78) {
    multiplier += 0.12;
    reasons.push(`past ${Math.round(task.avg_focus_score)} focus says this task type works`);
  } else if (task.avg_focus_score !== null && task.avg_focus_score < 55) {
    multiplier += snapshot.userState.energy === 'low' ? -0.1 : 0.08;
    reasons.push(snapshot.userState.energy === 'low'
      ? `past ${Math.round(task.avg_focus_score)} focus makes this risky on low energy`
      : `past ${Math.round(task.avg_focus_score)} focus needs extra incentive`);
  }

  if (task.linked_sessions > 0 && task.remaining_minutes <= Math.max(durationMinutes, Math.round(task.estimated_minutes * 0.35))) {
    multiplier += 0.1;
    reasons.push('finishable from linked focus-session progress');
  }

  // Active-coach rewiring: non-crisis planned blocks earn slightly more XP
  const voluntary = getVoluntaryRewardMultiplier({
    dueDate: task.due_date,
    snapshot,
  });
  if (voluntary.multiplier > 1) {
    multiplier *= voluntary.multiplier;
    if (voluntary.reason) reasons.push(voluntary.reason);
  }

  if (snapshot.moment.mode === 'deadline_pressure' && task.priority !== 'low') {
    multiplier += 0.1;
    reasons.push('deadline-pressure day rewards concrete task progress');
  }

  if ((snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') && durationMinutes <= 30) {
    multiplier += 0.08;
    reasons.push('small recovery-compatible block gets consistency credit');
  }

  const base = (durationMinutes * 1.4) + priority + difficulty + modeBonus;
  // IMPORTANT: do not use clampMinutes here — it snaps to 5-minute steps and
  // would crush multipliers like 1.12 into 0/5 and wipe adaptive XP.
  const xpCap = reasons.some(r => /rewiring bonus/i.test(r)) ? 1.55 : 1.35;
  const cappedMultiplier = Math.max(0.8, Math.min(xpCap, multiplier));
  const xp = Math.max(20, Math.round(base * cappedMultiplier));
  return {
    xp,
    reason: reasons.length
      ? `XP adapted: ${reasons.join('; ')}`
      : 'XP adapted from duration, priority, energy demand, and session mode',
  };
}

function computeReward(task: CandidateTask, durationMinutes: number, rule: SessionRule, snapshot: PersonalizationSnapshot) {
  const xp = computeAdaptiveSessionXp({ task, durationMinutes, rule, snapshot });
  const rewardBase = getAdaptiveTaskRewardBase({
    taskId: task.id,
    title: task.title,
    priority: task.priority,
    targetMinutes: durationMinutes,
    snapshot,
  });
  const reward = getAdaptiveRewardDecision({
    action: 'task_auto_complete',
    baseCoins: rewardBase.baseCoins,
    priority: task.priority,
    subject: `${task.title} planned block (${durationMinutes}m; ${rule.mode}; ${rewardBase.reason})`,
    snapshot,
    taskDueDate: task.due_date,
  });
  return {
    xp: xp.xp,
    coins: reward.coins,
    reason: `${xp.reason}; ${rewardBase.reason}; ${reward.reason}`,
  };
}

function buildAvailability(
  date: string,
  wakeEstimate: string,
  sleepTime: string,
  calendarEvents: CalendarEventRow[],
  notBefore: Date | null = null,
): Window[] {
  const planningWindow = buildPlanningDayWindow(date, wakeEstimate, sleepTime);
  const dayStart = planningWindow.start;
  const dayEnd = planningWindow.end;

  const busy = calendarEvents
    .map(event => ({
      start: new Date(event.start_time),
      end: new Date(event.end_time),
    }))
    .filter(event => event.end > dayStart && event.start < dayEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const windows: Window[] = [];
  let cursor = new Date(Math.max(
    dayStart.getTime() + 45 * 60000,
    notBefore?.getTime() ?? Number.NEGATIVE_INFINITY,
  ));
  for (const event of busy) {
    const start = new Date(Math.max(event.start.getTime() - 10 * 60000, dayStart.getTime()));
    if (minutesBetween(cursor, start) >= 25) windows.push({ start: cursor, end: start });
    cursor = new Date(Math.max(cursor.getTime(), event.end.getTime() + 10 * 60000));
  }
  if (minutesBetween(cursor, dayEnd) >= 25) windows.push({ start: cursor, end: dayEnd });
  return windows;
}

function insertSoftWatch(input: {
  id: string;
  title: string;
  taskId: number | null;
  goalId: number | null;
  start: Date;
  durationMinutes: number;
  calendarEventId?: string | null;
}) {
  getDb().prepare(`
    INSERT INTO soft_watch_commitments (
      id, target_title, goal_id, task_id, intended_start_at, planned_minutes,
      source, reminder_sent_at, check_in_sent_at, status, locked_in_session_id, calendar_event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'next_day_plan', NULL, NULL, 'pending', NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      target_title = excluded.target_title,
      goal_id = excluded.goal_id,
      task_id = excluded.task_id,
      intended_start_at = excluded.intended_start_at,
      planned_minutes = excluded.planned_minutes,
      status = CASE WHEN soft_watch_commitments.status = 'pending' THEN 'pending' ELSE soft_watch_commitments.status END,
      calendar_event_id = COALESCE(excluded.calendar_event_id, soft_watch_commitments.calendar_event_id)
  `).run(
    input.id,
    input.title,
    input.goalId,
    input.taskId,
    input.start.getTime(),
    input.durationMinutes,
    input.calendarEventId ?? null,
    Date.now()
  );
}

async function syncSessionCalendar(session: PlannedFocusSession, rule: SessionRule, snapshot: PersonalizationSnapshot) {
  if (!isCalendarConfigured()) return { eventId: null, status: 'not_configured' as const };
  const eventId = await createCalendarEvent({
    summary: `Focus: ${session.title}`,
    description: `LifeOS next-day plan\n${rule.guidance}\nReward: ${session.reward_xp} XP / ${session.reward_coins} coins`,
    startTime: new Date(session.planned_start),
    endTime: new Date(session.planned_end),
    colorId: '9',
    reminderSnapshot: snapshot,
  });
  return eventId
    ? { eventId, status: 'created' as const }
    : { eventId: null, status: 'failed' as const };
}

function serializeRule(rule: SessionRule, task: CandidateTask): string {
  return JSON.stringify({
    mode: rule.mode,
    guidance: rule.guidance,
    tools: rule.tools,
    breakMinutes: rule.breakMinutes,
    rewardReason: rule.rewardReason,
    source: 'next_day_planner',
    taskRemainingMinutes: task.remaining_minutes,
    taskReason: task.reason,
  });
}

function candidateForPlannedSession(input: {
  taskId: number | null;
  title: string;
  durationMinutes: number;
  snapshot: PersonalizationSnapshot;
}): CandidateTask {
  const fallbackReason = input.snapshot.today.plannedFocus.nextTitle
    ? `manual planned-session edit aligned with ${input.snapshot.today.plannedFocus.nextTitle}`
    : input.snapshot.moment.mode === 'recovery' || input.snapshot.userState.energy === 'low' || input.snapshot.userState.mood === 'low'
      ? 'manual planned-session edit sized for recovery-safe planning'
      : input.snapshot.moment.mode === 'deadline_pressure'
        ? 'manual planned-session edit protecting deadline-relief work'
        : input.snapshot.moment.mode === 'planning'
          ? 'manual planned-session edit from tomorrow planning context'
          : `manual planned-session edit using ${input.snapshot.moment.mode.replace(/_/g, ' ')} context`;
  const fallback: CandidateTask = {
    id: input.taskId ?? 0,
    title: input.title,
    status: 'planned',
    priority: 'medium',
    task_type: 'task',
    course: null,
    goal_id: null,
    goal_title: null,
    energy_required: 'medium',
    estimated_minutes: input.durationMinutes,
    credited_minutes: 0,
    linked_sessions: 0,
    avg_focus_score: null,
    last_credited_at: null,
    remaining_minutes: input.durationMinutes,
    session_feedback_duration_delta: 0,
    session_feedback_reason: null,
    due_date: null,
    score: 0,
    reason: fallbackReason,
  };

  if (!input.taskId) return fallback;

  try {
    const row = getDb().prepare(`
      SELECT
        t.id,
        COALESCE(t.priority, 'medium') as priority,
        t.status,
        COALESCE(t.task_type, 'task') as task_type,
        t.course,
        t.goal_id,
        g.title as goal_title,
        COALESCE(t.energy_required, 'medium') as energy_required,
        COALESCE(t.estimated_minutes, ?) as estimated_minutes,
        COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
        COUNT(l.id) as linked_sessions,
        AVG(l.focus_score) as avg_focus_score,
        MAX(l.credited_at) as last_credited_at,
        t.due_date
      FROM tasks t
      LEFT JOIN goals g ON g.id = t.goal_id
      LEFT JOIN task_session_logs l ON l.task_id = t.id
      WHERE t.id = ?
      GROUP BY t.id
      LIMIT 1
    `).get(input.durationMinutes, input.taskId) as Omit<CandidateTask, 'title' | 'remaining_minutes' | 'score' | 'reason'> | undefined;

    if (!row) return fallback;
    const target = Math.max(5, Math.round(Number(row.estimated_minutes || input.durationMinutes)));
    const credited = Math.round(Number(row.credited_minutes || 0));
    return {
      ...row,
      title: input.title,
      estimated_minutes: target,
      credited_minutes: credited,
      remaining_minutes: Math.max(0, target - credited),
      session_feedback_duration_delta: 0,
      session_feedback_reason: null,
      score: 0,
      reason: 'edited planned session refreshed from linked task and current day signals',
    };
  } catch {
    return fallback;
  }
}

export async function generateNextDayPlan(input: NextDayPlanInput = {}): Promise<NextDayPlanPayload> {
  const db = getDb();
  const planDate = normalizeDate(input.planDate);
  const submittedCheckinId = upsertEveningCheckin(input, planDate);
  const exactCheckin = loadEveningCheckinForPlanDate(planDate);
  const savedPlan = db.prepare(`
    SELECT * FROM daily_plans WHERE plan_date = ? AND status != 'archived' LIMIT 1
  `).get(planDate) as DailyPlan | undefined;
  const savedPlanHasFreshSource = !savedPlan?.source_checkin_id
    || savedPlan.source_checkin_id === exactCheckin?.id;
  const exactSavedPlan = savedPlanHasFreshSource ? savedPlan : undefined;
  const baseSnapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 3,
    includeMemoryFacts: 4,
  });
  const suggestedInputs = buildPlanningSuggestedInputs({ plan: exactSavedPlan, exactCheckin, snapshot: baseSnapshot });
  const sourceCheckinId = submittedCheckinId ?? exactSavedPlan?.source_checkin_id ?? exactCheckin?.id ?? null;
  const sleepTime = normalizeTime(input.sleepTime ?? exactSavedPlan?.sleep_time ?? exactCheckin?.sleep_time, suggestedInputs.sleepTime);
  const wakeEstimate = normalizeTime(input.wakeEstimate ?? exactSavedPlan?.wake_estimate ?? exactCheckin?.wake_estimate, suggestedInputs.wakeEstimate);
  const intention = (input.tomorrowIntention ?? exactSavedPlan?.tomorrow_intention ?? exactCheckin?.tomorrow_intention ?? '').trim() || null;
  const planMood = input.mood ?? exactSavedPlan?.mood ?? exactCheckin?.mood ?? baseSnapshot.userState.mood;
  const planEnergy = input.energy ?? exactSavedPlan?.energy ?? exactCheckin?.energy ?? baseSnapshot.userState.energy;
  const snapshot = applyPlanningStateToSnapshot(baseSnapshot, { mood: planMood, energy: planEnergy });
  const eveningNotes = input.eveningNotes ?? exactSavedPlan?.evening_notes ?? exactCheckin?.day_events ?? null;
  const submittedSignal = Boolean(input.sleepTime || input.wakeEstimate || input.mood || input.energy || input.tomorrowIntention || input.eveningNotes);
  const contextSource: NextDayPlanPayload['contextProvenance']['source'] = submittedSignal
    ? 'submitted_input'
    : exactSavedPlan ? 'saved_plan'
      : exactCheckin ? 'exact_date_checkin'
        : 'live_truth';
  const typedConstraints = extractTypedPlanConstraints({
    planDate,
    text: [intention, eveningNotes].filter(Boolean).join('\n'),
  });
  const workIntention = stripConstraintText(intention, typedConstraints);
  const planningWindow = buildPlanningDayWindow(planDate, wakeEstimate, sleepTime);
  const calendarEndDate = planningWindow.spansMidnight ? addDays(planDate, 1) : planDate;
  const rawCalendarEvents = filterCalendarEventsForPlanningWindow(
    getCalendarEvents(planDate, calendarEndDate) as CalendarEventRow[],
    planningWindow,
  );
  const interpretedContext = interpretPlanningContext({
    intention,
    eveningNotes,
    calendarEvents: rawCalendarEvents,
  });
  const focusLoad = loadPlanningFocusLoad({ windowStart: planningWindow.start });
  const relation = planningDateRelation(planDate);
  const notBefore = relation === 'today'
    ? new Date(Date.now() + 10 * 60_000)
    : null;
  const appliedSignals = [...interpretedContext.signals];
  if (focusLoad.last24Hours.sessionCount > 0) {
    appliedSignals.push(
      `${focusLoad.last24Hours.sessionCount} focus session${focusLoad.last24Hours.sessionCount === 1 ? '' : 's'} / ${focusLoad.last24Hours.focusedMinutes}m in the last 24h`,
    );
  }
  const wakingMinutes = minutesBetween(planningWindow.start, planningWindow.end);
  const sleepMinutes = Math.max(0, 24 * 60 - wakingMinutes);
  if (sleepMinutes <= 6 * 60) appliedSignals.push(`${Math.round(sleepMinutes / 60)}h sleep window needs recovery protection`);
  const existingPlan = savedPlan ? { id: savedPlan.id } : undefined;
  const protectedSessions = existingPlan
    ? db.prepare(`
        SELECT * FROM planned_focus_sessions
        WHERE plan_id = ? AND status IN ('started', 'completed')
        ORDER BY planned_start ASC
      `).all(existingPlan.id) as PlannedFocusSession[]
    : [];
  const protectedBusy = protectedSessions
    .filter(session => session.status === 'started')
    .map(session => ({
      id: `protected:${session.id}`,
      title: `Active focus: ${session.title}`,
      start_time: session.planned_start,
      end_time: session.planned_end,
    }));
  const constraintEvents = typedConstraints.map((constraint, index) => ({
    id: `typed:${index}`,
    title: constraint.title,
    start_time: constraint.startIso,
    end_time: constraint.endIso,
  }));
  const effectiveCalendarEvents = [...interpretedContext.effectiveCalendarEvents, ...constraintEvents, ...protectedBusy];
  const experimentBias = getCombinedPlannerBias({ snapshot, planDate });
  const candidateTasks = loadCandidateTasks(snapshot, workIntention, input.selectedTaskIds, planDate, experimentBias);
  const windows = buildAvailability(planDate, wakeEstimate, sleepTime, effectiveCalendarEvents, notBefore);

  const summaryParts = [
    intention ? `intention: ${intention}` : 'no stated intention',
    `${candidateTasks.length} candidate task${candidateTasks.length === 1 ? '' : 's'}`,
    `${windows.length} open calendar window${windows.length === 1 ? '' : 's'}`,
    `${focusLoad.last24Hours.sessionCount} sessions / ${focusLoad.last24Hours.focusedMinutes}m in the last 24h`,
    interpretedContext.ignoredCalendarEventIds.length
      ? `${interpretedContext.ignoredCalendarEventIds.length} calendar item${interpretedContext.ignoredCalendarEventIds.length === 1 ? '' : 's'} ignored for this plan`
      : null,
    `${planEnergy} energy`,
    planMood ? `${planMood} mood` : null,
    experimentBias.active
      ? `${experimentBias.source || 'experiment'}: ${experimentBias.kind}`
      : null,
  ];

  const planId = db.transaction(() => {
    db.prepare(`
      INSERT INTO daily_plans (
        plan_date, source_checkin_id, sleep_time, wake_estimate, mood, energy,
        evening_notes, tomorrow_intention, generated_summary, generation_source, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now', 'localtime'))
      ON CONFLICT(plan_date) DO UPDATE SET
        source_checkin_id = excluded.source_checkin_id,
        sleep_time = excluded.sleep_time,
        wake_estimate = excluded.wake_estimate,
        mood = excluded.mood,
        energy = excluded.energy,
        evening_notes = excluded.evening_notes,
        tomorrow_intention = excluded.tomorrow_intention,
        generated_summary = excluded.generated_summary,
        generation_source = excluded.generation_source,
        status = 'active',
        updated_at = datetime('now', 'localtime')
    `).run(
      planDate,
      sourceCheckinId,
      sleepTime,
      wakeEstimate,
      planMood,
      planEnergy,
      eveningNotes,
      intention,
      summaryParts.filter(Boolean).join('; '),
      contextSource,
    );

    const plan = db.prepare('SELECT id FROM daily_plans WHERE plan_date = ?').get(planDate) as { id: number };
    db.prepare("UPDATE plan_constraints SET status='superseded', updated_at=datetime('now','localtime') WHERE plan_id=? AND status='active'").run(plan.id);
    const insertConstraint = db.prepare(`
      INSERT INTO plan_constraints (
        id, plan_id, title, start_time, end_time, source_text, source_checkin_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `);
    for (const constraint of typedConstraints) {
      insertConstraint.run(
        `pc_${randomUUID()}`,
        plan.id,
        constraint.title,
        constraint.startIso,
        constraint.endIso,
        constraint.sourceText,
        sourceCheckinId,
      );
    }
    return plan.id;
  })();

  if (input.regenerate !== false) {
    let llmSessions: LLMPlannedSessionSpec[] | null = null;
    try {
      llmSessions = await synthesizePlanWithLLM({
        planDate,
        intention: workIntention,
        eveningNotes,
        sleepTime,
        wakeEstimate,
        calendarEvents: effectiveCalendarEvents,
        candidateTasks,
        snapshot,
        focusLoad,
        appliedSignals,
        notBefore,
        freshText: [intention, eveningNotes].filter(Boolean).join('\n'),
      });
    } catch (error) {
      console.warn(`[LLM Planner] Rejected complete AI result; using deterministic fallback: ${String(error)}`);
      llmSessions = null;
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE planned_focus_sessions
        SET status = 'skipped', updated_at = datetime('now', 'localtime')
        WHERE plan_id = ? AND status = 'planned' AND julianday(planned_start) <= julianday(?)
      `).run(planId, new Date().toISOString());
      const replaceable = db.prepare(`
        SELECT id, soft_watch_id FROM planned_focus_sessions
        WHERE plan_id = ? AND status = 'planned'
      `).all(planId) as Array<{ id: string; soft_watch_id: string | null }>;
      for (const row of replaceable) {
        if (row.soft_watch_id) {
          db.prepare("UPDATE soft_watch_commitments SET status = 'dismissed' WHERE id = ? AND status = 'pending'").run(row.soft_watch_id);
        }
      }
      db.prepare("DELETE FROM planned_focus_sessions WHERE plan_id = ? AND status = 'planned'").run(planId);
    })();

    if (llmSessions && llmSessions.length > 0) {
      for (const spec of llmSessions) {
        const { row, pricedRule } = db.transaction(() => {
          let finalTaskId: number | null = null;
          let matchingTask: CandidateTask;

          const existingCandidate = candidateTasks.find(t => t.id === spec.taskId && t.id > 0);
          if (existingCandidate) {
            matchingTask = existingCandidate;
            finalTaskId = existingCandidate.id;
          // Synchronize existing task's target focus minutes with the AI planned session block duration
          try {
            db.prepare('UPDATE tasks SET estimated_minutes = ?, due_date = ? WHERE id = ?')
              .run(spec.durationMinutes, planDate, finalTaskId);
          } catch { /* non-critical */ }
          matchingTask.estimated_minutes = spec.durationMinutes;
          matchingTask.remaining_minutes = spec.durationMinutes;
          } else {
          // Auto-materialize task card in `tasks` table so it appears in /tasks
          const maxPos = db.prepare(
            'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM tasks WHERE status = ?'
          ).get('todo') as { next_pos: number };

          const stmt = db.prepare(`
            INSERT INTO tasks (
              title, description, status, due_date, task_type, position, priority, estimated_minutes, energy_required
            ) VALUES (?, ?, 'todo', ?, ?, ?, 'high', ?, ?)
          `);

          const proposedTitle = spec.proposedTask?.title?.trim() || spec.title;
          const res = stmt.run(
            proposedTitle,
            spec.reason || 'Synthesized from next-day planner intention',
            planDate,
            spec.sessionType || 'study',
            maxPos.next_pos,
            spec.durationMinutes,
            snapshot.userState.energy
          );

          finalTaskId = Number(res.lastInsertRowid);
          matchingTask = {
            id: finalTaskId,
            title: proposedTitle,
            status: 'todo',
            priority: 'high',
            task_type: spec.sessionType || 'study',
            course: null,
            goal_id: null,
            goal_title: null,
            energy_required: snapshot.userState.energy,
            estimated_minutes: spec.durationMinutes,
            credited_minutes: 0,
            linked_sessions: 0,
            avg_focus_score: null,
            last_credited_at: null,
            remaining_minutes: spec.durationMinutes,
            session_feedback_duration_delta: 0,
            session_feedback_reason: null,
            due_date: planDate,
            score: 100,
            reason: spec.reason || 'synthesized from natural language intention',
          };
          }

          const rule: SessionRule = {
          mode: spec.sessionType || 'study',
          preferredMinutes: spec.durationMinutes,
          minMinutes: 15,
          maxMinutes: 120,
          breakMinutes: 10,
          guidance: spec.reason || 'AI scheduled focus block',
          tools: ['notes'],
        };

          const reward = computeReward(matchingTask, spec.durationMinutes, rule, snapshot);
          const pricedRule = { ...rule, rewardReason: reward.reason, taskReason: spec.reason };
          const sessionId = `pfs_${randomUUID()}`;
          const softWatchId = `nextday_${sessionId}`;

          const row: PlannedFocusSession = {
          id: sessionId,
          plan_id: planId,
          task_id: finalTaskId,
          title: spec.title || matchingTask.title,
          planned_start: spec.startIso,
          planned_end: spec.endIso,
          duration_minutes: spec.durationMinutes,
          session_type: rule.mode,
          rule_json: serializeRule(pricedRule, matchingTask),
          reward_xp: reward.xp,
          reward_coins: reward.coins,
          calendar_event_id: null,
          calendar_status: 'not_configured',
          soft_watch_id: softWatchId,
          status: 'planned',
          origin: existingCandidate ? 'ai_existing_task' : 'ai_proposed_task',
        };

          db.prepare(`
          INSERT INTO planned_focus_sessions (
            id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
            session_type, rule_json, reward_xp, reward_coins, calendar_status, soft_watch_id, status, origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
        `).run(
          row.id,
          row.plan_id,
          row.task_id,
          row.title,
          row.planned_start,
          row.planned_end,
          row.duration_minutes,
          row.session_type,
          row.rule_json,
          row.reward_xp,
          row.reward_coins,
          row.calendar_status,
          row.soft_watch_id,
          row.origin
        );

          insertSoftWatch({
          id: softWatchId,
          title: row.title,
          taskId: matchingTask.id > 0 ? matchingTask.id : null,
          goalId: matchingTask.goal_id,
          start: new Date(spec.startIso),
            durationMinutes: row.duration_minutes,
          });
          return { row, pricedRule };
        })();

        if (input.syncCalendar || isCalendarConfigured()) {
          const calendar = await syncSessionCalendar(row, pricedRule, snapshot);
          db.prepare(`
            UPDATE planned_focus_sessions
            SET calendar_event_id = ?, calendar_status = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
          `).run(calendar.eventId, calendar.status, row.id);
        }
      }

      // Aggregate total planned focus duration per task for this plan and update tasks table
      const taskSums = db.prepare(`
        SELECT task_id, SUM(duration_minutes) as total_planned
        FROM planned_focus_sessions
        WHERE plan_id = ? AND task_id IS NOT NULL AND task_id > 0 AND status != 'cancelled'
        GROUP BY task_id
      `).all(planId) as Array<{ task_id: number; total_planned: number }>;

      for (const item of taskSums) {
        try {
          db.prepare(`
            UPDATE tasks
            SET estimated_minutes = ?, due_date = ?
            WHERE id = ?
          `).run(item.total_planned, planDate, item.task_id);
        } catch { /* non-critical */ }
      }
    } else {
      let windowIndex = 0;
      let cursor = windows[0]?.start ? new Date(windows[0].start) : null;

      for (const task of candidateTasks) {
        if (!cursor || windowIndex >= windows.length) break;
        if (!shouldScheduleCandidate({ task, snapshot, selectedTaskIds: input.selectedTaskIds, planDate })) continue;
        const rule = deriveSessionRule(task, snapshot, experimentBias, planDate);
        let remaining = task.remaining_minutes;
        if (
          experimentBias.active
          && experimentBias.kind === 'activation_block'
          && taskMatchesCoachBias(task, experimentBias, planDate)
        ) {
          remaining = Math.min(remaining, experimentBias.preferredActivationMinutes || 15);
        }

        while (remaining > 0 && cursor && windowIndex < windows.length) {
          const currentWindow = windows[windowIndex];
          if (cursor < currentWindow.start) cursor = new Date(currentWindow.start);
          const available = minutesBetween(cursor, currentWindow.end);
          if (available < rule.minMinutes) {
            windowIndex += 1;
            cursor = windows[windowIndex]?.start ? new Date(windows[windowIndex].start) : null;
            continue;
          }

          const duration = Math.min(rule.preferredMinutes, remaining, available);
          const roundedDuration = clampMinutes(duration, Math.min(rule.minMinutes, available), Math.min(rule.maxMinutes, available));
          const start = new Date(cursor);
          const end = new Date(start.getTime() + roundedDuration * 60000);
          const reward = computeReward(task, roundedDuration, rule, snapshot);
          const pricedRule = { ...rule, rewardReason: reward.reason };
          const sessionId = `pfs_${randomUUID()}`;
          const softWatchId = `nextday_${sessionId}`;

          const row = db.transaction(() => {
            let fallbackTaskId: number | null = task.id > 0 ? task.id : null;
            if (!fallbackTaskId) {
            const maxPos = db.prepare(
              'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM tasks WHERE status = ?'
            ).get('todo') as { next_pos: number };

            const stmt = db.prepare(`
              INSERT INTO tasks (
                title, description, status, due_date, task_type, position, priority, estimated_minutes, energy_required
              ) VALUES (?, ?, 'todo', ?, ?, ?, 'high', ?, ?)
            `);

            const res = stmt.run(
              task.title,
              'Derived from next-day planner intention',
              planDate,
              task.task_type || 'study',
              maxPos.next_pos,
              task.estimated_minutes,
              snapshot.userState.energy
            );
              fallbackTaskId = Number(res.lastInsertRowid);
            }

            const plannedRow: PlannedFocusSession = {
            id: sessionId,
            plan_id: planId,
            task_id: fallbackTaskId,
            title: task.title,
            planned_start: toSqlDateTime(start),
            planned_end: toSqlDateTime(end),
            duration_minutes: roundedDuration,
            session_type: rule.mode,
            rule_json: serializeRule(pricedRule, task),
            reward_xp: reward.xp,
            reward_coins: reward.coins,
            calendar_event_id: null,
            calendar_status: 'not_configured',
            soft_watch_id: softWatchId,
            status: 'planned',
            origin: 'deterministic_task',
          };

            db.prepare(`
            INSERT INTO planned_focus_sessions (
              id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
              session_type, rule_json, reward_xp, reward_coins, calendar_status, soft_watch_id, status, origin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
          `).run(
            plannedRow.id,
            plannedRow.plan_id,
            plannedRow.task_id,
            plannedRow.title,
            plannedRow.planned_start,
            plannedRow.planned_end,
            plannedRow.duration_minutes,
            plannedRow.session_type,
            plannedRow.rule_json,
            plannedRow.reward_xp,
            plannedRow.reward_coins,
            plannedRow.calendar_status,
            plannedRow.soft_watch_id,
            plannedRow.origin
          );

            insertSoftWatch({
              id: softWatchId,
              title: plannedRow.title,
              taskId: fallbackTaskId,
              goalId: task.goal_id,
              start,
              durationMinutes: plannedRow.duration_minutes,
            });
            return plannedRow;
          })();

          if (input.syncCalendar) {
            const calendar = await syncSessionCalendar(row, pricedRule, snapshot);
            db.prepare(`
              UPDATE planned_focus_sessions
              SET calendar_event_id = ?, calendar_status = ?, updated_at = datetime('now', 'localtime')
              WHERE id = ?
            `).run(calendar.eventId, calendar.status, row.id);
          }

          remaining -= roundedDuration;
          cursor = new Date(end.getTime() + rule.breakMinutes * 60000);
          if (minutesBetween(cursor, currentWindow.end) < rule.minMinutes) {
            windowIndex += 1;
            cursor = windows[windowIndex]?.start ? new Date(windows[windowIndex].start) : null;
          }
        }
      }
    }
  }

  const reconciliation = await reconcilePlanningState(planDate, new Date(), { regenerate: false });
  return { ...getNextDayPlan(planDate), reconciliation };
}

export function getNextDayPlan(planDate = normalizeDate()): NextDayPlanPayload {
  const db = getDb();
  const normalizedDate = normalizeDate(planDate);
  const baseSnapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 3,
    includeMemoryFacts: 4,
  });
  const exactCheckin = loadEveningCheckinForPlanDate(normalizedDate);
  const plan = db.prepare(`
    SELECT * FROM daily_plans
    WHERE plan_date = ? AND status != 'archived'
    LIMIT 1
  `).get(normalizedDate) as DailyPlan | undefined;
  const planContextIsFresh = Boolean(plan && (
    plan.generation_source === 'live_truth'
    || plan.generation_source === 'submitted_input'
    || (plan.source_checkin_id && plan.source_checkin_id === exactCheckin?.id)
    || (!plan.source_checkin_id && !plan.tomorrow_intention && !plan.evening_notes)
  ));
  const effectivePlan = planContextIsFresh ? plan : undefined;
  const snapshot = applyPlanningStateToSnapshot(baseSnapshot, {
    mood: effectivePlan?.mood ?? exactCheckin?.mood,
    energy: effectivePlan?.energy ?? exactCheckin?.energy,
  });
  const sessions = plan
    ? db.prepare(`
        SELECT * FROM planned_focus_sessions
        WHERE plan_id = ?
        ORDER BY planned_start ASC
      `).all(plan.id) as PlannedFocusSession[]
	    : [];
  const constraints = plan
    ? db.prepare(`
        SELECT * FROM plan_constraints
        WHERE plan_id = ? AND status = 'active'
        ORDER BY start_time ASC
      `).all(plan.id) as PlanConstraint[]
    : [];
  const suggestedInputs = buildPlanningSuggestedInputs({ plan: effectivePlan, exactCheckin, snapshot });
  const sleepTime = normalizeTime(effectivePlan?.sleep_time, suggestedInputs.sleepTime);
  const wakeEstimate = normalizeTime(effectivePlan?.wake_estimate, suggestedInputs.wakeEstimate);
  const planningWindow = buildPlanningDayWindow(normalizedDate, wakeEstimate, sleepTime);
  const calendarEndDate = planningWindow.spansMidnight ? addDays(normalizedDate, 1) : normalizedDate;
  const rawCalendarEvents = filterCalendarEventsForPlanningWindow(
    getCalendarEvents(normalizedDate, calendarEndDate) as CalendarEventRow[],
    planningWindow,
  );
  const interpretedContext = interpretPlanningContext({
    intention: effectivePlan?.tomorrow_intention ?? exactCheckin?.tomorrow_intention ?? null,
    eveningNotes: effectivePlan?.evening_notes ?? exactCheckin?.day_events ?? null,
    calendarEvents: rawCalendarEvents,
  });
  const focusLoad = loadPlanningFocusLoad({ windowStart: planningWindow.start });
  const signals = [...interpretedContext.signals];
  if (focusLoad.last24Hours.sessionCount > 0) {
    signals.push(
      `${focusLoad.last24Hours.sessionCount} focus session${focusLoad.last24Hours.sessionCount === 1 ? '' : 's'} / ${focusLoad.last24Hours.focusedMinutes}m in the last 24h`,
    );
  }
  const wakingMinutes = minutesBetween(planningWindow.start, planningWindow.end);
  const sleepMinutes = Math.max(0, 24 * 60 - wakingMinutes);
  if (sleepMinutes <= 6 * 60) signals.push(`${Math.round(sleepMinutes / 60)}h sleep window needs recovery protection`);

  const readBias = getCombinedPlannerBias({ snapshot, planDate: normalizedDate });
  return {
    plan: plan ?? null,
    sessions,
    constraints,
    calendarEvents: interpretedContext.calendarEvents,
    candidateTasks: loadCandidateTasks(
      snapshot,
      stripConstraintText(
        effectivePlan?.tomorrow_intention ?? exactCheckin?.tomorrow_intention ?? null,
        constraints.map(constraint => ({
          title: constraint.title,
          startIso: constraint.start_time,
          endIso: constraint.end_time,
          sourceText: constraint.source_text,
        })),
      ),
      undefined,
      normalizedDate,
      readBias,
    ).slice(0, 20),
    personalization: {
      mode: snapshot.moment.mode,
      energy: snapshot.userState.energy,
      mood: snapshot.userState.mood,
      learnedSprintMinutes: getAdaptiveSessionMinutes(),
      bestFocusWindow: snapshot.userState.nextBestFocusWindow,
    },
    suggestedInputs,
    calendarConfigured: isCalendarConfigured(),
    dayContext: {
      relation: planningDateRelation(normalizedDate),
      windowStart: planningWindow.start.toISOString(),
      windowEnd: planningWindow.end.toISOString(),
      spansMidnight: planningWindow.spansMidnight,
      signals,
      ignoredCalendarEventIds: interpretedContext.ignoredCalendarEventIds,
      focusLoad,
    },
    contextProvenance: {
      source: effectivePlan && ['submitted_input', 'saved_plan', 'exact_date_checkin', 'live_truth'].includes(effectivePlan.generation_source || '')
        ? effectivePlan.generation_source as NextDayPlanPayload['contextProvenance']['source']
        : exactCheckin ? 'exact_date_checkin' : 'live_truth',
      appliesToPlanDate: normalizedDate,
      sourceCheckinId: effectivePlan?.source_checkin_id ?? exactCheckin?.id ?? null,
      fresh: Boolean(effectivePlan || exactCheckin) || !plan,
    },
    reconciliation: {
      planDate: normalizedDate,
      repairedSessionIds: [],
      repairedConstraintIds: [],
      reasonCodes: [],
      calendarDeletionFailures: [],
      regenerated: false,
    },
  };
}

export async function updatePlannedFocusSession(id: string, patch: {
  title?: string;
  plannedStart?: string;
  plannedEnd?: string;
  status?: SessionStatus;
  taskId?: number | null;
  syncCalendar?: boolean;
}): Promise<PlannedFocusSession | null> {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM planned_focus_sessions WHERE id = ?').get(id) as PlannedFocusSession | undefined;
  if (!existing) return null;

  const title = patch.title?.trim() || existing.title;
  const plannedStart = patch.plannedStart ? new Date(patch.plannedStart) : new Date(existing.planned_start);
  const plannedEnd = patch.plannedEnd ? new Date(patch.plannedEnd) : new Date(existing.planned_end);
  const durationMinutes = Math.max(5, minutesBetween(plannedStart, plannedEnd));
  const status = patch.status ?? existing.status;
  const taskId = patch.taskId !== undefined ? patch.taskId : existing.task_id;
  const snapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 2,
    includeMemoryFacts: 4,
  });
  const task = candidateForPlannedSession({ taskId, title, durationMinutes, snapshot });
  const planDate = toSqlDateTime(plannedStart).slice(0, 10);
  const bias = getCombinedPlannerBias({ snapshot, planDate });
  const rule = deriveSessionRule(task, snapshot, bias, planDate);
  const reward = computeReward(task, durationMinutes, rule, snapshot);
  const pricedRule = { ...rule, rewardReason: reward.reason };

  db.prepare(`
    UPDATE planned_focus_sessions
    SET title = ?, task_id = ?, planned_start = ?, planned_end = ?, duration_minutes = ?,
        session_type = ?, rule_json = ?, reward_xp = ?, reward_coins = ?,
        status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    title,
    taskId,
    toSqlDateTime(plannedStart),
    toSqlDateTime(plannedEnd),
    durationMinutes,
    pricedRule.mode,
    serializeRule(pricedRule, task),
    reward.xp,
    reward.coins,
    status,
    id
  );

  if (existing.soft_watch_id) {
    db.prepare(`
      UPDATE soft_watch_commitments
      SET target_title = ?, task_id = ?, intended_start_at = ?, planned_minutes = ?,
          status = CASE WHEN ? = 'cancelled' THEN 'dismissed' ELSE status END
      WHERE id = ?
    `).run(title, taskId, plannedStart.getTime(), durationMinutes, status, existing.soft_watch_id);
  }

  // Synchronize linked task card in `tasks` table so /tasks reflects title, estimate, and due date
  if (taskId && taskId > 0) {
    try {
      db.prepare(`
        UPDATE tasks
        SET title = ?, estimated_minutes = ?, due_date = ?
        WHERE id = ?
      `).run(title, durationMinutes, planDate, taskId);
    } catch { /* non-critical */ }
  }

  const shouldSyncCalendar = patch.syncCalendar !== false && (patch.syncCalendar || isCalendarConfigured() || !!existing.calendar_event_id);
  if (shouldSyncCalendar) {
    const description = `LifeOS next-day plan\n${pricedRule.guidance}\nReward: ${reward.xp} XP / ${reward.coins} coins\n${reward.reason}`;
    if (existing.calendar_event_id) {
      const ok = await updateCalendarEvent(existing.calendar_event_id, {
        summary: `Focus: ${title}`,
        description,
        startTime: plannedStart,
        endTime: plannedEnd,
        reminderSnapshot: snapshot,
      });
      db.prepare('UPDATE planned_focus_sessions SET calendar_status = ? WHERE id = ?').run(ok ? 'synced' : 'failed', id);
    } else if (isCalendarConfigured()) {
      const eventId = await createCalendarEvent({
        summary: `Focus: ${title}`,
        description,
        startTime: plannedStart,
        endTime: plannedEnd,
        colorId: '9',
        reminderSnapshot: snapshot,
      });
      db.prepare(`
        UPDATE planned_focus_sessions
        SET calendar_event_id = ?, calendar_status = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(eventId, eventId ? 'created' : 'failed', id);
      if (eventId && existing.soft_watch_id) {
        db.prepare(`
          UPDATE soft_watch_commitments
          SET calendar_event_id = ?
          WHERE id = ?
        `).run(eventId, existing.soft_watch_id);
      }
    } else {
      db.prepare('UPDATE planned_focus_sessions SET calendar_status = ? WHERE id = ?').run('not_configured', id);
    }
  }

  const planRow = db.prepare(`
    SELECT dp.plan_date
    FROM planned_focus_sessions pfs
    JOIN daily_plans dp ON dp.id = pfs.plan_id
    WHERE pfs.id = ?
  `).get(id) as { plan_date: string } | undefined;
  if (planRow) await reconcilePlanningState(planRow.plan_date, new Date(), { regenerate: false });
  return db.prepare('SELECT * FROM planned_focus_sessions WHERE id = ?').get(id) as PlannedFocusSession;
}

export async function cancelPlannedFocusSession(id: string, syncCalendar = true): Promise<boolean> {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM planned_focus_sessions WHERE id = ?').get(id) as PlannedFocusSession | undefined;
  if (!existing) return false;

  let calendarStatus = existing.calendar_status;
  if (syncCalendar && existing.calendar_event_id) {
    const ok = await deleteCalendarEvent(existing.calendar_event_id);
    calendarStatus = ok ? 'deleted' : 'failed';
  }

  if (existing.soft_watch_id) {
    db.prepare("UPDATE soft_watch_commitments SET status = 'dismissed' WHERE id = ?").run(existing.soft_watch_id);
  }

  db.prepare(`
    UPDATE planned_focus_sessions
    SET status = 'cancelled', calendar_status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(calendarStatus, id);

  const planRow = db.prepare(`
    SELECT dp.plan_date
    FROM planned_focus_sessions pfs
    JOIN daily_plans dp ON dp.id = pfs.plan_id
    WHERE pfs.id = ?
  `).get(id) as { plan_date: string } | undefined;
  if (planRow) await reconcilePlanningState(planRow.plan_date, new Date(), { regenerate: false });

  return true;
}

export async function syncAllPlannedSessionsToCalendar(planDate = normalizeDate()): Promise<{
  configured: boolean;
  syncedCount: number;
  authUrl?: string;
  message: string;
}> {
  const db = getDb();
  const normalizedDate = normalizeDate(planDate);
  let plan = db.prepare('SELECT id, plan_date FROM daily_plans WHERE plan_date = ?').get(normalizedDate) as { id: number; plan_date: string } | undefined;

  if (!plan) {
    plan = db.prepare('SELECT id, plan_date FROM daily_plans ORDER BY plan_date DESC, created_at DESC LIMIT 1').get() as { id: number; plan_date: string } | undefined;
  }

  if (!plan) {
    return {
      configured: isCalendarConfigured(),
      syncedCount: 0,
      message: `No plan found for ${normalizedDate}. Please generate a plan first.`,
    };
  }

  const sessions = db.prepare(`
    SELECT * FROM planned_focus_sessions
    WHERE plan_id = ? AND status != 'cancelled'
  `).all(plan.id) as PlannedFocusSession[];

  if (sessions.length === 0) {
    return {
      configured: isCalendarConfigured(),
      syncedCount: 0,
      message: 'No sessions to sync for this date.',
    };
  }

  if (!isCalendarConfigured()) {
    return {
      configured: false,
      syncedCount: 0,
      authUrl: '/api/calendar/google/auth',
      message: 'Google Calendar is not connected yet. Click to connect your account.',
    };
  }

  const snapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 2,
    includeMemoryFacts: 3,
  });

  let syncedCount = 0;
  for (const session of sessions) {
    const rule: SessionRule = {
      mode: (session.session_type as SessionRule['mode']) || 'study',
      preferredMinutes: session.duration_minutes,
      minMinutes: 15,
      maxMinutes: 120,
      breakMinutes: 10,
      guidance: 'Personalized focus block',
      tools: ['notes'],
      ...(() => { try { return JSON.parse(session.rule_json); } catch { return {}; } })(),
    };
    const calendar = await syncSessionCalendar(session, rule, snapshot);
    if (calendar.eventId) {
      db.prepare(`
        UPDATE planned_focus_sessions
        SET calendar_event_id = ?, calendar_status = 'created', updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(calendar.eventId, session.id);
      syncedCount++;
    }
  }

  await reconcilePlanningState(plan.plan_date, new Date(), { regenerate: false });

  return {
    configured: true,
    syncedCount,
    message: `Successfully synced ${syncedCount} focus session block${syncedCount === 1 ? '' : 's'} to Google Calendar!`,
  };
}
