'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('planning state reconciliation', () => {
  let db;
  let reconcilePlanningState;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-planning-reconcile-');
    db = env.db;
    ({ reconcilePlanningState } = env.requireLib('planning-reconciliation.ts'));
  });

  function insertPlan({ date, sourceCheckinId = null, generationSource = 'live_truth' }) {
    return Number(db.prepare(`
      INSERT INTO daily_plans (plan_date, source_checkin_id, generation_source, status)
      VALUES (?, ?, ?, 'active')
    `).run(date, sourceCheckinId, generationSource).lastInsertRowid);
  }

  function insertTask(title = 'Real work') {
    return Number(db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, energy_required, estimated_minutes)
      VALUES (?, 'todo', 'high', 'study', 'medium', 30)
    `).run(title).lastInsertRowid);
  }

  function insertSession({ id, planId, taskId = null, title, start, end, status = 'planned', watchId = null }) {
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
        session_type, rule_json, reward_xp, reward_coins, calendar_status,
        soft_watch_id, status, origin
      ) VALUES (?, ?, ?, ?, ?, ?, 30, 'study', '{}', 10, 2, 'not_configured', ?, ?, 'legacy')
    `).run(id, planId, taskId, title, start, end, watchId, status);
  }

  it('cancels the stale Team meeting chain and is idempotent', async () => {
    const checkinId = Number(db.prepare(`
      INSERT INTO daily_checkins (
        checkin_date, checkin_type, tomorrow_intention, applies_to_plan_date, raw_transcript
      ) VALUES ('2030-02-01', 'evening', 'meeting at 6 pm', '2030-02-02', 'Planning date: 2030-02-02')
    `).run().lastInsertRowid);
    const planId = insertPlan({ date: '2030-02-03', sourceCheckinId: checkinId, generationSource: 'exact_date_checkin' });
    insertSession({
      id: 'team-meeting', planId, title: 'Team meeting',
      start: '2030-02-03T18:00:00.000+05:30', end: '2030-02-03T18:30:00.000+05:30',
      watchId: 'watch-team-meeting',
    });
    db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, intended_start_at, planned_minutes, source, status, created_at
      ) VALUES ('watch-team-meeting', 'Team meeting', 1896352200000, 30, 'next_day_plan', 'pending', 1)
    `).run();
    db.prepare(`
      INSERT INTO coaching_commitments (
        commitment_key, source_type, source_id, title, planned_start_at,
        planned_minutes, state, created_at, updated_at
      ) VALUES (
        'planned:team-meeting', 'planned_focus', 'team-meeting', 'Team meeting',
        '2030-02-03T18:00:00.000+05:30', 30, 'scheduled', '2030-02-01', '2030-02-01'
      )
    `).run();

    const first = await reconcilePlanningState('2030-02-03', new Date('2030-02-03T10:00:00.000+05:30'), { regenerate: false });
    const second = await reconcilePlanningState('2030-02-03', new Date('2030-02-03T10:00:00.000+05:30'), { regenerate: false });

    const session = db.prepare(`SELECT status, invalidated_reason, invalidated_at FROM planned_focus_sessions WHERE id='team-meeting'`).get();
    assert.equal(session.status, 'cancelled');
    assert.equal(session.invalidated_reason, 'stale_source_date');
    assert.ok(session.invalidated_at);
    assert.equal(db.prepare(`SELECT status FROM soft_watch_commitments WHERE id='watch-team-meeting'`).get().status, 'dismissed');
    assert.equal(db.prepare(`SELECT state FROM coaching_commitments WHERE source_id='team-meeting'`).get().state, 'cancelled');
    assert.deepEqual(first.reasonCodes, ['stale_source_date']);
    assert.equal(first.repairedSessionIds.length, 1);
    assert.equal(second.repairedSessionIds.length, 0);
  });

  it('skips elapsed valid work but never rewrites started or completed evidence', async () => {
    const taskId = insertTask();
    const planId = insertPlan({ date: '2030-02-03' });
    insertSession({ id: 'elapsed', planId, taskId, title: 'Elapsed work', start: '2030-02-03T09:00:00.000+05:30', end: '2030-02-03T09:30:00.000+05:30' });
    insertSession({ id: 'started', planId, taskId, title: 'Started work', start: '2030-02-03T09:00:00.000+05:30', end: '2030-02-03T09:30:00.000+05:30', status: 'started' });
    insertSession({ id: 'completed', planId, taskId, title: 'Completed work', start: '2030-02-03T08:00:00.000+05:30', end: '2030-02-03T08:30:00.000+05:30', status: 'completed' });

    const result = await reconcilePlanningState('2030-02-03', new Date('2030-02-03T10:00:00.000+05:30'), { regenerate: false });
    const rows = db.prepare(`SELECT id, status, invalidated_reason FROM planned_focus_sessions ORDER BY id`).all();

    assert.deepEqual(rows, [
      { id: 'completed', status: 'completed', invalidated_reason: null },
      { id: 'elapsed', status: 'skipped', invalidated_reason: 'expired_unstarted' },
      { id: 'started', status: 'started', invalidated_reason: null },
    ]);
    assert.deepEqual(result.reasonCodes, ['expired_unstarted']);
  });
});
