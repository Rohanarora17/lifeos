import { getDb } from '@/lib/db';
import { computeFocusScore } from '@/lib/focus-score';
import { getEvidenceIntervals, getSessionEvidenceMode } from '@/lib/guardian-evidence-store';
import type { GuardianState } from '@/lib/guardian-types';

export interface GuardianShadowReport {
  sessionId: string;
  legacyScore: number | null;
  shadowScore: number | null;
  scoreDifference: number | null;
  legacySeconds: number;
  canonicalSeconds: number;
  eligibleSeconds: number;
  unverifiedSeconds: number;
  overlapViolations: number;
  sourceMismatches: number;
  lateEvidenceCount: number;
  incompatibleEventCount: number;
  sourceTotals: Record<string, number>;
  accepted: boolean;
  recordedAt: string;
}

type MetricRow = {
  legacy_seconds: number | null;
  canonical_seconds: number | null;
  eligible_seconds: number | null;
  unverified_seconds: number | null;
  late_evidence_count: number | null;
  incompatible_event_count: number | null;
};

function number(value: unknown) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function mapReport(row: Record<string, unknown>): GuardianShadowReport {
  let sourceTotals: Record<string, number> = {};
  try {
    sourceTotals = JSON.parse(String(row.source_totals_json || '{}')) as Record<string, number>;
  } catch { /* Retain an empty diagnostic map if a legacy row is malformed. */ }
  return {
    sessionId: String(row.session_id),
    legacyScore: row.legacy_score === null ? null : number(row.legacy_score),
    shadowScore: row.shadow_score === null ? null : number(row.shadow_score),
    scoreDifference: row.score_difference === null ? null : number(row.score_difference),
    legacySeconds: number(row.legacy_seconds),
    canonicalSeconds: number(row.canonical_seconds),
    eligibleSeconds: number(row.eligible_seconds),
    unverifiedSeconds: number(row.unverified_seconds),
    overlapViolations: number(row.overlap_violations),
    sourceMismatches: number(row.source_mismatches),
    lateEvidenceCount: number(row.late_evidence_count),
    incompatibleEventCount: number(row.incompatible_event_count),
    sourceTotals,
    accepted: number(row.accepted) === 1,
    recordedAt: String(row.recorded_at),
  };
}

