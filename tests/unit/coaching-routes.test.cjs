'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('coaching commitment routes', () => {
  let db;
  let commitments;
  let stateGET;
  let actionsPOST;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-coaching-routes-');
    db = env.db;
    commitments = env.requireLib('coaching-commitments.ts');
    ({ GET: stateGET } = require('../../src/app/api/coaching/state/route.ts'));
    ({ POST: actionsPOST } = require('../../src/app/api/coaching/actions/route.ts'));
  });

  async function seedMissedCommitment() {
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, status, created_at, updated_at)
      VALUES (date('now'), 'active', datetime('now'), datetime('now'))
    `).run();
    const start = new Date(Date.now() - 6 * 60_000);
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, title, planned_start, planned_end, duration_minutes, status
      ) VALUES ('route-commitment', ?, 'Finish DSA exercise', ?, ?, 20, 'planned')
    `).run(plan.lastInsertRowid, start.toISOString(), new Date(start.getTime() + 20 * 60_000).toISOString());
    return commitments.runCommitmentExecutionCheck({ now: new Date(), send: async () => true });
  }

  it('exposes the current commitment and measured policy report', async () => {
    const seeded = await seedMissedCommitment();
    const response = await stateGET(new Request('http://lifeos.test/api/coaching/state'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.currentCommitment.id, seeded.commitment.id);
    assert.equal(body.currentCommitment.state, 'missed');
    assert.equal(body.interventionLearning.totalEvaluated, 0);
    assert.equal(body.decisions[0].commitmentId, seeded.commitment.id);
    assert.equal(body.decisions[0].variant, seeded.policy.variant);
  });

  it('reschedules a missed commitment through the coaching action route', async () => {
    const seeded = await seedMissedCommitment();
    const response = await actionsPOST(new Request('http://lifeos.test/api/coaching/actions', {
      method: 'POST',
      body: JSON.stringify({ action: 'commit_reschedule', commitmentId: seeded.commitment.id, delayMinutes: 30 }),
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.commitment.state, 'scheduled');
    assert.ok(new Date(body.commitment.plannedStartAt).getTime() >= Date.now() + 29 * 60_000);
  });

  it('records a user supplied blocker through the coaching action route', async () => {
    const seeded = await seedMissedCommitment();
    const response = await actionsPOST(new Request('http://lifeos.test/api/coaching/actions', {
      method: 'POST',
      body: JSON.stringify({
        action: 'commit_blocked', commitmentId: seeded.commitment.id,
        text: 'I keep reaching for my phone whenever the problem feels hard',
      }),
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.commitment.blockerKind, 'distraction');
    assert.match(body.commitment.blockerText, /reaching for my phone/i);
  });
});
