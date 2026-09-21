import { getDb, getSetting } from './db';
import { getHistoryStartDate } from './history-epoch';
import { sendTelegram, type InlineKeyboard } from './telegram';

const START_GRACE_MS = 5 * 60_000;
const OUTCOME_TIMEOUT_MS = 30 * 60_000;
const MAX_INTERVENTION_AGE_MS = 6 * 60 * 60_000;
const POLICY_VERSION = 'commitment-v1';

export type CommitmentState = 'scheduled' | 'due' | 'missed' | 'started' | 'completed' | 'abandoned' | 'rescheduled' | 'cancelled';
export type InterventionVariant = 'direct_start' | 'tiny_start' | 'choice';

export interface CoachingCommitment {
  id: number;
  commitmentKey: string;
  sourceType: 'planned_focus' | 'soft_watch' | 'recovery';
  sourceId: string;
  episodeId: string | null;
  taskId: number | null;
  title: string;
  plannedStartAt: string;
  plannedMinutes: number;
  state: CommitmentState;
  sessionId: string | null;
  interventionDecisionId: number | null;
  acknowledgedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastInterventionAt: string | null;
  startDelaySeconds: number | null;
  elapsedMinutes: number | null;
  focusScore: number | null;
  completionRatio: number | null;
  outcomeScore: number | null;
  outcomeReason: string | null;
  blockerKind: string | null;
  blockerText: string | null;
}

interface CommitmentRow {
  id: number;
  commitment_key: string;
  source_type: CoachingCommitment['sourceType'];
  source_id: string;
  episode_id: string | null;
  task_id: number | null;
  title: string;
  planned_start_at: string;
  planned_minutes: number;
  state: CommitmentState;
  session_id: string | null;
  intervention_decision_id: number | null;
  acknowledged_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_intervention_at: string | null;
  start_delay_seconds: number | null;
  elapsed_minutes: number | null;
  focus_score: number | null;
  completion_ratio: number | null;
  outcome_score: number | null;
  outcome_reason: string | null;
  blocker_kind: string | null;
  blocker_text: string | null;
}

export interface InterventionPolicy {
  variant: InterventionVariant;
  contextKey: string;
  recommendedMinutes: number;
  reason: string;
}

export interface InterventionLearningRow {
  variant: InterventionVariant;
  evaluated: number;
  completed: number;
  started: number;
  averageOutcome: number | null;
}

function toCommitment(row: CommitmentRow): CoachingCommitment {
  return {
    id: row.id,
    commitmentKey: row.commitment_key,
    sourceType: row.source_type,
    sourceId: row.source_id,
    episodeId: row.episode_id,
    taskId: row.task_id,
    title: row.title,
    plannedStartAt: row.planned_start_at,
    plannedMinutes: row.planned_minutes,
    state: row.state,
    sessionId: row.session_id,
    interventionDecisionId: row.intervention_decision_id,
    acknowledgedAt: row.acknowledged_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastInterventionAt: row.last_intervention_at,
    startDelaySeconds: row.start_delay_seconds,
    elapsedMinutes: row.elapsed_minutes,
    focusScore: row.focus_score,
    completionRatio: row.completion_ratio,
    outcomeScore: row.outcome_score,
    outcomeReason: row.outcome_reason,
    blockerKind: row.blocker_kind,
    blockerText: row.blocker_text,
  };
}

