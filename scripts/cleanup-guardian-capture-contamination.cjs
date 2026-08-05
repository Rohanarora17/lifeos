#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');
const rebuildDerived = args.has('--rebuild-derived');
const sessionArg = process.argv.slice(2).find(arg => arg.startsWith('--session='));
const sessionId = sessionArg?.slice('--session='.length) || 'session_f08ivyfk';
const dbPath = path.resolve(process.env.LIFEOS_DB_PATH || path.join(process.cwd(), 'data', 'lifeos.db'));

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function hasColumn(db, table, column) {
  return tableExists(db, table) && db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function countBySession(db, table) {
  if (!hasColumn(db, table, 'session_id')) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId).count);
}

async function main() {
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const sessionTables = [
    'task_session_logs', 'session_completions', 'session_feedback', 'goal_time_logs',
    'screen_observations', 'session_domain_classifications', 'native_guidance_feedback',
    'guardian_session_reflections', 'guardian_session_summaries', 'guardian_override_requests',
    'guardian_overrides', 'guardian_event_log', 'guardian_interventions', 'guardian_sessions',
    'session_ticks', 'override_follow_ups', 'energy_readings', 'jarvis_explanations',
    'session_activity_intervals',
    'guardian_presence_checks',
  ];
  const session = tableExists(db, 'guardian_sessions')
    ? db.prepare('SELECT started_at, duration_minutes FROM guardian_sessions WHERE session_id = ?').get(sessionId)
    : null;
  const startIso = session?.started_at ? new Date(session.started_at).toISOString() : null;
  const endIso = session?.started_at
    ? new Date(session.started_at + Math.max(1, Number(session.duration_minutes || 60)) * 60_000 + 10 * 60_000).toISOString()
    : null;

  const preview = Object.fromEntries(sessionTables.map(table => [table, countBySession(db, table)]));
  let rawActivities = 0;
  if (tableExists(db, 'activities')) {
    if (hasColumn(db, 'activities', 'guardian_session_id')) {
      rawActivities += Number(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE guardian_session_id = ?').get(sessionId).count);
    }
    if (startIso && endIso) {
      rawActivities += Number(db.prepare(`
        SELECT COUNT(*) AS count FROM activities
        WHERE device_name IN ('LifeOS Guardian','LifeOS Native Copilot')
          AND started_at BETWEEN ? AND ?
          AND COALESCE(guardian_session_id, '') <> ?
      `).get(startIso, endIso, sessionId).count);
    }
  }

  const expiredCommitments = tableExists(db, 'soft_watch_commitments')
    ? Number(db.prepare(`SELECT COUNT(*) AS count FROM soft_watch_commitments WHERE status = 'pending' AND intended_start_at < ?`).get(Date.now()).count)
    : 0;

  const report = {
    mode: execute ? 'execute' : 'preview',
    database: dbPath,
    sessionId,
    sessionRows: preview,
    rawActivities,
    expiredCommitments,
    rebuildDerived,
    preserved: ['settings', 'authentication tokens', 'device credentials', 'calendar credentials'],
  };

  if (!execute) {
    console.log(JSON.stringify(report, null, 2));
    db.close();
    return;
  }

  const backupDir = path.join(path.dirname(dbPath), 'reset-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `lifeos-before-guardian-cleanup-${stamp}.db`);
  await db.backup(backupPath);

  const deleted = {};
  db.transaction(() => {
    // Child rows first; guardian_sessions is deliberately last.
    for (const table of sessionTables.filter(table => table !== 'guardian_sessions')) {
      if (!hasColumn(db, table, 'session_id')) continue;
      deleted[table] = db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId).changes;
    }
    if (tableExists(db, 'activities')) {
      let changes = 0;
      if (hasColumn(db, 'activities', 'guardian_session_id')) {
        changes += db.prepare('DELETE FROM activities WHERE guardian_session_id = ?').run(sessionId).changes;
      }
      if (startIso && endIso) {
        changes += db.prepare(`
          DELETE FROM activities
          WHERE device_name IN ('LifeOS Guardian','LifeOS Native Copilot')
            AND started_at BETWEEN ? AND ?
            AND COALESCE(guardian_session_id, '') <> ?
        `).run(startIso, endIso, sessionId).changes;
      }
      deleted.activities = changes;
    }
    if (tableExists(db, 'soft_watch_commitments')) {
      deleted.soft_watch_commitments = db.prepare(`
        DELETE FROM soft_watch_commitments
        WHERE status = 'pending' AND intended_start_at < ?
      `).run(Date.now()).changes;
    }
    if (tableExists(db, 'guardian_sessions')) {
      deleted.guardian_sessions = db.prepare('DELETE FROM guardian_sessions WHERE session_id = ?').run(sessionId).changes;
    }

    if (rebuildDerived) {
      for (const table of [
        'user_intelligence_profile', 'behavior_snapshots', 'behavior_insights',
        'behavior_profile', 'ai_insights', 'guardian_semantic_profiles',
      ]) {
        if (!tableExists(db, table)) continue;
        deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
      }
      if (tableExists(db, 'mem_episodes')) {
        deleted.mem_episodes = db.prepare(`
          DELETE FROM mem_episodes WHERE raw_context LIKE ? OR summary LIKE ?
        `).run(`%${sessionId}%`, `%${sessionId}%`).changes;
      }
      if (tableExists(db, 'mem_facts')) {
        deleted.mem_facts = db.prepare(`
          DELETE FROM mem_facts WHERE content LIKE ? OR source_episode_ids LIKE ?
        `).run(`%${sessionId}%`, `%${sessionId}%`).changes;
      }
    }
  })();

  db.close();

  const rebuilt = {};
  if (rebuildDerived) {
    // These modules now read effective_activities, whose Guardian contribution
    // comes only from canonical counted intervals. Rebuilding after the cleanup
    // therefore cannot reintroduce suppressed Chrome/native evidence.
    const { registerTypescript } = require('./lib/register-ts.cjs');
    registerTypescript(process.cwd());
    process.env.LIFEOS_DB_PATH = dbPath;
    const { updateGuardianSemanticProfile } = require('../src/lib/longitudinal-engine.ts');
    const { runDeepAnalysis } = require('../src/lib/behavior.ts');
    const { forceSynthesis } = require('../src/lib/intelligence.ts');

    updateGuardianSemanticProfile('default');
    rebuilt.guardianSemanticProfile = true;
    await runDeepAnalysis();
    rebuilt.behavioralAnalysis = true;
    await forceSynthesis('guardian_capture_cleanup');
    rebuilt.userIntelligenceProfile = true;
  }

  const validationDb = new Database(dbPath, { readonly: true });
  validationDb.pragma('foreign_keys = ON');
  const foreignKeys = validationDb.pragma('foreign_key_check');
  const integrity = validationDb.pragma('integrity_check');
  validationDb.close();

  console.log(JSON.stringify({ ...report, backupPath, deleted, rebuilt, foreignKeys, integrity }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
