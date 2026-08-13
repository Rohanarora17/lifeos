import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import { isChromeApplication } from '@/lib/guardian-client-status';
import { recordSessionActivityInterval } from '@/lib/session-activity';

export const STATIC_ACTIVITY_GRACE_MS = 3 * 60_000;
export const PRESENCE_RESPONSE_MS = 60_000;
export const PRESENCE_REASK_COOLDOWN_MS = 10 * 60_000;

export type PresenceResolution = 'still_working' | 'break' | 'end' | 'timeout';

export interface GuardianPresenceCheck {
  checkId: string;
  sessionId: string;
  targetTitle: string;
  uncertainStartedAt: number;
  askedAt: number;
  responseDeadlineAt: number;
  resolvedAt: number | null;
  resolution: PresenceResolution | null;
  app: string | null;
  windowTitle: string | null;
  secondsRemaining: number;
}

type PresenceRow = {
  check_id: string;
  session_id: string;
  target_title: string;
  uncertain_started_at: number;
  asked_at: number;
  response_deadline_at: number;
  resolved_at: number | null;
  resolution: PresenceResolution | null;
  app: string | null;
  window_title: string | null;
};

function mapCheck(row: PresenceRow, now = Date.now()): GuardianPresenceCheck {
  return {
    checkId: row.check_id,
    sessionId: row.session_id,
    targetTitle: row.target_title,
    uncertainStartedAt: row.uncertain_started_at,
    askedAt: row.asked_at,
    responseDeadlineAt: row.response_deadline_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    app: row.app,
    windowTitle: row.window_title,
    secondsRemaining: Math.max(0, Math.ceil((row.response_deadline_at - now) / 1_000)),
  };
}

function selectCheck(where: string, value: string) {
  return getDb().prepare(`
    SELECT pc.*, gs.target_title
    FROM guardian_presence_checks pc
    JOIN guardian_sessions gs ON gs.session_id = pc.session_id
    WHERE ${where}
    ORDER BY pc.asked_at DESC
    LIMIT 1
  `).get(value) as PresenceRow | undefined;
}

export function getPendingPresenceCheck(sessionId: string, now = Date.now()) {
  const row = selectCheck('pc.session_id = ? AND pc.resolved_at IS NULL', sessionId);
  return row ? mapCheck(row, now) : null;
}

export function hasRecentStillWorkingConfirmation(sessionId: string, now = Date.now()) {
  const latest = selectCheck('pc.session_id = ?', sessionId);
  return Boolean(
    latest?.resolution === 'still_working'
    && latest.resolved_at
    && now - latest.resolved_at < PRESENCE_REASK_COOLDOWN_MS,
  );
}

export function isWithinSessionPresenceGrace(sessionId: string, now = Date.now()) {
  const sessionStart = getDb().prepare('SELECT started_at FROM guardian_sessions WHERE session_id = ?')
    .pluck().get(sessionId) as number | undefined;
  return sessionStart !== undefined
    && Number.isFinite(now)
    && now >= sessionStart
    && now - sessionStart < STATIC_ACTIVITY_GRACE_MS;
}

export function hasRecentTaskAlignedVisionEvidence(input: {
  sessionId: string;
  app?: string | null;
  windowTitle?: string | null;
  now?: number;
}) {
  const requestedNow = input.now ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const rows = getDb().prepare(`
    SELECT observed_at, app, window_title, task_alignment, engagement_depth,
           confidence, change_magnitude
    FROM screen_observations
    WHERE session_id = ?
      AND source = 'screen_vision'
      AND observed_at >= ?
      AND productive_for_goals = 1
      AND confidence >= 0.6
      AND engagement_depth NOT IN ('idle', 'distraction')
    ORDER BY observed_at DESC
    LIMIT 5
  `).all(
    input.sessionId,
    new Date(now - STATIC_ACTIVITY_GRACE_MS).toISOString(),
  ) as Array<{
    observed_at: string;
    app: string | null;
    window_title: string | null;
    task_alignment: number | null;
    engagement_depth: string | null;
    confidence: number | null;
    change_magnitude: string | null;
  }>;

  const expectedApp = input.app?.trim().toLowerCase() || null;
  const expectedWindow = input.windowTitle?.trim().toLowerCase() || null;
  return rows.some((row) => {
    const observedAt = Date.parse(row.observed_at);
    if (!Number.isFinite(observedAt) || observedAt > now + 5_000) return false;
    if (Number(row.task_alignment ?? 0) < 60) return false;
    if (expectedApp && row.app?.trim().toLowerCase() !== expectedApp) return false;
    if (
      expectedWindow
      && row.window_title
      && row.window_title.trim().toLowerCase() !== expectedWindow
    ) return false;
    return row.change_magnitude !== 'none'
      || row.engagement_depth === 'active_creation'
      || row.engagement_depth === 'active_learning'
      || row.engagement_depth === 'passive_consumption';
  });
}

