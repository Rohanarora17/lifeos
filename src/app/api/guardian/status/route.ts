// GET /api/guardian/status — full system diagnostic snapshot
// Call this from terminal: curl http://localhost:3000/api/guardian/status | jq .

import { NextResponse } from 'next/server';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';
import { getGuardianClientReadiness, selectedCaptureSource } from '@/lib/guardian-client-status';
import { getDb } from '@/lib/db';

export async function GET() {
  const db = getDb();
  const session = getActiveGuardianSession();

  // Screen observations in last hour
  const recentObs = db.prepare(`
    SELECT COUNT(*) as cnt, MAX(observed_at) as last, source
    FROM screen_observations
    WHERE observed_at >= datetime('now', '-1 hour', 'localtime')
    GROUP BY source
  `).all() as Array<{ cnt: number; last: string; source: string }>;

  const totalObs = db.prepare('SELECT COUNT(*) as cnt FROM screen_observations').get() as { cnt: number };
  const last5Obs = db.prepare(`
    SELECT observed_at, source, app, window_title, task_alignment, engagement_depth, category
    FROM screen_observations ORDER BY observed_at DESC LIMIT 5
  `).all();

  // Policy state
  const activePolicy = db.prepare(
    "SELECT version, created_at, promoted_at FROM guardian_artifact_versions WHERE is_active = 1 AND artifact_type = 'guardian_policy_bundle'"
  ).get() as { version: string; created_at: string; promoted_at: string } | undefined;

  // Recent sessions
  const recentSessions = db.prepare(
    'SELECT session_id, target_title, started_at, state FROM guardian_sessions ORDER BY rowid DESC LIMIT 5'
  ).all();

  // Check pending state
  const pendingCheckin = db.prepare("SELECT value FROM settings WHERE key = 'pending_checkin_type'").get() as { value: string } | undefined;
  const pendingDate = db.prepare("SELECT value FROM settings WHERE key = 'pending_checkin_date'").get() as { value: string } | undefined;

  const clientReadiness = getGuardianClientReadiness();

  return NextResponse.json({
    timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    macbook_client: {
      ...clientReadiness,
      selected_source: session ? selectedCaptureSource(session.sessionId) : null,
    },
    active_session: session ? {
      sessionId: session.sessionId,
      goal: session.goalTitle ?? session.targetTitle,
      state: session.state,
      elapsed_minutes: Math.round((Date.now() - session.startedAt) / 60_000),
      focus_score: session.focusScoreHistory.at(-1) ?? null,
      policy_version: session.sessionPolicy?.version ?? 'none (using base)',
      screen_context: session.screenContext ? {
        latestAlignment: session.screenContext.latestObservation?.taskAlignment ?? null,
        engagementDepth: session.screenContext.engagementDepth,
        visionTrend: session.screenContext.visionTrend,
        totalCaptures: session.screenContext.recentObservations?.length ?? 0,
        captureState: session.screenContext.captureState,
      } : null,
    } : null,
    screen_observations: {
      total_all_time: totalObs.cnt,
      last_hour_by_source: recentObs,
      last_5: last5Obs,
    },
    policy: activePolicy ?? { version: 'none', note: 'no active policy in DB' },
    recent_sessions_in_db: recentSessions,
    checkin_state: {
      pending_type: pendingCheckin?.value ?? '',
      pending_date: pendingDate?.value ?? '',
    },
  }, { status: 200 });
}