export function recordGuardianShadowReport(session: GuardianState) {
  if (getSessionEvidenceMode(session.sessionId) !== 'shadow') return null;
  const db = getDb();
  const metrics = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(duration_seconds), 0) FROM session_activity_intervals
       WHERE session_id = ? AND counted = 1) AS legacy_seconds,
      COALESCE(SUM(CASE WHEN s.provisional = 0 AND s.source != 'unverified' THEN s.duration_seconds ELSE 0 END), 0) AS canonical_seconds,
      COALESCE(SUM(CASE WHEN s.provisional = 0 AND s.score_eligible = 1 THEN s.duration_seconds ELSE 0 END), 0) AS eligible_seconds,
      COALESCE(SUM(CASE WHEN s.provisional = 0 AND s.source = 'unverified' THEN s.duration_seconds ELSE 0 END), 0) AS unverified_seconds,
      (SELECT COUNT(*) FROM guardian_evidence_events e
       WHERE e.session_id = ? AND e.late_after_watermark = 1) AS late_evidence_count,
      (SELECT COUNT(*) FROM guardian_evidence_events e
       WHERE e.session_id = ? AND e.compatible = 0) AS incompatible_event_count
    FROM guardian_activity_slices s
    WHERE s.session_id = ?
  `).get(
    session.sessionId,
    session.sessionId,
    session.sessionId,
    session.sessionId,
  ) as MetricRow;
  const overlapViolations = number(db.prepare(`
    SELECT COUNT(*) FROM guardian_activity_slices left_slice
    JOIN guardian_activity_slices right_slice
      ON right_slice.session_id = left_slice.session_id
     AND right_slice.slice_start > left_slice.slice_start
     AND right_slice.slice_start < left_slice.slice_end
    WHERE left_slice.session_id = ? AND left_slice.provisional = 0 AND right_slice.provisional = 0
  `).pluck().get(session.sessionId));
  const sourceMismatches = number(db.prepare(`
    SELECT COUNT(*) FROM guardian_activity_slices s
    WHERE s.session_id = ? AND s.provisional = 0 AND s.source != 'unverified'
      AND EXISTS (
        SELECT 1 FROM session_activity_intervals i
        WHERE i.session_id = s.session_id AND i.counted = 1
          AND i.observed_start < s.slice_end AND i.observed_end > s.slice_start
          AND i.source != s.source
      )
  `).pluck().get(session.sessionId));
  const sourceTotals = Object.fromEntries((db.prepare(`
    SELECT source, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM guardian_activity_slices
    WHERE session_id = ? AND provisional = 0
    GROUP BY source
  `).all(session.sessionId) as Array<{ source: string; seconds: number }>).map(row => [row.source, number(row.seconds)]));
  const intervals = getEvidenceIntervals(session.sessionId, 'shadow');
  const shadowResult = number(metrics.eligible_seconds) >= 30
    ? computeFocusScore(session, session.sessionPolicy ?? undefined, session.energyComposite, intervals)
    : null;
  const legacyScore = session.focusScoreHistory.length > 0
    ? session.focusScoreHistory.at(-1) ?? null
    : null;
  const shadowScore = shadowResult?.score ?? null;
  const scoreDifference = legacyScore === null || shadowScore === null
    ? null
    : shadowScore - legacyScore;
  const accepted = overlapViolations === 0
    && number(metrics.unverified_seconds) === 0
    && number(metrics.incompatible_event_count) === 0
    && number(metrics.canonical_seconds) > 0;
  const recordedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO guardian_shadow_reports (
      session_id, legacy_score, shadow_score, score_difference,
      legacy_seconds, canonical_seconds, eligible_seconds, unverified_seconds,
      overlap_violations, source_mismatches, late_evidence_count,
      incompatible_event_count, source_totals_json, accepted, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      legacy_score = excluded.legacy_score,
      shadow_score = excluded.shadow_score,
      score_difference = excluded.score_difference,
      legacy_seconds = excluded.legacy_seconds,
      canonical_seconds = excluded.canonical_seconds,
      eligible_seconds = excluded.eligible_seconds,
      unverified_seconds = excluded.unverified_seconds,
      overlap_violations = excluded.overlap_violations,
      source_mismatches = excluded.source_mismatches,
      late_evidence_count = excluded.late_evidence_count,
      incompatible_event_count = excluded.incompatible_event_count,
      source_totals_json = excluded.source_totals_json,
      accepted = excluded.accepted,
      recorded_at = excluded.recorded_at
  `).run(
    session.sessionId, legacyScore, shadowScore, scoreDifference,
    number(metrics.legacy_seconds), number(metrics.canonical_seconds),
    number(metrics.eligible_seconds), number(metrics.unverified_seconds),
    overlapViolations, sourceMismatches, number(metrics.late_evidence_count),
    number(metrics.incompatible_event_count), JSON.stringify(sourceTotals),
    accepted ? 1 : 0, recordedAt,
  );
  return getGuardianShadowReport(session.sessionId);
}

export function getGuardianShadowReport(sessionId: string) {
  const row = getDb().prepare(`SELECT * FROM guardian_shadow_reports WHERE session_id = ?`)
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? mapReport(row) : null;
}

export function getGuardianShadowRolloutStatus(limit = 10) {
  const reports = (getDb().prepare(`
    SELECT * FROM guardian_shadow_reports ORDER BY recorded_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(50, limit))) as Array<Record<string, unknown>>).map(mapReport);
  const latestTwo = reports.slice(0, 2);
  return {
    requiredAcceptedSessions: 2,
    recordedSessions: reports.length,
    acceptedSessions: latestTwo.filter(report => report.accepted).length,
    eligibleForCutover: latestTwo.length === 2 && latestTwo.every(report => report.accepted),
    reports,
  };
}
