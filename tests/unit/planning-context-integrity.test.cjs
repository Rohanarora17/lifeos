'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('planning context integrity', () => {
  let db;
  let planner;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-planning-integrity-');
    db = env.db;
    planner = env.requireLib('next-day-planner.ts');
  });

  it('installs date-bound context, constraints, and invalidation provenance', () => {
    const checkinColumns = db.prepare('PRAGMA table_info(daily_checkins)').all().map(row => row.name);
    const sessionColumns = db.prepare('PRAGMA table_info(planned_focus_sessions)').all().map(row => row.name);
    const constraintTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_constraints'").get();

    assert.ok(checkinColumns.includes('applies_to_plan_date'));
    assert.ok(sessionColumns.includes('origin'));
    assert.ok(sessionColumns.includes('invalidated_reason'));
    assert.ok(sessionColumns.includes('invalidated_at'));
    assert.deepEqual(constraintTable, { name: 'plan_constraints' });
  });

  it('does not carry an older intention into another plan date', async () => {
    db.prepare(`
      INSERT INTO daily_checkins (
        checkin_date, checkin_type, tomorrow_intention, mood, energy,
        applies_to_plan_date, raw_transcript, received_at
      ) VALUES (
        '2030-02-01', 'evening', 'I have a meeting at 6 pm today', 'low', 'low',
        '2030-02-02', 'Planning date: 2030-02-02', '2030-02-01 22:00:00'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, energy_required, estimated_minutes, due_date)
      VALUES ('Learn probability', 'todo', 'high', 'study', 'medium', 20, '2030-02-03')
    `).run();

    const payload = await planner.generateNextDayPlan({
      planDate: '2030-02-03',
      syncCalendar: false,
      regenerate: true,
    });

    assert.equal(payload.plan.tomorrow_intention, null);
    assert.equal(payload.plan.source_checkin_id, null);
    assert.equal(payload.contextProvenance.source, 'live_truth');
    assert.equal(payload.contextProvenance.appliesToPlanDate, '2030-02-03');
    assert.equal(payload.sessions.some(session => /meeting/i.test(session.title)), false);
  });

  it('extracts a typed meeting constraint without inventing a team', () => {
    assert.equal(typeof planner.extractTypedPlanConstraints, 'function');
    const constraints = planner.extractTypedPlanConstraints({
      planDate: '2030-02-03',
      text: 'I have meeting at 6 pm to 6:30 today. Learn probability around 11:30.',
    });

    assert.equal(constraints.length, 1);
    assert.equal(constraints[0].title, 'Meeting');
    assert.equal(constraints[0].sourceText, 'I have meeting at 6 pm to 6:30 today.');
    assert.equal(constraints[0].startIso, '2030-02-03T18:00:00.000+05:30');
    assert.equal(constraints[0].endIso, '2030-02-03T18:30:00.000+05:30');
  });
});