function timestamp(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: string | number | Date): string {
  const parsed = timestamp(value);
  if (parsed === null) throw new Error(`Invalid commitment timestamp: ${String(value)}`);
  return new Date(parsed).toISOString();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getRow(id: number): CommitmentRow | undefined {
  return getDb().prepare('SELECT * FROM coaching_commitments WHERE id = ?').get(id) as CommitmentRow | undefined;
}

export function getCommitment(id: number): CoachingCommitment | null {
  const row = getRow(id);
  return row ? toCommitment(row) : null;
}

function upsertSource(input: {
  key: string;
  sourceType: CoachingCommitment['sourceType'];
  sourceId: string;
  episodeId?: string | null;
  taskId?: number | null;
  title: string;
  plannedStartAt: string | number | Date;
  plannedMinutes: number;
  sourceState: CommitmentState;
}, now: Date): CoachingCommitment {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM coaching_commitments WHERE commitment_key = ?').get(input.key) as CommitmentRow | undefined;
  const at = now.toISOString();
  const startAt = iso(input.plannedStartAt);
  const plannedMinutes = Math.max(5, Math.min(240, Math.round(input.plannedMinutes || 10)));
  if (!existing) {
    const result = db.prepare(`
      INSERT INTO coaching_commitments (
        commitment_key, source_type, source_id, episode_id, task_id, title,
        planned_start_at, planned_minutes, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.key, input.sourceType, input.sourceId, input.episodeId ?? null, input.taskId ?? null,
      input.title, startAt, plannedMinutes, input.sourceState, at, at);
    return toCommitment(getRow(Number(result.lastInsertRowid))!);
  }

  const terminal = ['completed', 'abandoned', 'cancelled'].includes(existing.state);
  const active = ['missed', 'started'].includes(existing.state);
  const nextState = terminal || active ? existing.state : input.sourceState;
  const nextEpisodeId = input.episodeId ?? existing.episode_id;
  const nextTaskId = input.taskId ?? existing.task_id;
  const unchanged = nextEpisodeId === existing.episode_id
    && nextTaskId === existing.task_id
    && input.title === existing.title
    && startAt === existing.planned_start_at
    && plannedMinutes === existing.planned_minutes
    && nextState === existing.state;
  if (unchanged) return toCommitment(existing);

  db.prepare(`
    UPDATE coaching_commitments
    SET episode_id = ?, task_id = ?, title = ?,
        planned_start_at = ?, planned_minutes = ?, state = ?, updated_at = ?
    WHERE id = ?
  `).run(nextEpisodeId, nextTaskId, input.title, startAt, plannedMinutes, nextState, at, existing.id);
  return toCommitment(getRow(existing.id)!);
}

export function syncCommitmentSources(now = new Date()): CoachingCommitment[] {
  const db = getDb();
  const historyStart = getHistoryStartDate();
  const seen: CoachingCommitment[] = [];
  try {
    const rows = db.prepare(`
      SELECT id, task_id, title, planned_start, duration_minutes, status
      FROM planned_focus_sessions
      WHERE date(planned_start, '+5 hours', '+30 minutes') >= date(?)
        AND status IN ('planned', 'started', 'completed', 'skipped', 'cancelled')
    `).all(historyStart) as Array<{
      id: string; task_id: number | null; title: string; planned_start: string;
      duration_minutes: number; status: string;
    }>;
    for (const row of rows) {
      const state: CommitmentState = row.status === 'started' ? 'started'
        : row.status === 'completed' ? 'completed'
          : row.status === 'skipped' ? 'abandoned'
            : row.status === 'cancelled' ? 'cancelled'
              : 'scheduled';
      seen.push(upsertSource({
        key: `planned:${row.id}`, sourceType: 'planned_focus', sourceId: row.id,
        taskId: row.task_id, title: row.title, plannedStartAt: row.planned_start,
        plannedMinutes: row.duration_minutes, sourceState: state,
      }, now));
    }
  } catch { /* planner may not be installed on an older database */ }

  try {
    const rows = db.prepare(`
      SELECT sw.id, sw.task_id, sw.target_title, sw.intended_start_at, sw.planned_minutes, sw.status
      FROM soft_watch_commitments sw
      LEFT JOIN planned_focus_sessions pfs ON pfs.soft_watch_id = sw.id
      WHERE pfs.id IS NULL AND sw.status IN ('pending', 'locked_in', 'expired', 'dismissed')
    `).all() as Array<{
      id: string; task_id: number | null; target_title: string; intended_start_at: number;
      planned_minutes: number; status: string;
    }>;
    for (const row of rows) {
      const state: CommitmentState = row.status === 'locked_in' ? 'started'
        : row.status === 'expired' ? 'missed'
          : row.status === 'dismissed' ? 'cancelled'
            : 'scheduled';
      seen.push(upsertSource({
        key: `soft-watch:${row.id}`, sourceType: 'soft_watch', sourceId: row.id,
        taskId: row.task_id, title: row.target_title, plannedStartAt: row.intended_start_at,
        plannedMinutes: row.planned_minutes, sourceState: state,
      }, now));
    }
  } catch { /* soft watch may not be installed on an older database */ }

  try {
    const rows = db.prepare(`
      SELECT id, next_action_text, restart_minutes, accepted_at, status
      FROM coaching_episodes
      WHERE accepted_at IS NOT NULL AND status IN ('reconnecting', 'resolved')
    `).all() as Array<{
      id: string; next_action_text: string | null; restart_minutes: number;
      accepted_at: string; status: string;
    }>;
    for (const row of rows) {
      seen.push(upsertSource({
        key: `recovery:${row.id}`, sourceType: 'recovery', sourceId: row.id,
        episodeId: row.id, title: row.next_action_text || 'Recovery restart',
        plannedStartAt: row.accepted_at, plannedMinutes: row.restart_minutes,
        sourceState: row.status === 'resolved' ? 'completed' : 'scheduled',
      }, now));
    }
  } catch { /* active coaching may not be installed */ }
  return seen;
}

function contextFor(commitment: CoachingCommitment, now: Date): { key: string; defaultVariant: InterventionVariant } {
  const db = getDb();
  let deadline = false;
  if (commitment.taskId !== null) {
    try {
      const row = db.prepare(`SELECT due_date FROM tasks WHERE id = ?`).get(commitment.taskId) as { due_date: string | null } | undefined;
      if (row?.due_date) deadline = new Date(`${row.due_date}T23:59:59`).getTime() <= now.getTime() + 24 * 60 * 60_000;
    } catch { /* task context remains unknown */ }
  }
  let fragile = false;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM (SELECT state FROM coaching_commitments
            WHERE state IN ('completed','abandoned','missed')
            ORDER BY updated_at DESC LIMIT 8)
    `).get() as { total: number; completed: number };
    fragile = row.total >= 3 && row.completed / row.total < 0.5;
  } catch { /* cold start */ }
  const hour = now.getHours();
  const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const mode = deadline ? 'deadline' : fragile ? 'fragile' : 'normal';
  return { key: `${mode}:${period}`, defaultVariant: deadline ? 'direct_start' : fragile ? 'tiny_start' : 'choice' };
}

function choosePolicy(commitment: CoachingCommitment, now: Date): InterventionPolicy {
  const { key, defaultVariant } = contextFor(commitment, now);
  const variants: InterventionVariant[] = ['direct_start', 'tiny_start', 'choice'];
  const rows = getDb().prepare(`
    SELECT variant, COUNT(*) AS attempts, AVG(outcome_score) AS average_outcome
    FROM coaching_decisions
    WHERE action_type = 'missed_start' AND context_key = ?
      AND variant IS NOT NULL AND evaluated_at IS NOT NULL
    GROUP BY variant
  `).all(key) as Array<{ variant: InterventionVariant; attempts: number; average_outcome: number }>;
  const byVariant = new Map(rows.map(row => [row.variant, row]));
  let variant = defaultVariant;
  const defaultAttempts = byVariant.get(defaultVariant)?.attempts ?? 0;
  if (defaultAttempts >= 2) {
    const underSampled = variants.find(candidate => (byVariant.get(candidate)?.attempts ?? 0) < 2);
    if (underSampled) variant = underSampled;
    else {
      variant = [...rows].sort((a, b) => (b.average_outcome ?? 0) - (a.average_outcome ?? 0))[0]?.variant ?? defaultVariant;
    }
  }
  const recommendedMinutes = variant === 'tiny_start' ? Math.min(10, commitment.plannedMinutes) : commitment.plannedMinutes;
  const reason = rows.length === 0
    ? `Cold-start ${key} policy; this result will become the first measured sample.`
    : variant === defaultVariant && defaultAttempts < 2
      ? `${key} policy is collecting its minimum two outcomes before comparison.`
      : `Selected from measured outcomes for ${key}; under-sampled variants are tried before exploitation.`;
  return { variant, contextKey: key, recommendedMinutes, reason };
}

function interventionMessage(commitment: CoachingCommitment, policy: InterventionPolicy): string {
  const title = escapeHtml(commitment.title);
  if (policy.variant === 'direct_start') {
    return `<b>The agreed start passed five minutes ago.</b>\n\nStart <b>${title}</b> now for <b>${policy.recommendedMinutes} minutes</b>, or explicitly reschedule it. I will judge this commitment by the session outcome.`;
  }
  if (policy.variant === 'tiny_start') {
    return `<b>You have not started ${title}.</b>\n\nDo the smallest real version now: <b>${policy.recommendedMinutes} minutes</b>. If something concrete is blocking you, tell me so I can change the plan.`;
  }
  return `<b>${title} did not start as planned.</b>\n\nChoose honestly: start now, move it by 30 minutes, or tell me what is blocking it. Repeating the old reminder is not an option.`;
}

function keyboardFor(id: number): InlineKeyboard {
  return [
    [{ text: 'Start now', callback_data: `commit:start:${id}` }],
    [
      { text: '+30 minutes', callback_data: `commit:snooze:${id}` },
      { text: 'I am blocked', callback_data: `commit:block:${id}` },
    ],
  ];
}

function insertDecision(commitment: CoachingCommitment, policy: InterventionPolicy, sent: boolean, now: Date): number {
  const result = getDb().prepare(`
    INSERT INTO coaching_decisions (
      episode_id, policy_version, action_type, status, channel, message, reason,
      expected_outcome, actual_outcome, dedupe_key, created_at, updated_at,
      commitment_id, variant, context_key
    ) VALUES (?, ?, 'missed_start', ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    commitment.episodeId, POLICY_VERSION, sent ? 'sent' : 'failed',
    interventionMessage(commitment, policy), policy.reason,
    'Begin a verified focus session, reschedule explicitly, or report a concrete blocker.',
    JSON.stringify({ transportAccepted: sent }),
    `missed-start:${commitment.id}:${now.toISOString()}`,
    now.toISOString(), now.toISOString(), commitment.id, policy.variant, policy.contextKey,
  );
  return Number(result.lastInsertRowid);
}

function mergeOutcome(decisionId: number, patch: Record<string, unknown>): string {
  const row = getDb().prepare('SELECT actual_outcome FROM coaching_decisions WHERE id = ?').get(decisionId) as { actual_outcome: string | null } | undefined;
  let current: Record<string, unknown> = {};
  try { current = row?.actual_outcome ? JSON.parse(row.actual_outcome) : {}; } catch { current = {}; }
  return JSON.stringify({ ...current, ...patch });
}

function closeSourceAsMissed(row: CommitmentRow, now: Date): void {
  if (row.source_type === 'planned_focus') {
    getDb().prepare(`
      UPDATE planned_focus_sessions SET status='skipped', updated_at=?
      WHERE id=? AND status NOT IN ('completed','cancelled')
    `).run(now.toISOString(), row.source_id);
  } else if (row.source_type === 'soft_watch') {
    getDb().prepare(`
      UPDATE soft_watch_commitments SET status='expired'
      WHERE id=? AND status='pending'
    `).run(row.source_id);
  }
}

function closeExpiredUnobservedCommitments(now: Date): void {
  const cutoff = new Date(now.getTime() - MAX_INTERVENTION_AGE_MS).toISOString();
  const rows = getDb().prepare(`
    SELECT * FROM coaching_commitments
    WHERE state IN ('scheduled','due','rescheduled')
      AND intervention_decision_id IS NULL
      AND planned_start_at < ?
  `).all(cutoff) as CommitmentRow[];
  for (const row of rows) {
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE coaching_commitments
        SET state='abandoned', completed_at=?, outcome_score=0,
            outcome_reason='The start window passed without an observed session or response.', updated_at=?
        WHERE id=?
      `).run(now.toISOString(), now.toISOString(), row.id);
      closeSourceAsMissed(row, now);
    })();
  }
}

