import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// Tables to clear — tracking, behavioral, session data only.
// Settings, tasks, goals, habits (definitions), knowledge graph, and policy
// artifacts are intentionally preserved.
const TABLES_TO_CLEAR = [
  'coaching_decisions',
  'coaching_events',
  'coaching_episodes',
  // Screen time + activity tracking
  'activities',
  'domain_categories',
  'daily_scores',
  'nudge_log',
  'tab_switches',
  'screen_time',
  'session_activity_intervals',
  'guardian_shadow_reports',
  'guardian_score_snapshots',
  'guardian_activity_slices',
  'guardian_evidence_events',
  'guardian_presence_checks',
  'browser_collector_status',
  'native_client_status',
  // Behavioral memory
  'behavioral_memory',
  'behavior_snapshots',
  'behavior_insights',
  'behavior_profile',
  // Guardian session data
  'guardian_session_summaries',
  'guardian_session_reflections',
  'guardian_override_requests',
  'guardian_canary_results',
  'guardian_eval_runs',
  'guardian_semantic_profiles',
  'session_ticks',
  'soft_watch_commitments',
  // Guardian new tables (phases 1–10)
  'guardian_event_log',
  'guardian_interventions',
  'guardian_overrides',
  'session_completions',
  'session_feedback',
  'calibration_history',
  'energy_readings',
  'goal_time_logs',
  'weekly_plans',
  // AI / intelligence layers
  'ai_insights',
  'user_intelligence_profile',
  'mem_facts',
  'mem_episodes',
  'mem_working',
  'mem_procedures',
  'jarvis_explanations',
  'voice_turns',
  // Alerts + gamification state (not definitions)
  'alerts',
  'coin_ledger',
  'user_badges',
  // Habit check-in history (not habit definitions)
  'habit_checkins',
];

// GET — preview row counts before deletion
export async function GET() {
  try {
    const db = getDb();
    const counts: Record<string, number> = {};

    for (const table of TABLES_TO_CLEAR) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
        counts[table] = row.c;
      } catch {
        counts[table] = -1; // table doesn't exist
      }
    }

    const totalRows = Object.values(counts).filter(v => v > 0).reduce((a, b) => a + b, 0);

    return NextResponse.json({
      message: 'Preview — no data deleted yet. POST with confirm=RESET_TRACKING to execute.',
      totalRowsToDelete: totalRows,
      breakdown: counts,
      preserved: [
        'settings', 'tasks', 'goals', 'habits',
        'knowledge_nodes', 'knowledge_edges', 'node_task_links',
        'intentions', 'calendar_events', 'github_activity',
        'rewards_store', 'badges',
        'guardian_artifact_versions', 'guardian_eval_cases', 'guardian_promotions',
      ],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST — execute reset (requires confirm token)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (body.confirm !== 'RESET_TRACKING') {
      return NextResponse.json(
        { error: 'Pass { "confirm": "RESET_TRACKING" } to execute. Use GET to preview counts first.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const results: Record<string, number> = {};

    db.transaction(() => {
      for (const table of TABLES_TO_CLEAR) {
        try {
          const before = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
          db.prepare(`DELETE FROM ${table}`).run();
          results[table] = before;
        } catch {
          results[table] = -1; // table doesn't exist, skip
        }
      }
    })();

    const totalDeleted = Object.values(results).filter(v => v > 0).reduce((a, b) => a + b, 0);

    console.log(`[reset-tracking] Cleared ${totalDeleted} rows across ${TABLES_TO_CLEAR.length} tables`);

    return NextResponse.json({
      success: true,
      totalDeleted,
      breakdown: results,
      message: 'Tracking, behavioral, and session data cleared. Settings, tasks, goals, habits, and knowledge graph preserved.',
    });
  } catch (error) {
    console.error('[reset-tracking] Failed:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
