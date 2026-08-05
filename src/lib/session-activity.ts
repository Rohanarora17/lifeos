import { randomUUID } from 'crypto';
import { getDb } from '@/lib/db';
import {
  getBrowserCollectorState,
  getGuardianClientReadiness,
  selectedCaptureSource,
} from '@/lib/guardian-client-status';

export type SessionActivitySource = 'chrome' | 'vision' | 'idle' | 'private';
export type SessionActivityCategory = 'productive' | 'neutral' | 'distraction';

export interface SessionActivitySelection {
  accepted: boolean;
  selectedSource: SessionActivitySource | 'unavailable';
  reason: string;
}

export interface SessionActivityIntervalInput {
  intervalId?: string;
  sessionId: string;
  deviceId?: string | null;
  source: SessionActivitySource;
  observedStart: string;
  observedEnd: string;
  state?: 'active' | 'idle' | 'locked' | 'private';
  app?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  domain?: string | null;
  title?: string | null;
  category?: SessionActivityCategory;
  subcategory?: string | null;
  scoreEligible?: boolean;
  counted?: boolean;
  selectionReason: string;
  captureStatus?: string;
  engagementState?: 'interactive' | 'passive_engaged' | 'uncertain' | 'confirmed_active' | 'inactive' | 'private' | 'disconnected';
  engagementConfidence?: number | null;
  presenceCheckId?: string | null;
  confirmationStatus?: string | null;
  evidence?: Record<string, unknown>;
}

export interface CanonicalScoringInterval {
  source: SessionActivitySource;
  durationSeconds: number;
  state: string;
  domain: string | null;
  category: SessionActivityCategory;
  scoreEligible: boolean;
  evidence: Record<string, unknown>;
}

export function arbitrateSessionActivity(sessionId: string, proposed: SessionActivitySource): SessionActivitySelection {
  const selected = selectedCaptureSource(sessionId);
  const client = getGuardianClientReadiness();
  const browser = getBrowserCollectorState(sessionId);
  if (selected === 'unavailable') {
    return { accepted: false, selectedSource: selected, reason: 'Vision client heartbeat is unavailable or unverified.' };
  }
  if (proposed === 'private') {
    return { accepted: selected === 'vision', selectedSource: selected, reason: 'Sensitive native context is represented without visual content.' };
  }
  if (proposed === 'idle') {
    return { accepted: selected === 'idle', selectedSource: selected, reason: 'Native system state is authoritative for idle and lock status.' };
  }
  if (selected !== proposed) {
    return {
      accepted: false,
      selectedSource: selected,
      reason: proposed === 'chrome'
        ? `Chrome evidence was suppressed because ${selected === 'vision' ? 'Chrome was not the verified frontmost collector' : 'the device was idle'}.`
        : `Vision evidence was suppressed because ${selected === 'chrome' ? 'Chrome was verified frontmost with fresh extension telemetry' : 'the device was idle'}.`,
    };
  }
  return {
    accepted: true,
    selectedSource: selected,
    reason: selected === 'chrome'
      ? client.systemState === 'idle' && browser.mediaPlaybackActive
        ? `Chrome remained selected because verified foreground media was playing${browser.mediaTitle ? `: ${browser.mediaTitle}` : ''}.`
        : 'Chrome was verified as the frontmost app and extension telemetry was fresh.'
      : 'A non-Chrome app was verified frontmost, so the native vision client was selected.',
  };
}