function evaluateTimedOutMisses(now: Date): void {
  const rows = getDb().prepare(`
    SELECT * FROM coaching_commitments
    WHERE state = 'missed' AND intervention_decision_id IS NOT NULL
      AND outcome_score IS NULL AND last_intervention_at IS NOT NULL
  `).all() as CommitmentRow[];
  for (const row of rows) {
    const contacted = timestamp(row.last_intervention_at);
    if (contacted === null || now.getTime() - contacted < OUTCOME_TIMEOUT_MS) continue;
    const actual = mergeOutcome(row.intervention_decision_id!, { result: 'no_start_or_reply_within_30m' });
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE coaching_commitments
        SET state='abandoned', completed_at=?, outcome_score=0,
            outcome_reason='No start, reschedule, or blocker response within 30 minutes', updated_at=?
        WHERE id = ?
      `).run(now.toISOString(), now.toISOString(), row.id);
      closeSourceAsMissed(row, now);
      getDb().prepare(`
        UPDATE coaching_decisions
        SET status = 'failed', actual_outcome = ?, outcome_score = 0, evaluated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(actual, now.toISOString(), now.toISOString(), row.intervention_decision_id);
    })();
  }
}

export async function runCommitmentExecutionCheck(options: {
  now?: Date;
  send?: (message: string, parseMode?: 'HTML', keyboard?: InlineKeyboard) => Promise<boolean>;
} = {}): Promise<{
  action: 'none' | 'intervened' | 'already_handled' | 'delivery_failed' | 'paused';
  commitment: CoachingCommitment | null;
  policy: InterventionPolicy | null;
}> {
  const now = options.now ?? new Date();
  if (getSetting('coaching_paused') === 'true') return { action: 'paused', commitment: null, policy: null };
  syncCommitmentSources(now);
  closeExpiredUnobservedCommitments(now);
  evaluateTimedOutMisses(now);
  const nowMs = now.getTime();
  const candidates = getDb().prepare(`
    SELECT * FROM coaching_commitments
    WHERE state IN ('scheduled','due','missed','rescheduled')
    ORDER BY planned_start_at ASC
  `).all() as CommitmentRow[];
  let alreadyHandled: CoachingCommitment | null = null;
  for (const row of candidates) {
    const startMs = timestamp(row.planned_start_at);
    if (startMs === null) continue;
    if (nowMs < startMs + START_GRACE_MS) {
      if (nowMs >= startMs && row.state === 'scheduled') {
        getDb().prepare("UPDATE coaching_commitments SET state='due', updated_at=? WHERE id=?").run(now.toISOString(), row.id);
      }
      continue;
    }
    if (nowMs - startMs > MAX_INTERVENTION_AGE_MS) continue;
    if (row.intervention_decision_id || row.last_intervention_at) {
      alreadyHandled = toCommitment(getRow(row.id)!);
      continue;
    }
    const commitment = toCommitment(row);
    const policy = choosePolicy(commitment, now);
    const sender = options.send ?? sendTelegram;
    const sent = await sender(interventionMessage(commitment, policy), 'HTML', keyboardFor(commitment.id));
    const decisionId = insertDecision(commitment, policy, sent, now);
    if (!sent) return { action: 'delivery_failed', commitment, policy };
    getDb().transaction(() => {
      getDb().prepare(`
        UPDATE coaching_commitments
        SET state='missed', intervention_decision_id=?, last_intervention_at=?, updated_at=?
        WHERE id=?
      `).run(decisionId, now.toISOString(), now.toISOString(), commitment.id);
      if (commitment.sourceType === 'soft_watch') {
        getDb().prepare('UPDATE soft_watch_commitments SET check_in_sent_at=? WHERE id=?').run(nowMs, commitment.sourceId);
      } else if (commitment.sourceType === 'planned_focus') {
        getDb().prepare(`
          UPDATE soft_watch_commitments
          SET check_in_sent_at=?
          WHERE id=(SELECT soft_watch_id FROM planned_focus_sessions WHERE id=?)
        `).run(nowMs, commitment.sourceId);
      }
    })();
    return { action: 'intervened', commitment: toCommitment(getRow(commitment.id)!), policy };
  }
  return { action: alreadyHandled ? 'already_handled' : 'none', commitment: alreadyHandled, policy: null };
}