function markWindowUncertain(sessionId: string, checkId: string, startMs: number, endMs: number) {
  const db = getDb();
  const splitRows = db.prepare(`
    SELECT * FROM session_activity_intervals
    WHERE session_id = ? AND observed_start < ? AND observed_end > ?
  `).all(sessionId, new Date(startMs).toISOString(), new Date(startMs).toISOString()) as Array<Record<string, unknown>>;
  for (const row of splitRows) {
    const originalEnd = String(row.observed_end);
    const originalEndMs = Date.parse(originalEnd);
    db.prepare(`
      UPDATE session_activity_intervals
      SET observed_end = ?, duration_seconds = ?, updated_at = datetime('now')
      WHERE interval_id = ?
    `).run(
      new Date(startMs).toISOString(),
      Math.max(0, Math.round((startMs - Date.parse(String(row.observed_start))) / 1_000)),
      row.interval_id,
    );
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(String(row.evidence_json || '{}')) as Record<string, unknown>; } catch { /* keep empty */ }
    recordSessionActivityInterval({
      sessionId,
      source: row.source as 'chrome' | 'vision' | 'idle' | 'private',
      observedStart: new Date(startMs).toISOString(),
      observedEnd: new Date(Math.min(originalEndMs, endMs)).toISOString(),
      state: row.state as 'active' | 'idle' | 'locked' | 'private',
      app: row.app ? String(row.app) : null,
      windowTitle: row.window_title ? String(row.window_title) : null,
      url: row.url ? String(row.url) : null,
      domain: row.domain ? String(row.domain) : null,
      title: row.title ? String(row.title) : null,
      category: row.category as 'productive' | 'neutral' | 'distraction',
      subcategory: row.subcategory ? String(row.subcategory) : null,
      scoreEligible: false,
      selectionReason: 'Static foreground activity requires user confirmation before it can be scored.',
      captureStatus: 'awaiting_user_confirmation',
      engagementState: 'uncertain',
      engagementConfidence: 0.25,
      presenceCheckId: checkId,
      confirmationStatus: 'pending',
      evidence,
    });
  }
  db.prepare(`
    UPDATE session_activity_intervals
    SET score_eligible = 0,
        engagement_state = 'uncertain', engagement_confidence = 0.25,
        presence_check_id = ?, confirmation_status = 'pending',
        selection_reason = 'Static foreground activity requires user confirmation before it can be scored.',
        capture_status = 'awaiting_user_confirmation', updated_at = datetime('now')
    WHERE session_id = ? AND observed_start >= ? AND observed_start < ?
  `).run(checkId, sessionId, new Date(startMs).toISOString(), new Date(endMs).toISOString());
}

function extendUncertainEvidence(check: GuardianPresenceCheck, observedAt: number, app: string | null, windowTitle: string | null) {
  const db = getDb();
  const latestEnd = db.prepare(`
    SELECT MAX(observed_end) AS value
    FROM session_activity_intervals
    WHERE session_id = ? AND presence_check_id = ?
  `).pluck().get(check.sessionId, check.checkId) as string | null;
  const startMs = Math.max(check.uncertainStartedAt, latestEnd ? Date.parse(latestEnd) : check.uncertainStartedAt);
  if (observedAt <= startMs) return;
  const source = isChromeApplication(app) ? 'chrome' : 'vision';
  const intervalId = recordSessionActivityInterval({
    sessionId: check.sessionId,
    source,
    observedStart: new Date(startMs).toISOString(),
    observedEnd: new Date(observedAt).toISOString(),
    state: 'active',
    app,
    windowTitle,
    title: windowTitle || app || 'Static foreground activity',
    category: 'neutral',
    subcategory: 'awaiting_presence_confirmation',
    scoreEligible: false,
    selectionReason: 'Static foreground activity requires user confirmation before it can be scored.',
    captureStatus: 'awaiting_user_confirmation',
    engagementState: 'uncertain',
    engagementConfidence: 0.25,
    presenceCheckId: check.checkId,
    confirmationStatus: 'pending',
    evidence: { inputIdle: true, presenceCheckId: check.checkId },
  });
  if (intervalId) {
    db.prepare(`
      UPDATE session_activity_intervals
      SET engagement_state = 'uncertain', engagement_confidence = 0.25,
          presence_check_id = ?, confirmation_status = 'pending'
      WHERE interval_id = ?
    `).run(check.checkId, intervalId);
  }
}

