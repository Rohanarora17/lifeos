'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Today Mode planned-focus freshness', () => {
  it('returns only a future task-linked focus block with exact identity', () => {
    const env = createIsolatedDb('lifeos-today-focus-');
    const db = env.db;
    const { buildPersonalizationSnapshot } = env.requireLib('personalization-context.ts');
    const date = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    const planId = Number(db.prepare(`INSERT INTO daily_plans (plan_date, generation_source) VALUES (?, 'live_truth')`).run(date).lastInsertRowid);
    const taskId = Number(db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, energy_required, estimated_minutes)
      VALUES ('Canonical probability task', 'todo', 'high', 'study', 'medium', 30)
    `).run().lastInsertRowid);
    const futureStart = new Date(Date.now() + 3_600_000).toISOString();
    const futureEnd = new Date(Date.now() + 5_400_000).toISOString();
    const pastStart = new Date(Date.now() - 7_200_000).toISOString();
    const pastEnd = new Date(Date.now() - 5_400_000).toISOString();
    const insert = db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
        session_type, rule_json, reward_xp, reward_coins, calendar_status, status, origin,
        invalidated_reason
      ) VALUES (?, ?, ?, ?, ?, ?, 30, 'study', '{}', 0, 0, 'not_configured', 'planned', ?, ?)
    `);
    insert.run('missing-task', planId, null, 'Team meeting', futureStart, futureEnd, 'legacy', null);
    insert.run('expired', planId, taskId, 'Old title', pastStart, pastEnd, 'deterministic_task', null);
    insert.run('invalidated', planId, taskId, 'Invalid title', futureStart, futureEnd, 'deterministic_task', 'constraint_misclassified');
    insert.run('valid-session', planId, taskId, 'Stale copied title', futureStart, futureEnd, 'deterministic_task', null);

    const snapshot = buildPersonalizationSnapshot({ surface: 'dashboard' });
    assert.equal(snapshot.today.plannedFocus.nextTitle, 'Canonical probability task');
    assert.equal(snapshot.today.plannedFocus.nextSessionId, 'valid-session');
    assert.equal(snapshot.today.plannedFocus.nextTaskId, taskId);
    assert.equal(snapshot.today.plannedFocus.nextStart, futureStart);
  });
});