function findStartMatch(input: { title: string; plannedSessionId?: string | null; sessionId: string; startedAt: Date }): CommitmentRow | undefined {
  syncCommitmentSources(input.startedAt);
  if (input.plannedSessionId) {
    const exact = getDb().prepare(`SELECT * FROM coaching_commitments WHERE source_type='planned_focus' AND source_id=?`).get(input.plannedSessionId) as CommitmentRow | undefined;
    if (exact) return exact;
  }
  const locked = getDb().prepare(`
    SELECT cc.* FROM coaching_commitments cc
    JOIN soft_watch_commitments sw ON cc.source_type='soft_watch' AND cc.source_id=sw.id
    WHERE sw.locked_in_session_id=? LIMIT 1
  `).get(input.sessionId) as CommitmentRow | undefined;
  if (locked) return locked;
  return getDb().prepare(`
    SELECT * FROM coaching_commitments
    WHERE state IN ('scheduled','due','missed','rescheduled')
      AND lower(title)=lower(?)
      AND ABS(strftime('%s', planned_start_at) - strftime('%s', ?)) <= 7200
    ORDER BY ABS(strftime('%s', planned_start_at) - strftime('%s', ?)) ASC
    LIMIT 1
  `).get(input.title, input.startedAt.toISOString(), input.startedAt.toISOString()) as CommitmentRow | undefined;
}

