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
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';
import { getAdaptiveRewardDecision, getAdaptiveTaskRewardBase } from './adaptive-rewards';

type SessionStatus = 'planned' | 'started' | 'completed' | 'skipped' | 'cancelled';

interface CalendarEventRow {
  title: string;
  start_time: string;
  end_time: string;
}

interface CandidateTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  goal_id: number | null;
  goal_title: string | null;
  energy_required: string;
  estimated_minutes: number;
  credited_minutes: number;
  remaining_minutes: number;
  due_date: string | null;
  score: number;
  reason: string;
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
}

export interface NextDayPlanPayload {
  plan: DailyPlan | null;
  sessions: PlannedFocusSession[];
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
}

export interface PlanningSuggestedInputs {
  sleepTime: string;
  wakeEstimate: string;
  mood: PersonalizationSnapshot['userState']['mood'] | 'medium';
  energy: PersonalizationSnapshot['userState']['energy'];
  source: 'existing_plan' | 'latest_evening_checkin' | 'sleep_history' | 'adaptive_baseline';
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

function toSqlDateTime(date: Date): string {
  return date.toISOString();
}

function clampMinutes(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value / 5) * 5));
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

function loadLatestEveningCheckin() {
  return getDb().prepare(`
    SELECT id, sleep_time, wake_estimate, mood, energy, day_events, tomorrow_intention, raw_transcript
    FROM daily_checkins
    WHERE checkin_type = 'evening'
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get() as {
    id: number;
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    day_events: string | null;
    tomorrow_intention: string | null;
    raw_transcript: string | null;
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
  latestCheckin?: ReturnType<typeof loadLatestEveningCheckin>;
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

  if (input.latestCheckin?.sleep_time || input.latestCheckin?.wake_estimate) {
    const wake = normalizeTime(input.latestCheckin.wake_estimate, normalizeTime(getSetting('morning_brief_time'), '08:00'));
    return {
      sleepTime: normalizeTime(input.latestCheckin.sleep_time, shiftTime(wake, -8 * 60)),
      wakeEstimate: wake,
      mood: (input.latestCheckin.mood as PlanningSuggestedInputs['mood']) || input.snapshot.userState.mood || 'medium',
      energy: (input.latestCheckin.energy as PlanningSuggestedInputs['energy']) || input.snapshot.userState.energy,
      source: 'latest_evening_checkin',
      reason: 'using your latest evening sleep/wake update',
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
    WHERE checkin_date = ? AND checkin_type = 'evening'
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get(today) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE daily_checkins
      SET sleep_time = COALESCE(?, sleep_time),
          wake_estimate = COALESCE(?, wake_estimate),
          mood = COALESCE(?, mood),
          energy = COALESCE(?, energy),
          day_events = COALESCE(?, day_events),
          tomorrow_intention = COALESCE(?, tomorrow_intention),
          raw_transcript = CASE WHEN ? != '' THEN ? ELSE raw_transcript END
      WHERE id = ?
    `).run(
      input.sleepTime ?? null,
      input.wakeEstimate ?? null,
      input.mood ?? null,
      input.energy ?? null,
      input.eveningNotes ?? null,
      input.tomorrowIntention ?? null,
      raw,
      raw,
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO daily_checkins (
      checkin_date, checkin_type, sleep_time, wake_estimate, mood, energy,
      day_events, tomorrow_intention, raw_transcript
    )
    VALUES (?, 'evening', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    today,
    input.sleepTime ?? null,
    input.wakeEstimate ?? null,
    input.mood ?? null,
    input.energy ?? null,
    input.eveningNotes ?? null,
    input.tomorrowIntention ?? null,
    raw
  );
  return Number(result.lastInsertRowid);
}

function loadCandidateTasks(
  snapshot: PersonalizationSnapshot,
  intention: string | null,
  selectedTaskIds: number[] | undefined,
  planDate: string
): CandidateTask[] {
  const db = getDb();
  const selected = selectedTaskIds && selectedTaskIds.length > 0 ? new Set(selectedTaskIds) : null;
  const learnedEstimate = getAdaptiveSessionMinutes();
  const rows = db.prepare(`
    SELECT
      t.id,
      t.title,
      t.status,
      COALESCE(t.priority, 'medium') as priority,
      t.goal_id,
      g.title as goal_title,
      COALESCE(t.energy_required, 'medium') as energy_required,
      COALESCE(t.estimated_minutes, ?) as estimated_minutes,
      COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
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
  return rows
    .map((task) => {
      const target = Math.max(15, Math.round(Number(task.estimated_minutes || learnedEstimate)));
      const credited = Math.round(Number(task.credited_minutes || 0));
      const remaining = Math.max(0, target - credited);
      const reasons: string[] = [];
      let score = 0;

      score += PRIORITY_WEIGHT[task.priority] ?? PRIORITY_WEIGHT.medium;
      score += STATUS_WEIGHT[task.status] ?? 10;
      if (selected?.has(task.id)) { score += 80; reasons.push('chosen for tomorrow'); }
      if (textMatches(task.title, intention) || textMatches(task.goal_title ?? '', intention)) {
        score += 35;
        reasons.push('matches tomorrow intention');
      }
      if (task.status === 'doing') reasons.push('already in progress');
      if (task.due_date && task.due_date <= planDate) { score += 22; reasons.push('due soon'); }
      if (energy === 'high' && task.energy_required === 'high') { score += 12; reasons.push('high-energy fit'); }
      if (energy === 'low' && task.energy_required === 'low') { score += 12; reasons.push('low-energy fit'); }
      if (energy === 'low' && task.energy_required === 'high') { score -= 18; reasons.push('defer if drained'); }
      if (remaining <= 0) score -= 100;
      if (remaining > 0 && remaining <= getAdaptiveSessionMinutes()) { score += 8; reasons.push('close to completion'); }

      return {
        ...task,
        estimated_minutes: target,
        credited_minutes: credited,
        remaining_minutes: remaining,
        score,
        reason: reasons.join(', ') || 'open time-target task',
      };
    })
    .filter(task => task.remaining_minutes > 0)
    .filter(task => !selected || selected.has(task.id))
    .sort((a, b) => b.score - a.score);
}

function deriveSessionRule(task: CandidateTask, snapshot: PersonalizationSnapshot): SessionRule {
  const text = `${task.title} ${task.goal_title ?? ''}`.toLowerCase();
  const learned = getAdaptiveSessionMinutes();
  const energy = snapshot.userState.energy;
  const energyMultiplier = energy === 'high' ? 1.1 : energy === 'low' ? 0.8 : 1;

  if (/(math|problem|academy|exercise|drill|proof)/.test(text)) {
    return {
      mode: 'problem_practice',
      preferredMinutes: clampMinutes(30 * energyMultiplier, 20, 40),
      minMinutes: 20,
      maxMinutes: 45,
      breakMinutes: 7,
      guidance: 'Use short, closed-loop practice blocks and review mistakes before extending.',
      tools: ['Math Academy', 'notes'],
    };
  }

  if (/(paper|research|read|reading|domain|concept|google|literature|survey)/.test(text)) {
    return {
      mode: 'research_reading',
      preferredMinutes: clampMinutes(Math.max(45, learned) * energyMultiplier, 35, 70),
      minMinutes: 30,
      maxMinutes: 75,
      breakMinutes: 10,
      guidance: 'Use longer exploration blocks with explicit concept capture and unclear-question follow-up.',
      tools: ['browser', 'ChatGPT', 'notes'],
    };
  }

  if (/(code|build|debug|implement|ship|pr|repo|test)/.test(text)) {
    return {
      mode: 'coding_build',
      preferredMinutes: clampMinutes(Math.max(45, learned) * energyMultiplier, 35, 80),
      minMinutes: 30,
      maxMinutes: 90,
      breakMinutes: 10,
      guidance: 'Use build/test checkpoints and stop with the next concrete handoff written down.',
      tools: ['editor', 'terminal', 'tests'],
    };
  }

  return {
    mode: 'study',
    preferredMinutes: clampMinutes(learned * energyMultiplier, 25, 60),
    minMinutes: 20,
    maxMinutes: 70,
    breakMinutes: 8,
    guidance: 'Use a focused study block and end by logging what changed in understanding.',
    tools: ['notes'],
  };
}

function computeReward(task: CandidateTask, durationMinutes: number, rule: SessionRule, snapshot: PersonalizationSnapshot) {
  const priority = PRIORITY_WEIGHT[task.priority] ?? PRIORITY_WEIGHT.medium;
  const difficulty = task.energy_required === 'high' ? 18 : task.energy_required === 'low' ? 6 : 12;
  const modeBonus = rule.mode === 'research_reading' || rule.mode === 'coding_build' ? 12 : 8;
  const xp = Math.max(20, Math.round((durationMinutes * 1.4) + priority + difficulty + modeBonus));
  const rewardBase = getAdaptiveTaskRewardBase({
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
  });
  return {
    xp,
    coins: reward.coins,
    reason: `${rewardBase.reason}; ${reward.reason}`,
  };
}

function buildAvailability(date: string, wakeEstimate: string, sleepTime: string, calendarEvents: CalendarEventRow[]): Window[] {
  const dayStart = istDate(date, wakeEstimate);
  let dayEnd = istDate(date, sleepTime);
  if (dayEnd <= dayStart) dayEnd = new Date(dayEnd.getTime() + 24 * 3600_000);

  const busy = calendarEvents
    .map(event => ({
      start: new Date(event.start_time),
      end: new Date(event.end_time),
    }))
    .filter(event => event.end > dayStart && event.start < dayEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const windows: Window[] = [];
  let cursor = new Date(dayStart.getTime() + 45 * 60000);
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

async function syncSessionCalendar(session: PlannedFocusSession, rule: SessionRule) {
  if (!isCalendarConfigured()) return { eventId: null, status: 'not_configured' as const };
  const eventId = await createCalendarEvent({
    summary: `Focus: ${session.title}`,
    description: `LifeOS next-day plan\n${rule.guidance}\nReward: ${session.reward_xp} XP / ${session.reward_coins} coins`,
    startTime: new Date(session.planned_start),
    endTime: new Date(session.planned_end),
    colorId: '9',
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
}): CandidateTask {
  const fallback: CandidateTask = {
    id: input.taskId ?? 0,
    title: input.title,
    status: 'planned',
    priority: 'medium',
    goal_id: null,
    goal_title: null,
    energy_required: 'medium',
    estimated_minutes: input.durationMinutes,
    credited_minutes: 0,
    remaining_minutes: input.durationMinutes,
    due_date: null,
    score: 0,
    reason: 'manual planned-session edit',
  };

  if (!input.taskId) return fallback;

  try {
    const row = getDb().prepare(`
      SELECT
        t.id,
        COALESCE(t.priority, 'medium') as priority,
        t.status,
        t.goal_id,
        g.title as goal_title,
        COALESCE(t.energy_required, 'medium') as energy_required,
        COALESCE(t.estimated_minutes, ?) as estimated_minutes,
        COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
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
  const latestCheckin = loadLatestEveningCheckin();
  const snapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 3,
    includeMemoryFacts: 4,
  });
  const suggestedInputs = buildPlanningSuggestedInputs({ latestCheckin, snapshot });
  const sourceCheckinId = upsertEveningCheckin(input, planDate) ?? latestCheckin?.id ?? null;
  const sleepTime = normalizeTime(input.sleepTime ?? latestCheckin?.sleep_time, suggestedInputs.sleepTime);
  const wakeEstimate = normalizeTime(input.wakeEstimate ?? latestCheckin?.wake_estimate, suggestedInputs.wakeEstimate);
  const intention = (input.tomorrowIntention ?? latestCheckin?.tomorrow_intention ?? '').trim() || null;
  const calendarEvents = getCalendarEvents(planDate, planDate) as CalendarEventRow[];
  const candidateTasks = loadCandidateTasks(snapshot, intention, input.selectedTaskIds, planDate);
  const windows = buildAvailability(planDate, wakeEstimate, sleepTime, calendarEvents);

  const planMood = input.mood ?? latestCheckin?.mood ?? snapshot.userState.mood;
  const planEnergy = input.energy ?? latestCheckin?.energy ?? snapshot.userState.energy;
  const eveningNotes = input.eveningNotes ?? latestCheckin?.day_events ?? null;

  const summaryParts = [
    intention ? `intention: ${intention}` : 'no stated intention',
    `${candidateTasks.length} candidate task${candidateTasks.length === 1 ? '' : 's'}`,
    `${windows.length} open calendar window${windows.length === 1 ? '' : 's'}`,
    `${planEnergy} energy`,
    planMood ? `${planMood} mood` : null,
  ];

  const planId = db.transaction(() => {
    db.prepare(`
      INSERT INTO daily_plans (
        plan_date, source_checkin_id, sleep_time, wake_estimate, mood, energy,
        evening_notes, tomorrow_intention, generated_summary, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now', 'localtime'))
      ON CONFLICT(plan_date) DO UPDATE SET
        source_checkin_id = excluded.source_checkin_id,
        sleep_time = excluded.sleep_time,
        wake_estimate = excluded.wake_estimate,
        mood = excluded.mood,
        energy = excluded.energy,
        evening_notes = excluded.evening_notes,
        tomorrow_intention = excluded.tomorrow_intention,
        generated_summary = excluded.generated_summary,
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
      summaryParts.filter(Boolean).join('; ')
    );

    const plan = db.prepare('SELECT id FROM daily_plans WHERE plan_date = ?').get(planDate) as { id: number };
    if (input.regenerate !== false) {
      const existing = db.prepare('SELECT id, soft_watch_id FROM planned_focus_sessions WHERE plan_id = ?').all(plan.id) as Array<{ id: string; soft_watch_id: string | null }>;
      for (const row of existing) {
        if (row.soft_watch_id) {
          db.prepare("UPDATE soft_watch_commitments SET status = 'dismissed' WHERE id = ? AND status = 'pending'").run(row.soft_watch_id);
        }
      }
      db.prepare('DELETE FROM planned_focus_sessions WHERE plan_id = ?').run(plan.id);
    }
    return plan.id;
  })();

  if (input.regenerate !== false) {
    let windowIndex = 0;
    let cursor = windows[0]?.start ? new Date(windows[0].start) : null;

    for (const task of candidateTasks) {
      if (!cursor || windowIndex >= windows.length) break;
      const rule = deriveSessionRule(task, snapshot);
      let remaining = task.remaining_minutes;

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
        const row: PlannedFocusSession = {
          id: sessionId,
          plan_id: planId,
          task_id: task.id,
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
        };

        db.prepare(`
          INSERT INTO planned_focus_sessions (
            id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
            session_type, rule_json, reward_xp, reward_coins, calendar_status, soft_watch_id, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
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
          row.soft_watch_id
        );
        insertSoftWatch({
          id: softWatchId,
          title: row.title,
          taskId: row.task_id,
          goalId: task.goal_id,
          start,
          durationMinutes: row.duration_minutes,
        });

        if (input.syncCalendar) {
          const calendar = await syncSessionCalendar(row, pricedRule);
          db.prepare(`
            UPDATE planned_focus_sessions
            SET calendar_event_id = ?, calendar_status = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
          `).run(calendar.eventId, calendar.status, row.id);
          insertSoftWatch({
            id: softWatchId,
            title: row.title,
            taskId: row.task_id,
            goalId: task.goal_id,
            start,
            durationMinutes: row.duration_minutes,
            calendarEventId: calendar.eventId,
          });
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

  return getNextDayPlan(planDate);
}

export function getNextDayPlan(planDate = normalizeDate()): NextDayPlanPayload {
  const db = getDb();
  const normalizedDate = normalizeDate(planDate);
  const snapshot = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 3,
    includeMemoryFacts: 4,
  });
  const latestCheckin = loadLatestEveningCheckin();
  const intention = latestCheckin?.tomorrow_intention ?? null;
  const plan = db.prepare(`
    SELECT * FROM daily_plans
    WHERE plan_date = ? AND status != 'archived'
    LIMIT 1
  `).get(normalizedDate) as DailyPlan | undefined;
  const sessions = plan
    ? db.prepare(`
        SELECT * FROM planned_focus_sessions
        WHERE plan_id = ?
        ORDER BY planned_start ASC
      `).all(plan.id) as PlannedFocusSession[]
	    : [];
  const suggestedInputs = buildPlanningSuggestedInputs({ plan, latestCheckin, snapshot });

  return {
    plan: plan ?? null,
    sessions,
    calendarEvents: getCalendarEvents(normalizedDate, normalizedDate) as CalendarEventRow[],
    candidateTasks: loadCandidateTasks(snapshot, plan?.tomorrow_intention ?? intention, undefined, normalizedDate).slice(0, 20),
    personalization: {
      mode: snapshot.moment.mode,
      energy: snapshot.userState.energy,
      mood: snapshot.userState.mood,
      learnedSprintMinutes: getAdaptiveSessionMinutes(),
      bestFocusWindow: snapshot.userState.nextBestFocusWindow,
    },
    suggestedInputs,
    calendarConfigured: isCalendarConfigured(),
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
  const task = candidateForPlannedSession({ taskId, title, durationMinutes });
  const rule = deriveSessionRule(task, snapshot);
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

  if (patch.syncCalendar && existing.calendar_event_id) {
    const ok = await updateCalendarEvent(existing.calendar_event_id, {
      summary: `Focus: ${title}`,
      description: `LifeOS next-day plan\n${pricedRule.guidance}\nReward: ${reward.xp} XP / ${reward.coins} coins\n${reward.reason}`,
      startTime: plannedStart,
      endTime: plannedEnd,
    });
    db.prepare('UPDATE planned_focus_sessions SET calendar_status = ? WHERE id = ?').run(ok ? 'synced' : 'failed', id);
  }

  return db.prepare('SELECT * FROM planned_focus_sessions WHERE id = ?').get(id) as PlannedFocusSession;
}

export async function cancelPlannedFocusSession(id: string, syncCalendar = true): Promise<boolean> {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM planned_focus_sessions WHERE id = ?').get(id) as PlannedFocusSession | undefined;
  if (!existing) return false;

  if (existing.soft_watch_id) {
    db.prepare("UPDATE soft_watch_commitments SET status = 'dismissed' WHERE id = ? AND status = 'pending'").run(existing.soft_watch_id);
  }

  let calendarStatus = existing.calendar_status;
  if (syncCalendar && existing.calendar_event_id) {
    const ok = await deleteCalendarEvent(existing.calendar_event_id);
    calendarStatus = ok ? 'deleted' : 'failed';
  }

  db.prepare(`
    UPDATE planned_focus_sessions
    SET status = 'cancelled', calendar_status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(calendarStatus, id);
  return true;
}
