import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import fs from 'fs';
import path from 'path';

/**
 * POST /api/admin/full-reset
 * Clears product/user data in one shot while preserving credential/auth settings.
 *
 * Body: { "confirm": "FULL_RESET" }
 * GET:  preview row counts, nothing deleted.
 */

const CLEAR_TABLES = [
  // Dependent task/session/plan data first
  'task_recommendation_feedback',
  'task_session_logs',
  'node_task_links',
  'session_completions',
  'session_feedback',
  'planned_focus_sessions',
  'daily_plans',
  'soft_watch_commitments',
  'tasks',

  // Goals, habits, intentions, knowledge graph
  'habit_checkins',
  'habits',
  'intentions',
  'goal_time_logs',
  'knowledge_edges',
  'goals',
  'knowledge_nodes',

  // Calendar, GitHub, activity, telemetry
  'calendar_events',
  'github_activity',
  'activities',
  'domain_categories',
  'daily_domain_aggregates',
  'daily_scores',
  'nudge_log',
  'tab_switches',
  'screen_time',
  'screen_observations',
  'phone_screen_time',
  'telemetry_events_v1',
  'session_domain_classifications',

  // Guardian sessions, feedback, overrides, evaluations, and learned policies
  'native_guidance_feedback',
  'alerts',
  'guardian_session_reflections',
  'guardian_session_summaries',
  'guardian_override_requests',
  'guardian_overrides',
  'guardian_event_log',
  'guardian_interventions',
  'guardian_canary_results',
  'guardian_eval_runs',
  'guardian_promotions',
  'guardian_artifact_versions',
  'guardian_eval_cases',
  'guardian_semantic_profiles',
  'guardian_sessions',
  'session_ticks',
  'override_follow_ups',
  'calibration_history',
  'energy_readings',
  'weekly_plans',
  'weekly_reckonings',
  'daily_checkins',

  // Behavioral memory, personalization, intelligence, and AI state
  'behavioral_memory',
  'behavior_snapshots',
  'behavior_insights',
  'behavior_profile',
  'ai_insights',
  'user_intelligence_profile',
  'mem_facts',
  'mem_episodes',
  'mem_working',
  'mem_procedures',
  'jarvis_explanations',
  'voice_turns',
  'telegram_turns',
  'agent_action_outcomes',

  // Gamification/user reward state
  'coin_ledger',
  'user_badges',
  'badges',
  'rewards_store',
];

const PRESERVED = [
  '_migrations',
  'settings credentials/config',
  'privacy_blocked_domains',
  'context_sensitive_domains',
];

const TRANSIENT_SETTING_KEYS = [
  'continuity_msg_count',
  'continuity_msg_date',
  'last_uil_insight_sent_at',
  'pending_checkin_type',
  'pending_checkin_date',
  'standup_goal_today',
  'standup_mood_today',
];

function createBackupPath() {
  const backupDir = path.join(process.cwd(), 'data', 'reset-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(backupDir, `lifeos-before-full-reset-${stamp}.db`);
}

function isMissingTableError(error: unknown) {
  return error instanceof Error && /no such table/i.test(error.message);
}

export async function GET() {
  const db = getDb();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const t of CLEAR_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
      counts[t] = row.c;
      total += row.c;
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error;
      }
      counts[t] = 0;
    }
  }
  const settingsRows = db.prepare(
    `SELECT COUNT(*) as c FROM settings WHERE key IN (${TRANSIENT_SETTING_KEYS.map(() => '?').join(',')})`
  ).get(...TRANSIENT_SETTING_KEYS) as { c: number };

  return NextResponse.json({
    message: 'Preview — POST with { "confirm": "FULL_RESET" } to execute.',
    totalRowsToDelete: total,
    breakdown: counts,
    transientSettingsToDelete: settingsRows.c,
    preserved: PRESERVED,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== 'FULL_RESET') {
      return NextResponse.json(
        { error: 'Pass { "confirm": "FULL_RESET" } to execute. Use GET to preview first.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const deleted: Record<string, number> = {};
    const backupPath = createBackupPath();
    await db.backup(backupPath);

    db.transaction(() => {
      for (const t of CLEAR_TABLES) {
        try {
          const before = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
          db.prepare(`DELETE FROM ${t}`).run();
          deleted[t] = before;
          try { db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t); } catch {}
        } catch (error) {
          if (!isMissingTableError(error)) {
            throw new Error(`Failed to clear ${t}: ${error instanceof Error ? error.message : String(error)}`);
          }
          deleted[t] = 0;
        }
      }
      try {
        const placeholders = TRANSIENT_SETTING_KEYS.map(() => '?').join(',');
        const result = db.prepare(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...TRANSIENT_SETTING_KEYS);
        deleted.settings_transient_keys = result.changes;
      } catch {
        deleted.settings_transient_keys = 0;
      }
    })();

    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`[full-reset] Cleared ${total} rows across ${CLEAR_TABLES.length} tables`);

    return NextResponse.json({
      success: true,
      totalDeleted: total,
      breakdown: deleted,
      preserved: PRESERVED,
      backupPath,
      message: `Reset complete. ${total} rows cleared. Credential/auth settings were preserved.`,
    });
  } catch (err) {
    console.error('[full-reset] Failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
