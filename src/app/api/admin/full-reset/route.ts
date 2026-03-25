import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * POST /api/admin/full-reset
 * Clears all tasks + all tracking/session/behavioral data in one shot.
 * Preserves: goals, habits (definitions), settings, knowledge graph, policy artifacts.
 *
 * Body: { "confirm": "FULL_RESET" }
 * GET:  preview row counts, nothing deleted.
 */

const CLEAR_TABLES = [
  // Tasks
  'tasks',
  'node_task_links',
  // Session completions + feedback
  'session_completions',
  'session_feedback',
  'calibration_history',
  'energy_readings',
  'goal_time_logs',
  'weekly_plans',
  // Guardian session data
  'guardian_session_summaries',
  'guardian_session_reflections',
  'guardian_override_requests',
  'guardian_overrides',
  'guardian_event_log',
  'guardian_interventions',
  'guardian_canary_results',
  'guardian_eval_runs',
  'guardian_semantic_profiles',
  'session_ticks',
  'soft_watch_commitments',
  // Screen time + activity
  'activities',
  'domain_categories',
  'daily_scores',
  'focus_sessions',
  'nudge_log',
  'tab_switches',
  'screen_time',
  // Behavioral memory
  'behavioral_memory',
  'behavior_snapshots',
  'behavior_insights',
  'behavior_profile',
  // AI / intelligence
  'ai_insights',
  'user_intelligence_profile',
  'mem_facts',
  'mem_episodes',
  'mem_working',
  'mem_procedures',
  'jarvis_explanations',
  'voice_turns',
  // Alerts + gamification state
  'alerts',
  'coin_ledger',
  'user_badges',
  // Habit check-in history (not definitions)
  'habit_checkins',
];

const PRESERVED = [
  'settings', 'goals', 'habits', 'knowledge_nodes', 'knowledge_edges',
  'intentions', 'calendar_events', 'github_activity',
  'rewards_store', 'badges',
  'guardian_artifact_versions', 'guardian_eval_cases', 'guardian_promotions',
];

export async function GET() {
  const db = getDb();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const t of CLEAR_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
      counts[t] = row.c;
      total += row.c;
    } catch {
      counts[t] = 0;
    }
  }
  return NextResponse.json({
    message: 'Preview — POST with { "confirm": "FULL_RESET" } to execute.',
    totalRowsToDelete: total,
    breakdown: counts,
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

    db.transaction(() => {
      for (const t of CLEAR_TABLES) {
        try {
          const before = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
          db.prepare(`DELETE FROM ${t}`).run();
          deleted[t] = before;
          // Reset autoincrement for tasks
          if (t === 'tasks') {
            try { db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'tasks'`).run(); } catch {}
          }
        } catch {
          deleted[t] = 0;
        }
      }
    })();

    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`[full-reset] Cleared ${total} rows across ${CLEAR_TABLES.length} tables`);

    return NextResponse.json({
      success: true,
      totalDeleted: total,
      breakdown: deleted,
      preserved: PRESERVED,
      message: `Reset complete. ${total} rows cleared. Goals, habits, settings, and knowledge graph preserved.`,
    });
  } catch (err) {
    console.error('[full-reset] Failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
