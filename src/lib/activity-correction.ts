import { getDb } from './db';
import { computeFocusScore } from './focus-score';
import { getSessionScoringIntervals } from './session-activity';
import { getDailyActivityStats } from './scoring';
import { saveNativeAppPreference } from './native-app-classification';
import { touchIntelligence } from './intelligence';
import { isChromeApplication } from './guardian-client-status';

export type CorrectedActivityCategory = 'productive' | 'neutral' | 'distraction';

export interface ActivityCorrectionResult {
  sessionId: string | null;
  recomputedSession: string | null;
  revisedScore: number | null;
  affectedDomain: string | null;
  affectedApp: string | null;
  dailyStats: ReturnType<typeof getDailyActivityStats> | null;
}

type ActivityContext = {
  sessionId: string | null;
  domain: string | null;
  app: string | null;
  startedAt: string | null;
};

function categoryToClassification(category: CorrectedActivityCategory) {
  return category === 'productive' ? 'on_topic' : category === 'distraction' ? 'distraction' : 'unknown';
}

function dayInLifeosTimezone(iso: string | null) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function recomputeCompletedSummary(sessionId: string) {
  const db = getDb();
  const session = db.prepare(`
    SELECT started_at, total_paused_ms, state
    FROM guardian_sessions WHERE session_id = ?
  `).get(sessionId) as { started_at: number; total_paused_ms?: number; state: string } | undefined;
  const summary = db.prepare(`
    SELECT id FROM guardian_session_summaries WHERE session_id = ?
  `).get(sessionId) as { id: number } | undefined;
  if (!session || !summary || session.state !== 'COMPLETE') return null;

  const intervals = getSessionScoringIntervals(sessionId);
  const score = computeFocusScore({
    tick: 1,
    startedAt: Number(session.started_at),
    tabEventLog: [],
    focusScoreHistory: [],
    screenContext: null,
    totalPausedMs: Number(session.total_paused_ms || 0),
  }, undefined, null, intervals);

  let distractionEvents = 0;
  let productiveEvents = 0;
  let neutralEvents = 0;
  const domains = new Map<string, number>();
  for (const interval of intervals) {
    if (!interval.scoreEligible) continue;
    if (interval.category === 'productive') productiveEvents += 1;
    else if (interval.category === 'distraction') {
      distractionEvents += 1;
      if (interval.domain) domains.set(interval.domain, (domains.get(interval.domain) || 0) + 1);
    } else neutralEvents += 1;
  }
  const dominantDistractionDomain = [...domains.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // A correction is a revision of the complete evidence record. Use the
  // deterministic corrected score for both summary score fields so every
  // consumer sees the same value after a user correction.
  db.prepare(`
    UPDATE guardian_session_summaries
    SET average_focus_score = ?, final_focus_score = ?,
        distraction_events = ?, productive_events = ?, neutral_events = ?,
        dominant_distraction_domain = ?
    WHERE session_id = ?
  `).run(
    score.score, score.score, distractionEvents, productiveEvents,
    neutralEvents, dominantDistractionDomain, sessionId,
  );

  try {
    db.prepare('UPDATE task_session_logs SET focus_score = ? WHERE session_id = ?').run(score.score, sessionId);
  } catch { /* optional migration */ }
  try {
    db.prepare('UPDATE coaching_commitments SET focus_score = ?, outcome_score = ? WHERE session_id = ?')
      .run(score.score, score.score, sessionId);
  } catch { /* optional migration */ }

  return score.score;
}

function finalizeCorrection(
  context: ActivityContext,
  category: CorrectedActivityCategory,
  revisedScore: number | null,
): ActivityCorrectionResult {
  const db = getDb();
  const sessionId = context.sessionId;

  if (context.domain) {
    db.prepare(`
      INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
      VALUES (?, ?, 'other', 1.0, ?)
      ON CONFLICT(domain) DO UPDATE SET
        category = excluded.category, confidence = 1.0,
        ai_reasoning = excluded.ai_reasoning, updated_at = datetime('now')
    `).run(context.domain, category, `User correction via activity UI to ${category}`);
  } else if (context.app && !isChromeApplication(context.app)) {
    saveNativeAppPreference(context.app, category, `user correction via activity UI to ${category}`);
  }

  const date = dayInLifeosTimezone(context.startedAt);
  const dailyStats = date ? getDailyActivityStats(db, date) : null;
  if (date) {
    try {
      db.prepare(`
        UPDATE daily_scores
        SET productive_minutes = ?, distraction_minutes = ?, neutral_minutes = ?
        WHERE date = ?
      `).run(
        dailyStats?.productive_minutes ?? 0,
        dailyStats?.distraction_minutes ?? 0,
        dailyStats?.neutral_minutes ?? 0,
        date,
      );
    } catch { /* daily score cache is optional */ }
  }

  touchIntelligence('activity_correction');
  return {
    sessionId,
    recomputedSession: revisedScore === null ? null : sessionId,
    revisedScore,
    affectedDomain: context.domain,
    affectedApp: context.app,
    dailyStats,
  };
}

export function applyGuardianActivityCorrection(
  recordType: 'guardian_interval' | 'guardian_evidence_segment',
  recordId: string,
  category: CorrectedActivityCategory,
): ActivityCorrectionResult {
  const db = getDb();
  let context: ActivityContext | undefined;

  if (recordType === 'guardian_interval') {
    context = db.prepare(`
      SELECT session_id as sessionId, domain, app, observed_start as startedAt
      FROM session_activity_intervals WHERE interval_id = ?
    `).get(recordId) as ActivityContext | undefined;
    if (!context) throw new Error('interval not found');
    db.prepare(`
      UPDATE session_activity_intervals
      SET category = ?, updated_at = datetime('now')
      WHERE interval_id = ?
    `).run(category, recordId);
  } else {
    const segment = db.prepare(`
      SELECT session_id as sessionId, domain, app, observed_start as startedAt,
             observed_end as endedAt
      FROM guardian_activity_segments WHERE segment_id = ?
    `).get(recordId) as (ActivityContext & { endedAt: string }) | undefined;
    if (!segment) throw new Error('segment not found');
    context = segment;
    db.prepare(`
      UPDATE guardian_activity_slices
      SET category = ?, updated_at = datetime('now')
      WHERE session_id = ? AND slice_start >= ? AND slice_end <= ?
    `).run(category, segment.sessionId, segment.startedAt, segment.endedAt);
  }

  const revisedScore = context.sessionId ? recomputeCompletedSummary(context.sessionId) : null;
  return finalizeCorrection(context, category, revisedScore);
}

/**
 * Correct an older activities row that was emitted during a Guardian session.
 * Older rows are linked through guardian_session_id and, where available, the
 * rawActivityId written into the canonical interval evidence JSON.
 */
export function applyLegacyGuardianActivityCorrection(
  activityId: number,
  category: CorrectedActivityCategory,
): ActivityCorrectionResult {
  const db = getDb();
  const activity = db.prepare(`
    SELECT guardian_session_id as sessionId, domain, device_name as app, started_at as startedAt
    FROM activities WHERE id = ?
  `).get(activityId) as ActivityContext | undefined;
  if (!activity) throw new Error('activity not found');

  db.prepare(`UPDATE activities SET category = ? WHERE id = ?`).run(category, activityId);

  if (activity.sessionId) {
    const linkedIntervals = db.prepare(`
      SELECT interval_id
      FROM session_activity_intervals
      WHERE session_id = ?
        AND json_extract(COALESCE(evidence_json, '{}'), '$.rawActivityId') = ?
    `).all(activity.sessionId, activityId) as Array<{ interval_id: string }>;
    for (const interval of linkedIntervals) {
      db.prepare(`
        UPDATE session_activity_intervals
        SET category = ?, updated_at = datetime('now')
        WHERE interval_id = ? AND session_id = ?
      `).run(category, interval.interval_id, activity.sessionId);
    }
  }

  const revisedScore = activity.sessionId ? recomputeCompletedSummary(activity.sessionId) : null;
  return finalizeCorrection(activity, category, revisedScore);
}

export function correctionClassification(category: CorrectedActivityCategory) {
  return categoryToClassification(category);
}