export function recordSessionStartedForCommitment(input: {
  sessionId: string;
  title: string;
  plannedSessionId?: string | null;
  startedAt?: Date;
  plannedMinutes: number;
}): CoachingCommitment | null {
  const startedAt = input.startedAt ?? new Date();
  const row = findStartMatch({ ...input, startedAt });
  if (!row) return null;
  const plannedMs = timestamp(row.planned_start_at) ?? startedAt.getTime();
  const delay = Math.round((startedAt.getTime() - plannedMs) / 1000);
  getDb().prepare(`
    UPDATE coaching_commitments
    SET state='started', session_id=?, acknowledged_at=COALESCE(acknowledged_at, ?),
        started_at=?, start_delay_seconds=?, updated_at=?
    WHERE id=?
  `).run(input.sessionId, startedAt.toISOString(), startedAt.toISOString(), delay, startedAt.toISOString(), row.id);
  if (row.source_type === 'planned_focus') {
    getDb().prepare(`
      UPDATE planned_focus_sessions SET status='started', updated_at=?
      WHERE id=? AND status='planned'
    `).run(startedAt.toISOString(), row.source_id);
  } else if (row.source_type === 'soft_watch') {
    getDb().prepare(`
      UPDATE soft_watch_commitments SET status='locked_in', locked_in_session_id=?
      WHERE id=?
    `).run(input.sessionId, row.source_id);
  }
  if (row.intervention_decision_id) {
    const actual = mergeOutcome(row.intervention_decision_id, { result: 'started', sessionId: input.sessionId, startDelaySeconds: delay });
    getDb().prepare(`
      UPDATE coaching_decisions SET status='accepted', actual_outcome=?, updated_at=? WHERE id=?
    `).run(actual, startedAt.toISOString(), row.intervention_decision_id);
  }
  return toCommitment(getRow(row.id)!);
}