export function observeStaticActivity(input: {
  sessionId: string;
  inputIdleSeconds: number;
  app?: string | null;
  windowTitle?: string | null;
  observedAt?: number;
}) {
  const requestedNow = input.observedAt ?? Date.now();
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();
  const sessionStart = getDb().prepare('SELECT started_at FROM guardian_sessions WHERE session_id = ?')
    .pluck().get(input.sessionId) as number | undefined;
  if (isWithinSessionPresenceGrace(input.sessionId, now)) {
    return { check: getPendingPresenceCheck(input.sessionId, now), timedOut: false, created: false };
  }
  if (input.inputIdleSeconds * 1_000 < STATIC_ACTIVITY_GRACE_MS) {
    return { check: getPendingPresenceCheck(input.sessionId, now), timedOut: false, created: false };
  }
  if (hasRecentTaskAlignedVisionEvidence({
    sessionId: input.sessionId,
    app: input.app,
    windowTitle: input.windowTitle,
    now,
  })) {
    return { check: getPendingPresenceCheck(input.sessionId, now), timedOut: false, created: false };
  }

  let check = getPendingPresenceCheck(input.sessionId, now);
  let created = false;
  if (!check) {
    const latest = selectCheck('pc.session_id = ?', input.sessionId);
    if (latest?.resolved_at && now - latest.resolved_at < PRESENCE_REASK_COOLDOWN_MS) {
      return { check: null, timedOut: false, created: false };
    }
    const uncertainStartedAt = Math.max(
      sessionStart ?? now,
      now - input.inputIdleSeconds * 1_000,
      latest?.resolved_at ?? 0,
    );
    const checkId = randomUUID();
    getDb().prepare(`
      INSERT INTO guardian_presence_checks (
        check_id, session_id, uncertain_started_at, asked_at, response_deadline_at,
        app, window_title, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkId, input.sessionId, uncertainStartedAt, now, now + PRESENCE_RESPONSE_MS,
      input.app ?? null, input.windowTitle ?? null,
      JSON.stringify({ inputIdleSeconds: input.inputIdleSeconds, source: 'native_input_idle' }),
    );
    check = getPendingPresenceCheck(input.sessionId, now);
    created = true;
    if (check) markWindowUncertain(input.sessionId, check.checkId, uncertainStartedAt, now);
  }

  if (check) extendUncertainEvidence(check, now, input.app ?? check.app, input.windowTitle ?? check.windowTitle);
  return { check, timedOut: Boolean(check && now >= check.responseDeadlineAt), created };
}

export function resolvePresenceCheck(
  checkId: string,
  resolution: PresenceResolution,
  now = Date.now(),
  expectedSessionId?: string,
) {
  const row = selectCheck('pc.check_id = ?', checkId);
  if (!row) return null;
  const check = mapCheck(row, now);
  if (expectedSessionId && check.sessionId !== expectedSessionId) return null;
  if (check.resolvedAt) return check.resolution === resolution ? check : null;
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE guardian_presence_checks SET resolved_at = ?, resolution = ? WHERE check_id = ?
    `).run(now, resolution, checkId);
    if (resolution === 'still_working') {
      getDb().prepare(`
        UPDATE session_activity_intervals
        SET score_eligible = 1, state = 'active', category = 'productive',
            subcategory = 'user_confirmed_work', engagement_state = 'confirmed_active',
            engagement_confidence = 1.0, confirmation_status = 'confirmed',
            selection_reason = 'The user confirmed they were still working during this static interval.',
            capture_status = 'user_confirmed', updated_at = datetime('now')
        WHERE presence_check_id = ?
      `).run(checkId);
    } else {
      getDb().prepare(`
        UPDATE session_activity_intervals
        SET score_eligible = 0, state = 'idle', category = 'neutral',
            subcategory = 'confirmed_inactive', engagement_state = 'inactive',
            engagement_confidence = 1.0, confirmation_status = ?,
            selection_reason = ?, capture_status = 'user_resolved', updated_at = datetime('now')
        WHERE presence_check_id = ?
      `).run(
        resolution,
        resolution === 'timeout'
          ? 'No response was received, so the interval remained unscored and Guardian paused.'
          : 'The user confirmed they were taking a break, so the interval remained unscored.',
        checkId,
      );
    }
  })();
  const resolved = selectCheck('pc.check_id = ?', checkId);
  return resolved ? mapCheck(resolved, now) : null;
}
