import { randomUUID } from 'crypto';
import { getDb, getSetting, setSetting } from './db';
import { getHistoryStartDate } from './history-epoch';
import { getGuardianEvidenceHealth } from './guardian-client-status';

export type EngagementState = 'active' | 'slipping' | 'disengaged' | 'reconnecting' | 'paused';
export type CoverageState = 'current' | 'partial' | 'missing';

export const COACHING_POLICY_VERSION = 'engagement-v1';
const DAY_MS = 86_400_000;

export interface CoachingState {
  engagement: EngagementState;
  coverage: CoverageState;
  coverageSources: {
    chrome: CoverageState;
    macbookVision: CoverageState;
    phone: CoverageState;
  };
  reason: string;
  evidence: string[];
  missedOpportunities: number;
  overdueTasks: number;
  unansweredOutreach: number;
  daysSinceHumanContact: number | null;
  daysSinceCompletedSession: number | null;
  daysSinceCheckin: number | null;
  lastHumanContactAt: string | null;
  lastCompletedSessionAt: string | null;
  lastEvidenceAt: string | null;
  episode: CoachingEpisode | null;
  restart: {
    minutes: number;
    title: string;
    taskId: number | null;
  };
}

export interface CoachingEpisode {
  id: string;
  status: 'open' | 'reconnecting' | 'resolved' | 'paused';
  triggerReason: string;
  openedAt: string;
  firstResponseAt: string | null;
  acceptedAt: string | null;
  resolvedAt: string | null;
  blockerKind: string | null;
  blockerText: string | null;
  nextActionText: string | null;
  restartMinutes: number;
}

export interface CoachingDecision {
  id: number;
  episodeId: string | null;
  commitmentId: number | null;
  policyVersion: string;
  actionType: string;
  variant: string | null;
  contextKey: string | null;
  status: string;
  channel: string | null;
  message: string | null;
  reason: string;
  expectedOutcome: string | null;
  actualOutcome: string | null;
  outcomeScore: number | null;
  evaluatedAt: string | null;
  createdAt: string;
}