export function recordSessionOutcomeForCommitment(input: {
  sessionId: string;
  elapsedMinutes: number;
  focusScore: number | null;
  verifiedEvidence: boolean;
  completedAt?: Date;
}): CoachingCommitment | null {
  const row = getDb().prepare('SELECT * FROM coaching_commitments WHERE session_id=? ORDER BY started_at DESC LIMIT 1').get(input.sessionId) as CommitmentRow | undefined;
  if (!row) return null;
  const completedAt = input.completedAt ?? new Date();
  const ratio = Math.round(Math.max(0, Math.min(1, input.elapsedMinutes / Math.max(1, row.planned_minutes))) * 100) / 100;
  const completed = input.verifiedEvidence && ratio >= 0.8;
  const focus = input.focusScore === null ? null : Math.max(0, Math.min(100, input.focusScore));
  const score = completed ? Math.round((0.65 + 0.35 * ((focus ?? 50) / 100)) * 100) / 100 : 0;
  const state: CommitmentState = completed ? 'completed' : 'abandoned';
  const reason = completed
    ? `Verified session completed ${Math.round(ratio * 100)}% of the commitment.`
    : input.verifiedEvidence
      ? `Session completed only ${Math.round(ratio * 100)}% of the commitment.`
      : 'Session ended without verified activity evidence.';
  getDb().prepare(`
    UPDATE coaching_commitments
    SET state=?, completed_at=?, elapsed_minutes=?, focus_score=?, completion_ratio=?,
        outcome_score=?, outcome_reason=?, updated_at=?
    WHERE id=?
  `).run(state, completedAt.toISOString(), Math.max(0, Math.round(input.elapsedMinutes)), focus, ratio,
    score, reason, completedAt.toISOString(), row.id);
  if (row.source_type === 'planned_focus') {
    getDb().prepare(`
      UPDATE planned_focus_sessions SET status=?, updated_at=?
      WHERE id=? AND status NOT IN ('completed','cancelled')
    `).run(completed ? 'completed' : 'skipped', completedAt.toISOString(), row.source_id);
  }
  if (row.intervention_decision_id) {
    const actual = mergeOutcome(row.intervention_decision_id, {
      result: state, sessionId: input.sessionId, elapsedMinutes: input.elapsedMinutes,
      focusScore: focus, completionRatio: ratio, verifiedEvidence: input.verifiedEvidence,
    });
    getDb().prepare(`
      UPDATE coaching_decisions
      SET status=?, actual_outcome=?, outcome_score=?, evaluated_at=?, updated_at=?
      WHERE id=?
    `).run(completed ? 'completed' : 'failed', actual, score, completedAt.toISOString(), completedAt.toISOString(), row.intervention_decision_id);
  }
  return toCommitment(getRow(row.id)!);
}

