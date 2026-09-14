'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('adaptive day planner', () => {
  let db;
  let planner;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-adaptive-day-planner-');
    db = env.db;
    planner = env.requireLib('next-day-planner.ts');
  });

  it('turns an explicit holiday instruction into calendar overrides for this plan', () => {
    const events = [
      { id: 'class-1', title: 'CS5800 — Advanced Data Structures', start_time: '2026-09-15T03:30:00.000Z', end_time: '2026-09-15T04:20:00.000Z' },
      { id: 'class-2', title: 'EE5110 — Probability', start_time: '2026-09-15T06:30:00.000Z', end_time: '2026-09-15T07:20:00.000Z' },
    ];

    const context = planner.interpretPlanningContext({
      intention: 'Tomorrow is a holiday. Ignore the classes and calendar events for this plan.',
      eveningNotes: null,
      calendarEvents: events,
    });

    assert.deepEqual(context.ignoredCalendarEventIds, ['class-1', 'class-2']);
    assert.equal(context.effectiveCalendarEvents.length, 0);
    assert.ok(context.signals.some(signal => /holiday/i.test(signal)));
    assert.ok(context.signals.some(signal => /2 calendar items ignored/i.test(signal)));
  });

  it('models a late schedule as one wake-to-sleep planning day across midnight', () => {
    const window = planner.buildPlanningDayWindow('2026-09-14', '13:00', '07:00');

    assert.equal(window.start.toISOString(), '2026-09-14T07:30:00.000Z');
    assert.equal(window.end.toISOString(), '2026-09-15T01:30:00.000Z');
    assert.equal(window.spansMidnight, true);
  });

  it('keeps only calendar events that intersect the wake-to-sleep day', () => {
    const window = planner.buildPlanningDayWindow('2026-09-14', '13:00', '07:00');
    const events = planner.filterCalendarEventsForPlanningWindow([
      { id: 'before-wake', title: 'Morning class', start_time: '2026-09-14T02:30:00.000Z', end_time: '2026-09-14T03:20:00.000Z' },
      { id: 'in-window', title: 'Evening class', start_time: '2026-09-14T08:30:00.000Z', end_time: '2026-09-14T09:20:00.000Z' },
      { id: 'after-sleep', title: 'Next morning class', start_time: '2026-09-15T03:30:00.000Z', end_time: '2026-09-15T04:20:00.000Z' },
    ], window);

    assert.deepEqual(events.map(event => event.id), ['in-window']);
  });

  it('rejects AI blocks that are before the live replanning boundary or overlap effective commitments', () => {
    const result = planner.validatePlannedSessionSpecs({
      specs: [
        { title: 'Past block', startIso: '2026-09-14T21:00:00.000+05:30', endIso: '2026-09-14T21:20:00.000+05:30', durationMinutes: 20 },
        { title: 'Overlap', startIso: '2026-09-14T23:00:00.000+05:30', endIso: '2026-09-14T23:20:00.000+05:30', durationMinutes: 20 },
        { title: 'Valid', startIso: '2026-09-15T01:00:00.000+05:30', endIso: '2026-09-15T01:20:00.000+05:30', durationMinutes: 20 },
      ],
      windowStart: new Date('2026-09-14T13:00:00.000+05:30'),
      windowEnd: new Date('2026-09-15T07:00:00.000+05:30'),
      notBefore: new Date('2026-09-14T22:30:00.000+05:30'),
      calendarEvents: [
        { title: 'Fixed call', start_time: '2026-09-14T22:55:00.000+05:30', end_time: '2026-09-14T23:30:00.000+05:30' },
      ],
    });

    assert.deepEqual(result.valid.map(item => item.title), ['Valid']);
    assert.deepEqual(result.rejected.map(item => item.reason), ['before live replanning boundary', 'overlaps Fixed call']);
  });

  it('exposes rolling focus load separately from the current wake-to-sleep window', () => {
    const now = new Date();
    const insert = db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES (?, ?, 20, 20, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      const at = new Date(now.getTime() - (index + 1) * 60 * 60 * 1000).toISOString();
      insert.run(`recent-${index}`, `Recent ${index}`, 78 + index, 78 + index, at, at);
    }

    const load = planner.loadPlanningFocusLoad({
      windowStart: new Date(now.getTime() - 30 * 60 * 1000),
      now,
    });

    assert.equal(load.last24Hours.sessionCount, 3);
    assert.equal(load.last24Hours.focusedMinutes, 60);
    assert.equal(load.currentPlanningDay.sessionCount, 0);
    assert.equal(load.last24Hours.averageFocusScore, 79);
  });

  it('preserves completed and started sessions while replacing only pending blocks', async () => {
    const planDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, energy_required, estimated_minutes, due_date)
      VALUES ('Graphs', 'todo', 'high', 'problem_practice', 'medium', 20, ?)
    `).run(planDate);
    const taskId = Number(task.lastInsertRowid);
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, status)
      VALUES (?, '23:30', '08:30', 'medium', 'medium', 'active')
    `).run(planDate);
    const planId = Number(plan.lastInsertRowid);
    const addSession = db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
        session_type, status
      ) VALUES (?, ?, ?, 'Graphs', ?, ?, 20, 'problem_practice', ?)
    `);
    addSession.run('keep-completed', planId, taskId, `${planDate}T09:00:00.000+05:30`, `${planDate}T09:20:00.000+05:30`, 'completed');
    addSession.run('keep-started', planId, taskId, `${planDate}T10:00:00.000+05:30`, `${planDate}T10:20:00.000+05:30`, 'started');
    addSession.run('replace-planned', planId, taskId, `${planDate}T11:00:00.000+05:30`, `${planDate}T11:20:00.000+05:30`, 'planned');

    await planner.generateNextDayPlan({
      planDate,
      sleepTime: '23:30',
      wakeEstimate: '08:30',
      mood: 'medium',
      energy: 'medium',
      tomorrowIntention: 'Continue graphs',
      selectedTaskIds: [taskId],
      syncCalendar: false,
      regenerate: true,
    });

    const statuses = db.prepare('SELECT id, status FROM planned_focus_sessions WHERE plan_id=? ORDER BY id').all(planId);
    assert.ok(statuses.some(row => row.id === 'keep-completed' && row.status === 'completed'));
    assert.ok(statuses.some(row => row.id === 'keep-started' && row.status === 'started'));
    assert.equal(statuses.some(row => row.id === 'replace-planned'), false);
    assert.ok(statuses.some(row => row.id !== 'keep-completed' && row.id !== 'keep-started'));
  });
});
