import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import fs from 'fs';
import path from 'path';

/**
 * POST /api/admin/full-reset
 * Clears product/user history in one shot while preserving credential/auth
 * and domain-policy configuration.
 *
 * Auth (enforced by src/proxy.ts for all /api/* in production):
 *   Authorization: Bearer $LIFEOS_API_TOKEN
 *   X-LifeOS-Reauth-Token: $LIFEOS_ADMIN_REAUTH_TOKEN   # or LIFEOS_API_TOKEN if admin token unset
 *     (required for POST/PUT/PATCH/DELETE under /api/admin/*)
 *
 * Body: { "confirm": "FULL_RESET" }
 * GET:  preview row counts, nothing deleted.
 *
 * After wipe:
 *  - history_start_date is pinned to today (IST)
 *  - mem_facts FTS is rebuilt empty
 *  - default badges + rewards catalog are reseeded
 *
 * Example (on Mac Mini, after deploy):
 *   # Preview
 *   curl -s http://localhost:3000/api/admin/full-reset \
 *     -H "Authorization: Bearer $LIFEOS_API_TOKEN"
 *
 *   # Execute
 *   curl -s -X POST http://localhost:3000/api/admin/full-reset \
 *     -H "Authorization: Bearer $LIFEOS_API_TOKEN" \
 *     -H "X-LifeOS-Reauth-Token: ${LIFEOS_ADMIN_REAUTH_TOKEN:-$LIFEOS_API_TOKEN}" \
 *     -H "Content-Type: application/json" \
 *     -d '{"confirm":"FULL_RESET"}'
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
  'session_activity_intervals',
  'guardian_shadow_reports',
  'guardian_score_snapshots',
  'guardian_activity_slices',
  'guardian_evidence_events',
  'guardian_presence_checks',
  'browser_collector_status',
  'native_client_status',
  'session_domain_classifications',

  // Guardian sessions, feedback, overrides, evaluations, and learned policies
  'native_guidance_feedback',
  'alerts',
  'guardian_session_reflections',
  'guardian_session_summaries',
  'guardian_override_requests',
  'guardian_overrides', // may not exist on all installs
  'guardian_event_log',
  'guardian_interventions',
  'guardian_canary_results',
  'guardian_eval_runs',
  'guardian_promotions',
  'guardian_artifact_versions',
  'guardian_eval_cases',
  'guardian_semantic_profiles',
  'guardian_sessions',
  'guardian_voice_daily_usage',
  'guardian_voice_leases',
  'session_ticks',
  'override_follow_ups',
  'calibration_history',
  'energy_readings',
  'weekly_plans',
  'weekly_reckonings',
  'daily_checkins',
  'focus_sessions', // legacy table (migration 003); no-op if absent

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

  // Gamification/user reward state (+ catalog; reseeded after wipe)
  'coin_ledger',
  'user_badges',
  'badges',
  'rewards_store',
];

/** Runtime / history keys wiped; credentials and schedule config stay. */
const TRANSIENT_SETTING_KEYS = [
  // Continuity + UIL pacing
  'continuity_msg_count',
  'continuity_msg_date',
  'last_uil_insight_sent_at',
  'last_classify_review_session_id',
  'streak_cliff_sent_date',

  // Check-in pending state
  'pending_checkin_type',
  'pending_checkin_date',
  'pending_checkin_sent_at',

  // Standup / day anchors
  'standup_goal_today',
  'standup_mood_today',
  'standup_goal_date',

  // Telegram intercept state
  'telegram_awaiting_feedback_session',
  'pending_session_context',
  'pending_weekly_reckoning',
  'pending_weekly_reckoning_date',

  // Scheduler "already sent today" dedupe
  'scheduler_evening_reminder_last_sent_date',
  'scheduler_next_day_plan_refresh_last_sent_date',

  // Learned cognitive / experiment history (not credentials)
  'cognitive_trait_history_v1',
  'cognitive_trait_stances',
  'cognitive_experiments_v1',

  // Native app classification ask state
  'pending_native_category_ask',

  // Epoch is rewritten to today after wipe (delete first so we always re-pin)
  'history_start_date',
];

const PRESERVED = [
  '_migrations',
  'settings credentials/config (tokens, times, domain lists, calendar, XP knobs)',
  'privacy_blocked_domains',
  'context_sensitive_domains',
];