export function rescheduleCommitment(id: number, delayMinutes = 30, now = new Date()): CoachingCommitment | null {
  const row = getRow(id);
  if (!row || !['scheduled', 'due', 'missed', 'rescheduled'].includes(row.state)) return null;
  const delay = Math.max(5, Math.min(24 * 60, Math.round(delayMinutes)));
  const nextStart = new Date(now.getTime() + delay * 60_000);
  const nextEnd = new Date(nextStart.getTime() + row.planned_minutes * 60_000);
  getDb().transaction(() => {
    if (row.source_type === 'planned_focus') {
      getDb().prepare(`UPDATE planned_focus_sessions SET planned_start=?, planned_end=?, status='planned', updated_at=? WHERE id=?`)
        .run(nextStart.toISOString(), nextEnd.toISOString(), now.toISOString(), row.source_id);
    } else if (row.source_type === 'soft_watch') {
      getDb().prepare(`
        UPDATE soft_watch_commitments
        SET intended_start_at=?, status='pending', reminder_sent_at=NULL, check_in_sent_at=NULL
        WHERE id=?
      `).run(nextStart.getTime(), row.source_id);
    } else {
      getDb().prepare(`UPDATE coaching_episodes SET accepted_at=?, updated_at=? WHERE id=?`)
        .run(nextStart.toISOString(), now.toISOString(), row.source_id);
    }
    getDb().prepare(`
      UPDATE coaching_commitments
      SET state='scheduled', planned_start_at=?, acknowledged_at=?, last_intervention_at=NULL,
          intervention_decision_id=NULL, outcome_score=NULL,
          outcome_reason='Rescheduled explicitly after a missed start', updated_at=?
      WHERE id=?
    `).run(nextStart.toISOString(), now.toISOString(), now.toISOString(), row.id);
    if (row.intervention_decision_id) {
      const actual = mergeOutcome(row.intervention_decision_id, { result: 'rescheduled', delayMinutes: delay, nextStartAt: nextStart.toISOString() });
      getDb().prepare(`
        UPDATE coaching_decisions SET status='accepted', actual_outcome=?, outcome_score=0.25,
          evaluated_at=?, updated_at=? WHERE id=?
      `).run(actual, now.toISOString(), now.toISOString(), row.intervention_decision_id);
    }
  })();
  return toCommitment(getRow(row.id)!);
}

