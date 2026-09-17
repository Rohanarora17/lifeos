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
});