const IST_OFFSET_MS = 19_800_000;

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function createBackupPath() {
  const backupDir = path.join(process.cwd(), 'data', 'reset-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(backupDir, `lifeos-before-full-reset-${stamp}.db`);
}

function isMissingTableError(error: unknown) {
  return error instanceof Error && /no such table/i.test(error.message);
}

function rebuildMemFactsFts(db: ReturnType<typeof getDb>): string {
  try {
    // Content-sync FTS: rebuild from (now empty) mem_facts
    db.exec(`INSERT INTO mem_facts_fts(mem_facts_fts) VALUES('rebuild')`);
    return 'rebuilt';
  } catch (error) {
    if (isMissingTableError(error)) return 'absent';
    // Fallback: try delete-all if rebuild unsupported
    try {
      db.prepare('DELETE FROM mem_facts_fts').run();
      return 'deleted';
    } catch (inner) {
      return `skipped: ${inner instanceof Error ? inner.message : String(inner)}`;
    }
  }
}

function reseedGamificationCatalog(db: ReturnType<typeof getDb>): { badges: number; rewards: number } {
  // Same seeds as migrations/008_gamification.sql
  const badgeResult = db.prepare(`
    INSERT OR IGNORE INTO badges (id, name, description, icon, metric, target) VALUES
      (1, 'First Steps', 'Complete your first task', '👶', 'tasks_done', 1),
      (2, 'Task Warrior', 'Complete 50 tasks', '⚔️', 'tasks_done', 50),
      (3, 'Executioner', 'Complete 500 tasks', '🥷', 'tasks_done', 500),
      (4, 'Getting Consistent', 'Reach a 7-day habit streak', '🔥', 'streak_days', 7),
      (5, 'Unbreakable', 'Reach a 30-day habit streak', '💎', 'streak_days', 30),
      (6, 'Deep Worker', 'Complete 10 Pomodoro sessions', '🧠', 'focus_sessions', 10),
      (7, 'Monk Mode', 'Complete 100 Pomodoro sessions', '🧘', 'focus_sessions', 100)
  `).run();

  const rewardResult = db.prepare(`
    INSERT OR IGNORE INTO rewards_store (id, title, cost, icon) VALUES
      (1, '1 Hour Guilt-Free Gaming', 1000, '🎮'),
      (2, 'Watch a Movie', 1500, '🍿'),
      (3, 'Buy a Coffee out', 500, '☕'),
      (4, 'Skip a Chore', 2000, '🧹')
  `).run();

  return {
    badges: badgeResult.changes,
    rewards: rewardResult.changes,
  };
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
    message: 'Preview — POST with { "confirm": "FULL_RESET" } to execute. Requires Authorization Bearer + X-LifeOS-Reauth-Token on POST.',
    auth: {
      get: 'Authorization: Bearer $LIFEOS_API_TOKEN',
      post: 'Authorization: Bearer $LIFEOS_API_TOKEN and X-LifeOS-Reauth-Token: $LIFEOS_ADMIN_REAUTH_TOKEN (or LIFEOS_API_TOKEN)',
    },
    totalRowsToDelete: total,
    breakdown: counts,
    transientSettingsToDelete: settingsRows.c,
    transientSettingKeys: TRANSIENT_SETTING_KEYS,
    postReset: {
      history_start_date: todayIst(),
      reseed_badges_rewards: true,
      rebuild_mem_facts_fts: true,
    },
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
    const deleted: Record<string, number | string> = {};
    const backupPath = createBackupPath();
    await db.backup(backupPath);

    const epoch = todayIst();

    db.transaction(() => {
      for (const t of CLEAR_TABLES) {
        try {
          const before = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
          db.prepare(`DELETE FROM ${t}`).run();
          deleted[t] = before;
          try {
            db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
          } catch { /* no autoincrement */ }
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

      // Fresh coaching history starts today (IST)
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('history_start_date', ?)`).run(epoch);
      deleted.history_start_date_set = epoch;

      deleted.mem_facts_fts = rebuildMemFactsFts(db);

      try {
        const seeded = reseedGamificationCatalog(db);
        deleted.badges_reseeded = seeded.badges;
        deleted.rewards_reseeded = seeded.rewards;
      } catch (error) {
        deleted.gamification_reseed = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();

    const total = Object.values(deleted).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);
    console.log(`[full-reset] Cleared ${total} rows across ${CLEAR_TABLES.length} tables; history_start_date=${epoch}`);

    return NextResponse.json({
      success: true,
      totalDeleted: total,
      breakdown: deleted,
      preserved: PRESERVED,
      history_start_date: epoch,
      backupPath,
      message: `Reset complete. ${total} history rows cleared. Config settings preserved. History epoch set to ${epoch}.`,
    });
  } catch (err) {
    console.error('[full-reset] Failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