export function recordCommitmentBlocker(id: number, text: string, now = new Date()): CoachingCommitment | null {
  const row = getRow(id);
  const normalized = text.trim().slice(0, 1000);
  if (!row || !['scheduled', 'due', 'missed', 'rescheduled'].includes(row.state)) return null;
  if (!normalized) return toCommitment(row);
  const lower = normalized.toLowerCase();
  const kind = /tired|sleep|energy|exhaust/.test(lower) ? 'energy'
    : /phone|scroll|distract|instagram|youtube/.test(lower) ? 'distraction'
      : /stuck|confus|hard|understand/.test(lower) ? 'difficulty'
        : /overwhelm|too much|behind|backlog/.test(lower) ? 'overload'
          : /priority|changed|different/.test(lower) ? 'changed_priority' : 'other';
  getDb().prepare(`
    UPDATE coaching_commitments SET acknowledged_at=?, blocker_kind=?, blocker_text=?, updated_at=? WHERE id=?
  `).run(now.toISOString(), kind, normalized, now.toISOString(), id);
  if (row.intervention_decision_id) {
    const actual = mergeOutcome(row.intervention_decision_id, { result: 'blocker_reported', blockerKind: kind, blockerText: normalized });
    getDb().prepare(`UPDATE coaching_decisions SET status='accepted', actual_outcome=?, updated_at=? WHERE id=?`)
      .run(actual, now.toISOString(), row.intervention_decision_id);
  }
  return toCommitment(getRow(id)!);
}

export function getCurrentCommitment(): CoachingCommitment | null {
  const row = getDb().prepare(`
    SELECT * FROM coaching_commitments
    WHERE state IN ('started','missed','due','scheduled','rescheduled')
    ORDER BY CASE state WHEN 'started' THEN 0 WHEN 'missed' THEN 1 WHEN 'due' THEN 2 ELSE 3 END,
             planned_start_at ASC
    LIMIT 1
  `).get() as CommitmentRow | undefined;
  return row ? toCommitment(row) : null;
}

export function getCommitmentStartPlan(id: number): { commitment: CoachingCommitment; minutes: number } | null {
  const commitment = getCommitment(id);
  if (!commitment || !['scheduled', 'due', 'missed', 'rescheduled'].includes(commitment.state)) return null;
  let variant: InterventionVariant | null = null;
  if (commitment.interventionDecisionId) {
    const row = getDb().prepare('SELECT variant FROM coaching_decisions WHERE id=?').get(commitment.interventionDecisionId) as { variant: InterventionVariant | null } | undefined;
    variant = row?.variant ?? null;
  }
  return { commitment, minutes: variant === 'tiny_start' ? Math.min(10, commitment.plannedMinutes) : commitment.plannedMinutes };
}

export function getInterventionLearningReport(): { variants: InterventionLearningRow[]; totalEvaluated: number } {
  const variants: InterventionVariant[] = ['direct_start', 'tiny_start', 'choice'];
  const rows = getDb().prepare(`
    SELECT variant, COUNT(*) AS evaluated,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN json_extract(actual_outcome, '$.result') IN ('started','completed') THEN 1 ELSE 0 END) AS started,
      AVG(outcome_score) AS average_outcome
    FROM coaching_decisions
    WHERE action_type='missed_start' AND variant IS NOT NULL AND evaluated_at IS NOT NULL
    GROUP BY variant
  `).all() as Array<{ variant: InterventionVariant; evaluated: number; completed: number; started: number; average_outcome: number | null }>;
  const byVariant = new Map(rows.map(row => [row.variant, row]));
  const report = variants.map(variant => {
    const row = byVariant.get(variant);
    return {
      variant,
      evaluated: row?.evaluated ?? 0,
      completed: row?.completed ?? 0,
      started: row?.started ?? 0,
      averageOutcome: row?.average_outcome === null || row?.average_outcome === undefined ? null : Math.round(row.average_outcome * 100) / 100,
    };
  });
  return { variants: report, totalEvaluated: report.reduce((sum, row) => sum + row.evaluated, 0) };
}
