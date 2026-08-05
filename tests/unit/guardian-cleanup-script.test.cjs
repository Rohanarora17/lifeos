'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Guardian contamination cleanup', () => {
  it('previews safely, deletes only the targeted evidence, and preserves credentials', () => {
    const env = createIsolatedDb('lifeos-guardian-cleanup-');
    const sessionId = 'session_f08ivyfk';
    const startedAt = Date.now() - 60 * 60_000;
    const startedIso = new Date(startedAt).toISOString();
    env.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('lifeos_api_token', 'keep-me')`).run();
    env.db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes, state)
      VALUES (?, 'Contaminated session', ?, 30, 'COMPLETE')
    `).run(sessionId, startedAt);
    env.db.prepare(`
      INSERT INTO guardian_session_reflections (session_id, reflection_text)
      VALUES (?, 'Invalid reflection')
    `).run(sessionId);
    env.db.prepare(`
      INSERT INTO activities (
        url, domain, title, category, started_at, ended_at, duration_seconds,
        device_name, guardian_session_id, counted, capture_source, selection_reason
      ) VALUES ('http://lifeos.local', 'lifeos.local', 'LifeOS Guardian', 'neutral', ?, ?, 300,
                'LifeOS Guardian', ?, 0, 'chrome', 'contaminated')
    `).run(startedIso, new Date(startedAt + 300_000).toISOString(), sessionId);
    env.db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, intended_start_at, planned_minutes, source, status, created_at
      ) VALUES ('expired-test', 'Expired plan', ?, 30, 'next_day_plan', 'pending', ?)
    `).run(Date.now() - 60_000, Date.now() - 120_000);
    env.db.close();

    const script = path.join(env.root, 'scripts/cleanup-guardian-capture-contamination.cjs');
    const commandEnv = { ...process.env, LIFEOS_DB_PATH: env.dbPath };
    const preview = JSON.parse(execFileSync(process.execPath, [script], {
      cwd: env.root,
      env: commandEnv,
      encoding: 'utf8',
    }));
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.sessionRows.guardian_sessions, 1);
    assert.equal(preview.rawActivities, 1);

    const executed = JSON.parse(execFileSync(process.execPath, [script, '--execute'], {
      cwd: env.root,
      env: commandEnv,
      encoding: 'utf8',
    }));
    assert.equal(executed.deleted.guardian_sessions, 1);
    assert.equal(executed.deleted.activities, 1);
    assert.equal(executed.deleted.soft_watch_commitments, 1);
    assert.deepEqual(executed.foreignKeys, []);
    assert.deepEqual(executed.integrity, [{ integrity_check: 'ok' }]);

    const db = new Database(env.dbPath, { readonly: true });
    assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'lifeos_api_token'`).pluck().get(), 'keep-me');
    assert.equal(db.prepare('SELECT COUNT(*) FROM guardian_sessions WHERE session_id = ?').pluck().get(sessionId), 0);
    db.close();
  });
});