function parseDbTime(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function daysSince(time: number | null, nowMs: number): number | null {
  if (time === null) return null;
  return Math.max(0, (nowMs - time) / DAY_MS);
}

function newest(values: Array<string | number | null | undefined>): number | null {
  const parsed = values.map(parseDbTime).filter((value): value is number => value !== null);
  return parsed.length ? Math.max(...parsed) : null;
}

function safeScalar(query: string, column: string, args: unknown[] = []): string | number | null {
  try {
    const row = getDb().prepare(query).get(...args) as Record<string, string | number | null> | undefined;
    return row?.[column] ?? null;
  } catch {
    return null;
  }
}

function openEpisode(): CoachingEpisode | null {
  try {
    const row = getDb().prepare(`
      SELECT id, status, trigger_reason, opened_at, first_response_at, accepted_at,
             resolved_at, blocker_kind, blocker_text, next_action_text, restart_minutes
      FROM coaching_episodes
      WHERE status IN ('open', 'reconnecting', 'paused')
      ORDER BY opened_at DESC LIMIT 1
    `).get() as {
      id: string; status: CoachingEpisode['status']; trigger_reason: string; opened_at: string;
      first_response_at: string | null; accepted_at: string | null; resolved_at: string | null;
      blocker_kind: string | null; blocker_text: string | null; next_action_text: string | null;
      restart_minutes: number;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      triggerReason: row.trigger_reason,
      openedAt: row.opened_at,
      firstResponseAt: row.first_response_at,
      acceptedAt: row.accepted_at,
      resolvedAt: row.resolved_at,
      blockerKind: row.blocker_kind,
      blockerText: row.blocker_text,
      nextActionText: row.next_action_text,
      restartMinutes: row.restart_minutes,
    };
  } catch {
    return null;
  }
}

function latestRestartTask(historyStartDate: string): { id: number | null; title: string } {
  try {
    const row = getDb().prepare(`
      SELECT id, title FROM tasks
      WHERE status IN ('doing', 'todo')
        AND date(COALESCE(updated_at, created_at)) >= date(?)
      ORDER BY
        CASE WHEN status = 'doing' THEN 0 ELSE 1 END,
        CASE WHEN due_date IS NOT NULL AND date(due_date) < date('now', 'localtime') THEN 0 ELSE 1 END,
        CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        updated_at DESC,
        created_at DESC
      LIMIT 1
    `).get(historyStartDate) as { id: number; title: string } | undefined;
    return row ? { id: row.id, title: row.title } : { id: null, title: 'Return to one useful task' };
  } catch {
    return { id: null, title: 'Return to one useful task' };
  }
}

function countMissedOpportunities(nowMs: number, historyStartDate: string): number {
  const cutoff = nowMs - 7 * DAY_MS;
  const epochMs = Date.parse(`${historyStartDate}T00:00:00`);
  const effectiveCutoff = Number.isFinite(epochMs) ? Math.max(cutoff, epochMs) : cutoff;
  let count = 0;
  try {
    const rows = getDb().prepare(`
      SELECT pfs.id, pfs.planned_end
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      WHERE pfs.status = 'planned' AND dp.plan_date >= ?
    `).all(historyStartDate) as Array<{ id: string; planned_end: string }>;
    count += rows.filter(row => {
      const at = parseDbTime(row.planned_end);
      return at !== null && at >= effectiveCutoff && at < nowMs - 15 * 60_000;
    }).length;
  } catch { /* older database */ }
  try {
    const rows = getDb().prepare(`
      SELECT sw.id, sw.intended_start_at
      FROM soft_watch_commitments sw
      LEFT JOIN planned_focus_sessions pfs ON pfs.soft_watch_id = sw.id
      WHERE sw.status = 'pending' AND pfs.id IS NULL
    `).all() as Array<{ id: string; intended_start_at: number }>;
    count += rows.filter(row => row.intended_start_at >= effectiveCutoff && row.intended_start_at < nowMs - 15 * 60_000).length;
  } catch { /* older database */ }
  return count;
}

function countSince(query: string, cutoff: number | null): number {
  try {
    const rows = getDb().prepare(query).all() as Array<{ at: string }>;
    return rows.filter(row => {
      const at = parseDbTime(row.at);
      return at !== null && (cutoff === null || at > cutoff);
    }).length;
  } catch {
    return 0;
  }
}

export function getCoachingState(options: { now?: Date } = {}): CoachingState {
  const nowMs = options.now?.getTime() ?? Date.now();
  const historyStartDate = getHistoryStartDate();
  const paused = getSetting('coaching_paused') === 'true';
  const episode = openEpisode();

  const contactEvent = safeScalar(
    "SELECT MAX(occurred_at) AS at FROM coaching_events WHERE event_type = 'human_contact' AND date(occurred_at) >= date(?)",
    'at',
    [historyStartDate],
  );
  const telegramTurn = safeScalar(
    "SELECT MAX(created_at) AS at FROM voice_turns WHERE session_key = 'telegram' AND role = 'user' AND date(created_at) >= date(?)",
    'at',
    [historyStartDate],
  );
  const latestCheckin = safeScalar('SELECT MAX(received_at) AS at FROM daily_checkins WHERE checkin_date >= ?', 'at', [historyStartDate]);
  const latestTaskCompletion = safeScalar("SELECT MAX(completed_at) AS at FROM tasks WHERE status = 'done' AND date(completed_at) >= date(?)", 'at', [historyStartDate]);
  const latestHabitCompletion = safeScalar('SELECT MAX(date) AS at FROM habit_checkins WHERE completed = 1 AND date >= ?', 'at', [historyStartDate]);
  const latestSession = safeScalar('SELECT MAX(COALESCE(completed_at, started_at)) AS at FROM guardian_session_summaries WHERE date(COALESCE(completed_at, started_at)) >= date(?)', 'at', [historyStartDate]);
  const evidenceHealth = getGuardianEvidenceHealth(nowMs);

  const lastHumanMs = newest([contactEvent, telegramTurn, latestCheckin, latestTaskCompletion, latestHabitCompletion]);
  const lastSessionMs = parseDbTime(latestSession);
  const lastEvidenceMs = parseDbTime(evidenceHealth.lastEvidenceAt);
  const contactDays = daysSince(lastHumanMs, nowMs);
  const sessionDays = daysSince(lastSessionMs, nowMs);
  const checkinDays = daysSince(parseDbTime(latestCheckin), nowMs);
  const missedOpportunities = countMissedOpportunities(nowMs, historyStartDate);

  const overdueTasks = Number(safeScalar(
    "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('todo','doing') AND due_date IS NOT NULL AND date(due_date) < date('now','localtime') AND date(COALESCE(updated_at, created_at)) >= date(?)",
    'count',
    [historyStartDate],
  ) ?? 0);
  const historyStart = parseDbTime(`${historyStartDate}T00:00:00`);
  const historyAgeDays = historyStart === null ? 0 : Math.max(0, (nowMs - historyStart) / DAY_MS);
  const unansweredOutreach = countSince(
    "SELECT created_at AS at FROM coaching_decisions WHERE action_type = 'recovery_outreach' AND status = 'sent'",
    lastHumanMs,
  );

  const coverageSources = evidenceHealth.sources;
  const coverage = evidenceHealth.coverage;
  const evidence: string[] = [];
  if (missedOpportunities > 0) evidence.push(`${missedOpportunities} missed agreed focus opportunit${missedOpportunities === 1 ? 'y' : 'ies'} in 7 days`);
  if (overdueTasks > 0) evidence.push(`${overdueTasks} overdue task${overdueTasks === 1 ? '' : 's'}`);
  if (contactDays !== null) evidence.push(contactDays < 1
    ? 'Meaningful interaction today'
    : `${Math.floor(contactDays)} day${Math.floor(contactDays) === 1 ? '' : 's'} since a meaningful interaction`);
  if (sessionDays !== null) evidence.push(sessionDays < 1
    ? 'Focus session completed today'
    : `${Math.floor(sessionDays)} day${Math.floor(sessionDays) === 1 ? '' : 's'} since a completed session`);
  if (coverage !== 'current') evidence.push(`device evidence is ${coverage}`);

  let engagement: EngagementState = 'active';
  let reason = 'Recent participation does not currently require a recovery intervention.';
  if (paused || episode?.status === 'paused') {
    engagement = 'paused';
    reason = 'Coaching is paused by an explicit choice.';
  } else if (episode?.status === 'open') {
    const openedMs = parseDbTime(episode.openedAt);
    const latestActionMs = newest([lastHumanMs, lastSessionMs]);
    const actionAfterOpening = openedMs !== null && latestActionMs !== null && latestActionMs > openedMs;
    engagement = actionAfterOpening ? 'reconnecting' : 'disengaged';
    reason = actionAfterOpening
      ? 'Meaningful activity resumed after the recovery opened; a concrete restart still needs to be accepted.'
      : 'The recovery conversation is open and still needs a response.';
  } else if (episode?.status === 'reconnecting') {
    const acceptedMs = parseDbTime(episode.acceptedAt);
    const sessionsAfterAcceptance = acceptedMs === null ? 0 : countSince(
      'SELECT COALESCE(completed_at, started_at) AS at FROM guardian_session_summaries',
      acceptedMs,
    );
    if (sessionsAfterAcceptance >= 2) {
      getDb().prepare(`
        UPDATE coaching_episodes
        SET status = 'resolved', resolved_at = ?, resolution = 'two_restart_sessions_completed', updated_at = ?
        WHERE id = ?
      `).run(iso(nowMs), iso(nowMs), episode.id);
      recordCoachingDecision({
        episodeId: episode.id,
        actionType: 'recovery_complete',
        status: 'completed',
        channel: 'policy',
        reason: 'Two sessions were completed after the restart was accepted.',
        expectedOutcome: 'Restore the normal coaching policy after demonstrated follow-through.',
        actualOutcome: { sessionsAfterAcceptance },
        dedupeKey: `recovery_complete:${episode.id}`,
        now: new Date(nowMs),
      });
      engagement = 'active';
      reason = 'Two restart sessions were completed after reconnecting.';
    } else {
      engagement = 'reconnecting';
      reason = acceptedMs === null
        ? 'Contact resumed; a concrete restart still needs to be accepted.'
        : `A restart was accepted; ${Math.max(0, 2 - sessionsAfterAcceptance)} confirming session${sessionsAfterAcceptance === 1 ? '' : 's'} remain.`;
    }
  } else {
    const noHumanForThreeDays = contactDays === null ? historyAgeDays >= 3 : contactDays >= 3;
    const noSessionForThreeDays = sessionDays === null ? historyAgeDays >= 3 : sessionDays >= 3;
    const noCheckinForThreeDays = checkinDays === null ? historyAgeDays >= 3 : checkinDays >= 3;
    if (
      noHumanForThreeDays &&
      noSessionForThreeDays &&
      (missedOpportunities >= 2 || (overdueTasks > 0 && noCheckinForThreeDays))
    ) {
      engagement = 'disengaged';
      reason = 'Normal coaching has broken down across contact and practice; begin a coordinated recovery conversation.';
    } else if (missedOpportunities > 0 || (noSessionForThreeDays && overdueTasks > 0)) {
      engagement = 'slipping';
      reason = 'There is an early follow-through problem worth resolving before it becomes a longer absence.';
    }
  }

  const restartTask = latestRestartTask(historyStartDate);
  return {
    engagement,
    coverage,
    coverageSources,
    reason,
    evidence,
    missedOpportunities,
    overdueTasks,
    unansweredOutreach,
    daysSinceHumanContact: contactDays,
    daysSinceCompletedSession: sessionDays,
    daysSinceCheckin: checkinDays,
    lastHumanContactAt: lastHumanMs === null ? null : iso(lastHumanMs),
    lastCompletedSessionAt: lastSessionMs === null ? null : iso(lastSessionMs),
    lastEvidenceAt: lastEvidenceMs === null ? null : iso(lastEvidenceMs),
    episode: engagement === 'active' && episode?.status === 'reconnecting' ? null : episode,
    restart: {
      minutes: episode?.restartMinutes ?? 10,
      title: episode?.nextActionText || restartTask.title,
      taskId: restartTask.id,
    },
  };
}

export function ensureRecoveryEpisode(state = getCoachingState(), now = new Date()): CoachingEpisode | null {
  if (state.engagement !== 'disengaged' && state.engagement !== 'reconnecting') return state.episode;
  if (state.episode) return state.episode;
  const id = randomUUID();
  const at = now.toISOString();
  getDb().prepare(`
    INSERT INTO coaching_episodes (
      id, status, trigger_reason, opened_at, next_action_text, restart_minutes, updated_at
    ) VALUES (?, 'open', ?, ?, ?, 10, ?)
  `).run(id, state.reason, at, state.restart.title, at);
  recordCoachingEvent({
    eventType: 'recovery_opened',
    source: 'coaching_policy',
    episodeId: id,
    occurredAt: at,
    payload: { evidence: state.evidence },
    dedupeKey: `recovery_opened:${id}`,
  });
  return openEpisode();
}

export function recordCoachingEvent(input: {
  eventType: string;
  source: string;
  occurredAt?: string;
  episodeId?: string | null;
  commitmentId?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
}): void {
  try {
    getDb().prepare(`
      INSERT OR IGNORE INTO coaching_events (
        event_type, source, occurred_at, episode_id, commitment_id, dedupe_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.eventType,
      input.source,
      input.occurredAt ?? new Date().toISOString(),
      input.episodeId ?? null,
      input.commitmentId ?? null,
      input.dedupeKey ?? null,
      JSON.stringify(input.payload ?? {}),
    );
  } catch (error) {
    console.warn('[Coaching] Failed to record event:', error);
  }
}

export function recordHumanContact(source: string, payload: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  const episode = openEpisode();
  recordCoachingEvent({
    eventType: 'human_contact',
    source,
    occurredAt: at,
    episodeId: episode?.id ?? null,
    payload,
  });
  if (episode && episode.status === 'open') {
    getDb().prepare(`
      UPDATE coaching_episodes
      SET status = 'reconnecting', first_response_at = COALESCE(first_response_at, ?), updated_at = ?
      WHERE id = ?
    `).run(at, at, episode.id);
  }
}

export function recordCoachingDecision(input: {
  episodeId?: string | null;
  actionType: string;
  status: 'proposed' | 'suppressed' | 'sent' | 'accepted' | 'rejected' | 'completed' | 'failed';
  channel?: string | null;
  message?: string | null;
  reason: string;
  expectedOutcome?: string | null;
  actualOutcome?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  now?: Date;
}): number | null {
  try {
    const at = (input.now ?? new Date()).toISOString();
    const result = getDb().prepare(`
      INSERT OR IGNORE INTO coaching_decisions (
        episode_id, policy_version, action_type, status, channel, message, reason,
        expected_outcome, actual_outcome, dedupe_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.episodeId ?? null,
      COACHING_POLICY_VERSION,
      input.actionType,
      input.status,
      input.channel ?? null,
      input.message ?? null,
      input.reason,
      input.expectedOutcome ?? null,
      input.actualOutcome ? JSON.stringify(input.actualOutcome) : null,
      input.dedupeKey ?? null,
      at,
      at,
    );
    return result.changes ? Number(result.lastInsertRowid) : null;
  } catch (error) {
    console.warn('[Coaching] Failed to record decision:', error);
    return null;
  }
}

export function getRecentCoachingDecisions(limit = 20): CoachingDecision[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, episode_id, policy_version, action_type, status, channel, message,
             reason, expected_outcome, actual_outcome, created_at,
             commitment_id, variant, context_key, outcome_score, evaluated_at
      FROM coaching_decisions ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as Array<Record<string, string | number | null>>;
    return rows.map(row => ({
      id: Number(row.id),
      episodeId: row.episode_id as string | null,
      commitmentId: row.commitment_id === null ? null : Number(row.commitment_id),
      policyVersion: String(row.policy_version),
      actionType: String(row.action_type),
      variant: row.variant as string | null,
      contextKey: row.context_key as string | null,
      status: String(row.status),
      channel: row.channel as string | null,
      message: row.message as string | null,
      reason: String(row.reason),
      expectedOutcome: row.expected_outcome as string | null,
      actualOutcome: row.actual_outcome as string | null,
      outcomeScore: row.outcome_score === null ? null : Number(row.outcome_score),
      evaluatedAt: row.evaluated_at as string | null,
      createdAt: String(row.created_at),
    }));
  } catch {
    return [];
  }
}

export function shouldSuppressRoutineCoaching(kind: string): { suppress: boolean; reason: string; state: CoachingState } {
  const state = getCoachingState();
  const suppress = state.engagement === 'disengaged' || state.engagement === 'reconnecting' || state.engagement === 'paused';
  const reason = suppress
    ? `${kind} suppressed while coaching state is ${state.engagement}; the coordinated recovery policy owns proactive contact.`
    : `${kind} allowed while coaching state is ${state.engagement}.`;
  if (suppress) {
    recordCoachingDecision({
      episodeId: state.episode?.id,
      actionType: 'suppress_routine',
      status: 'suppressed',
      channel: 'policy',
      reason,
      expectedOutcome: 'Avoid repetitive pressure while recovery owns proactive contact.',
      actualOutcome: { kind, engagement: state.engagement },
      dedupeKey: `suppression:${localDateKey()}:${kind}:${state.engagement}`,
    });
  }
  return {
    suppress,
    reason,
    state,
  };
}

export function setCoachingPaused(paused: boolean): CoachingState {
  setSetting('coaching_paused', paused ? 'true' : 'false');
  const at = new Date().toISOString();
  const episode = openEpisode();
  if (episode) {
    getDb().prepare(`
      UPDATE coaching_episodes SET status = ?, updated_at = ? WHERE id = ?
    `).run(paused ? 'paused' : 'reconnecting', at, episode.id);
  }
  recordCoachingEvent({ eventType: paused ? 'coaching_paused' : 'coaching_resumed', source: 'user', occurredAt: at, episodeId: episode?.id });
  return getCoachingState();
}

export function acceptRecoveryRestart(input: { minutes?: number; nextActionText?: string | null }): CoachingState {
  const state = getCoachingState();
  const episode = ensureRecoveryEpisode(state);
  if (!episode) return state;
  const at = new Date().toISOString();
  const minutes = Math.max(5, Math.min(120, Math.round(input.minutes ?? episode.restartMinutes ?? 10)));
  const nextAction = input.nextActionText?.trim() || state.restart.title;
  getDb().prepare(`
    UPDATE coaching_episodes
    SET status = 'reconnecting', accepted_at = ?, next_action_text = ?, restart_minutes = ?, updated_at = ?
    WHERE id = ?
  `).run(at, nextAction, minutes, at, episode.id);
  recordCoachingDecision({
    episodeId: episode.id,
    actionType: 'restart',
    status: 'accepted',
    channel: 'user',
    reason: 'User accepted a concrete recovery action.',
    expectedOutcome: 'Begin the restart and complete two confirming sessions.',
    actualOutcome: { minutes, nextAction },
  });
  return getCoachingState();
}

function classifyBlocker(text: string): string {
  const normalized = text.toLowerCase();
  if (/stuck|confus|understand|hard|difficult/.test(normalized)) return 'difficulty';
  if (/overwhelm|too much|behind|backlog/.test(normalized)) return 'overload';
  if (/tired|energy|sleep|exhaust/.test(normalized)) return 'energy';
  if (/phone|scroll|instagram|youtube|distract/.test(normalized)) return 'distraction';
  if (/priority|don't want|do not want|changed|different goal/.test(normalized)) return 'changed_priority';
  if (/broken|bug|not working|technical/.test(normalized)) return 'technical';
  return 'other';
}

export function handleRecoveryResponse(text: string): { handled: boolean; reply: string; state: CoachingState } {
  const state = getCoachingState();
  const episode = state.episode;
  if (!episode || (episode.status !== 'open' && episode.status !== 'reconnecting')) {
    return { handled: false, reply: '', state };
  }
  const trimmed = text.trim().slice(0, 1000);
  if (!trimmed || /^\s*[/\\]/.test(trimmed)) return { handled: false, reply: '', state };
  const blocker = classifyBlocker(trimmed);
  const at = new Date().toISOString();
  const minutes = blocker === 'energy' || blocker === 'overload' ? 5 : 10;
  const nextAction = state.restart.title;
  getDb().prepare(`
    UPDATE coaching_episodes
    SET status = 'reconnecting', first_response_at = COALESCE(first_response_at, ?),
        blocker_kind = ?, blocker_text = ?, next_action_text = ?, restart_minutes = ?, updated_at = ?
    WHERE id = ?
  `).run(at, blocker, trimmed, nextAction, minutes, at, episode.id);
  recordCoachingDecision({
    episodeId: episode.id,
    actionType: 'investigate_blocker',
    status: 'completed',
    channel: 'telegram',
    reason: `Recovery response classified as ${blocker}; the classification remains correctable.`,
    expectedOutcome: 'Choose a concrete restart or revise the underlying commitment.',
    actualOutcome: { blocker, text: trimmed },
  });

  const lead: Record<string, string> = {
    difficulty: 'You are stuck in the work itself. We should make the obstacle concrete before adding more pressure.',
    overload: 'The backlog is creating friction. We will restart with one piece and resolve the rest separately.',
    energy: 'Capacity looks like the immediate constraint. Use a five-minute restart and keep the larger commitment unchanged until we review it.',
    distraction: 'The phone or another distraction is interfering. Start a protected block and we will judge it by whether you return and complete the minimum.',
    changed_priority: 'Your priorities may have changed. We should revise the commitment explicitly rather than keep recycling it.',
    technical: 'A technical problem is blocking the normal flow. Describe the failure and I will keep the missed activity separate from avoidance.',
    other: 'I have recorded what you said without inventing a motive.',
  };
  return {
    handled: true,
    reply: `${lead[blocker]}\n\nProposed next action: <b>${escapeHtml(nextAction)}</b> for <b>${minutes} minutes</b>. Reply “start” to accept, or tell me what should change.`,
    state: getCoachingState(),
  };
}

export function correctRecoveryContext(text: string): CoachingState {
  const state = getCoachingState();
  const episode = state.episode;
  if (!episode) return state;
  const normalized = text.trim().slice(0, 1000);
  if (!normalized) return state;
  const at = new Date().toISOString();
  getDb().prepare(`
    UPDATE coaching_episodes
    SET blocker_kind = 'corrected', blocker_text = ?, updated_at = ?
    WHERE id = ?
  `).run(normalized, at, episode.id);
  recordCoachingEvent({
    eventType: 'recovery_context_corrected',
    source: 'user',
    occurredAt: at,
    episodeId: episode.id,
    payload: { text: normalized },
  });
  return getCoachingState();
}

export function buildRecoveryMessage(state = getCoachingState()): string {
  const evidence = state.evidence.slice(0, 3).join('; ') || 'the normal participation signals have stopped';
  return [
    '<b>We need to reset the plan.</b>',
    '',
    `I am seeing ${evidence}. Repeating the old reminders will not solve that.`,
    '',
    `The smallest useful restart I can see is <b>${escapeHtml(state.restart.title)}</b> for <b>${state.restart.minutes} minutes</b>. I will not count it unless you actually start.`,
    '',
    'What is blocking the restart: the work itself, too much to catch up on, low energy, distraction, or a changed priority? A short answer is enough.',
  ].join('\n');
}

export function localDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function recoveryOutreachDue(state = getCoachingState(), now = new Date()): boolean {
  if (state.engagement !== 'disengaged') return false;
  const keyPrefix = `recovery:${localDateKey(now)}`;
  try {
    const sent = getDb().prepare(`
      SELECT 1 FROM coaching_decisions WHERE dedupe_key = ? LIMIT 1
    `).get(keyPrefix);
    return !sent;
  } catch {
    return false;
  }
}
