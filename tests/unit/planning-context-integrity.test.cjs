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

  it('atomically rejects hallucinated or unlinked AI focus output', () => {
    const base = {
      windowStart: new Date('2030-02-03T08:00:00.000+05:30'),
      windowEnd: new Date('2030-02-03T23:00:00.000+05:30'),
      notBefore: null,
      calendarEvents: [],
      candidateTaskIds: [42],
      freshText: 'I have a meeting at 6 pm to 6:30. Learn probability around 11:30.',
    };
    const result = planner.validatePlannerSynthesis({
      ...base,
      result: {
        constraints: [{
          title: 'Team meeting',
          startIso: '2030-02-03T18:00:00.000+05:30',
          endIso: '2030-02-03T18:30:00.000+05:30',
          sourceQuote: 'team meeting at 6',
        }],
        focusSessions: [{
          taskId: null,
          title: 'Meeting prep',
          startIso: '2030-02-03T17:00:00.000+05:30',
          endIso: '2030-02-03T17:30:00.000+05:30',
          durationMinutes: 30,
          sessionType: 'meeting',
        }],
      },
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => /invented source quote/i.test(error)));
    assert.ok(result.errors.some(error => /unknown session type/i.test(error)));
    assert.ok(result.errors.some(error => /task linkage/i.test(error)));
  });

  it('accepts grounded proposed work that can be materialized as a task', () => {
    const result = planner.validatePlannerSynthesis({
      windowStart: new Date('2030-02-03T08:00:00.000+05:30'),
      windowEnd: new Date('2030-02-03T23:00:00.000+05:30'),
      notBefore: null,
      calendarEvents: [],
      candidateTaskIds: [],
      freshText: 'Learn probability around 11:30.',
      result: {
        constraints: [],
        focusSessions: [{
          taskId: null,
          proposedTask: { title: 'Learn probability', sourceQuote: 'Learn probability' },
          title: 'Learn probability',
          startIso: '2030-02-03T11:30:00.000+05:30',
          endIso: '2030-02-03T12:00:00.000+05:30',
          durationMinutes: 30,
          sessionType: 'study',
        }],
      },
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('persists meetings only as constraints and materializes genuine work automatically', async () => {
    const payload = await planner.generateNextDayPlan({
      planDate: '2030-02-03',
      sleepTime: '23:00',
      wakeEstimate: '08:00',
      tomorrowIntention: 'I have meeting at 6 pm to 6:30 today. Learn probability around 11:30.',
      syncCalendar: false,
      regenerate: true,
    });

    assert.equal(payload.constraints.length, 1);
    assert.equal(payload.constraints[0].title, 'Meeting');
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE lower(title) LIKE '%meeting%'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM planned_focus_sessions WHERE lower(title) LIKE '%meeting%'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM soft_watch_commitments WHERE lower(target_title) LIKE '%meeting%'`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM coaching_commitments WHERE lower(title) LIKE '%meeting%'`).get().count, 0);
    assert.ok(payload.sessions.length > 0);
    assert.ok(payload.sessions.every(session => Number.isInteger(session.task_id) && session.task_id > 0));
    assert.ok(db.prepare(`SELECT id FROM tasks WHERE lower(title) LIKE '%probability%'`).get());
  });
});
