'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('planning read purity', () => {
  it('does not expire a pending soft watch while building a day briefing', () => {
    const env = createIsolatedDb('lifeos-planning-read-purity-');
    const now = Date.now();
    env.db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, intended_start_at, planned_minutes, source, status, created_at
      ) VALUES ('watch-starting-now', 'Start exact planned work', ?, 30, 'calendar', 'pending', ?)
    `).run(now - 60_000, now - 120_000);
    const taskId = Number(env.db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, estimated_minutes)
      VALUES ('Start exact planned work', 'todo', 'high', 'study', 30)
    `).run().lastInsertRowid);
    const planId = Number(env.db.prepare(`
      INSERT INTO daily_plans (plan_date, generation_source, status)
      VALUES ('2030-02-03', 'live_truth', 'active')
    `).run().lastInsertRowid);
    env.db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
        session_type, rule_json, reward_xp, reward_coins, soft_watch_id, status, origin
      ) VALUES (
        'exact-plan', ?, ?, 'Start exact planned work', ?, ?, 30,
        'study', '{}', 10, 2, 'watch-starting-now', 'planned', 'deterministic_task'
      )
    `).run(planId, taskId, new Date(now - 60_000).toISOString(), new Date(now + 29 * 60_000).toISOString());

    const { getUpcomingCommitments } = env.requireLib('longitudinal-engine.ts');
    assert.deepEqual(getUpcomingCommitments(), []);
    assert.equal(
      env.db.prepare(`SELECT status FROM soft_watch_commitments WHERE id='watch-starting-now'`).pluck().get(),
      'pending',
    );
  });
});