export function recordSessionActivityInterval(input: SessionActivityIntervalInput) {
  const startMs = Date.parse(input.observedStart);
  const endMs = Date.parse(input.observedEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const durationSeconds = Math.max(1, Math.round((endMs - startMs) / 1_000));
  const client = getGuardianClientReadiness(endMs);
  const db = getDb();
  const exact = db.prepare(`
    SELECT interval_id
    FROM session_activity_intervals
    WHERE session_id = ? AND source = ? AND observed_start = ? AND observed_end = ?
    LIMIT 1
  `).get(
    input.sessionId,
    input.source,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  ) as { interval_id: string } | undefined;

  // Collectors retry delivery after network failures. Return the already accepted
  // interval before merge logic so an exact retry cannot inflate counted dwell.
  if (exact) return exact.interval_id;

  const latest = db.prepare(`
    SELECT interval_id, observed_end, duration_seconds
    FROM session_activity_intervals
    WHERE session_id = ? AND source = ? AND counted = ? AND score_eligible = ?
      AND COALESCE(app, '') = COALESCE(?, '')
      AND COALESCE(domain, '') = COALESCE(?, '')
      AND COALESCE(url, '') = COALESCE(?, '')
      AND COALESCE(title, '') = COALESCE(?, '')
      AND COALESCE(window_title, '') = COALESCE(?, '')
      AND category = ?
      AND engagement_state = ?
    ORDER BY observed_end DESC
    LIMIT 1
  `).get(
    input.sessionId,
    input.source,
    input.counted === false ? 0 : 1,
    input.scoreEligible === false ? 0 : 1,
    input.app ?? null,
    input.domain ?? null,
    input.url ?? null,
    input.title ?? null,
    input.windowTitle ?? null,
    input.category ?? 'neutral',
    input.engagementState ?? 'interactive',
  ) as { interval_id: string; observed_end: string; duration_seconds: number } | undefined;

  if (latest) {
    const gapMs = startMs - Date.parse(latest.observed_end);
    if (gapMs >= -2_000 && gapMs <= 2_000) {
      db.prepare(`
        UPDATE session_activity_intervals
        SET observed_end = ?, duration_seconds = duration_seconds + ?,
            window_title = COALESCE(?, window_title), title = COALESCE(?, title),
            selection_reason = ?, capture_status = ?, evidence_json = ?,
            engagement_state = COALESCE(?, engagement_state),
            engagement_confidence = COALESCE(?, engagement_confidence),
            presence_check_id = COALESCE(?, presence_check_id),
            confirmation_status = COALESCE(?, confirmation_status),
            updated_at = datetime('now')
        WHERE interval_id = ?
      `).run(
        new Date(endMs).toISOString(), durationSeconds,
        input.windowTitle ?? null, input.title ?? null,
        input.selectionReason, input.captureStatus ?? 'verified', JSON.stringify(input.evidence ?? {}),
        input.engagementState ?? null, input.engagementConfidence ?? null,
        input.presenceCheckId ?? null, input.confirmationStatus ?? null,
        latest.interval_id,
      );
      return latest.interval_id;
    }
  }

  const intervalId = input.intervalId || randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO session_activity_intervals (
      interval_id, session_id, device_id, source, observed_start, observed_end,
      duration_seconds, state, app, window_title, url, domain, title, category,
      subcategory, score_eligible, counted, selection_reason, capture_status, evidence_json
      , engagement_state, engagement_confidence, presence_check_id, confirmation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    intervalId, input.sessionId, input.deviceId || client.deviceId || 'unknown', input.source,
    new Date(startMs).toISOString(), new Date(endMs).toISOString(), durationSeconds,
    input.state ?? 'active', input.app ?? null, input.windowTitle ?? null,
    input.url ?? null, input.domain ?? null, input.title ?? null,
    input.category ?? 'neutral', input.subcategory ?? null,
    input.scoreEligible === false ? 0 : 1, input.counted === false ? 0 : 1,
    input.selectionReason, input.captureStatus ?? 'verified', JSON.stringify(input.evidence ?? {}),
    input.engagementState ?? 'interactive', input.engagementConfidence ?? null,
    input.presenceCheckId ?? null, input.confirmationStatus ?? null,
  );
  return intervalId;
}

export function getSessionActivityEvidenceCount(sessionId: string) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM session_activity_intervals
    WHERE session_id = ? AND counted = 1 AND score_eligible = 1
  `).get(sessionId) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export function getSessionScoringIntervals(sessionId: string): CanonicalScoringInterval[] {
  const rows = getDb().prepare(`
    SELECT source, duration_seconds, state, domain, category, score_eligible, evidence_json
    FROM session_activity_intervals
    WHERE session_id = ? AND counted = 1
    ORDER BY observed_start ASC
  `).all(sessionId) as Array<{
    source: SessionActivitySource; duration_seconds: number; state: string;
    domain: string | null; category: SessionActivityCategory; score_eligible: number;
    evidence_json: string;
  }>;
  return rows.map(row => {
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(row.evidence_json || '{}') as Record<string, unknown>; } catch { /* malformed legacy evidence */ }
    return {
      source: row.source,
      durationSeconds: Number(row.duration_seconds || 0),
      state: row.state,
      domain: row.domain,
      category: row.category,
      scoreEligible: row.score_eligible === 1,
      evidence,
    };
  });
}

export function attachVisionAssessment(sessionId: string, assessment: {
  app: string;
  capturedAt: number;
  taskAlignment: number;
  engagementDepth: string;
  contentSummary: string;
  confidence: number;
}) {
  const db = getDb();
  const row = db.prepare(`
    SELECT interval_id, evidence_json
    FROM session_activity_intervals
    WHERE session_id = ? AND source = 'vision' AND counted = 1
      AND app = ? AND observed_end >= ?
    ORDER BY observed_end DESC
    LIMIT 1
  `).get(
    sessionId,
    assessment.app,
    new Date(assessment.capturedAt - 10_000).toISOString(),
  ) as { interval_id: string; evidence_json: string } | undefined;
  if (!row) return null;
  let evidence: Record<string, unknown> = {};
  try { evidence = JSON.parse(row.evidence_json || '{}') as Record<string, unknown>; } catch { /* replace malformed evidence */ }
  db.prepare(`
    UPDATE session_activity_intervals
    SET evidence_json = ?, capture_status = 'vision_assessed', updated_at = datetime('now')
    WHERE interval_id = ?
  `).run(JSON.stringify({ ...evidence, visionAssessment: assessment }), row.interval_id);
  return row.interval_id;
}
