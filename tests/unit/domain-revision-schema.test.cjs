'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('domain revision schema', () => {
  it('advances when planning-chain state changes', () => {
    const { db } = createIsolatedDb('lifeos-domain-revision-');
    const revision = () => db.prepare("SELECT revision FROM domain_revisions WHERE scope='global'").get().revision;
    assert.equal(revision(), 0);

    const task = db.prepare("INSERT INTO tasks (title, status) VALUES ('Graphs', 'todo')").run();
    assert.equal(revision(), 1);
    const plan = db.prepare("INSERT INTO daily_plans (plan_date, status) VALUES ('2030-02-01', 'active')").run();
    assert.equal(revision(), 2);
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, task_id, title, planned_start, planned_end, duration_minutes, status
      ) VALUES ('revision-session', ?, ?, 'Graphs', '2030-02-01T10:00:00.000Z',
        '2030-02-01T10:20:00.000Z', 20, 'planned')
    `).run(plan.lastInsertRowid, task.lastInsertRowid);
    assert.equal(revision(), 3);
  });

  it('ignores calendar sync metadata while tracking user-visible event changes', () => {
    const { db } = createIsolatedDb('lifeos-domain-calendar-revision-');
    const revision = () => db.prepare("SELECT revision FROM domain_revisions WHERE scope='global'").get().revision;
    db.prepare(`
      INSERT INTO calendar_events (id, title, start_time, end_time, synced_at)
      VALUES ('calendar-revision', 'Cryptography', '2030-02-01T10:00:00.000Z',
              '2030-02-01T11:00:00.000Z', '2030-01-31T10:00:00.000Z')
    `).run();
    assert.equal(revision(), 1);

    db.prepare("UPDATE calendar_events SET synced_at='2030-01-31T10:15:00.000Z' WHERE id='calendar-revision'").run();
    assert.equal(revision(), 1);

    db.prepare("UPDATE calendar_events SET title='Advanced Cryptography' WHERE id='calendar-revision'").run();
    assert.equal(revision(), 2);
  });
});
