'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('closed-loop coaching commitments', () => {
  let db;
  let commitments;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-coaching-commitments-');
    db = env.db;
    commitments = env.requireLib('coaching-commitments.ts');
  });

  function addPlannedSession({ id = 'plan-session-1', startAt, minutes = 25, title = 'Practice dynamic programming' }) {
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, status, created_at, updated_at)
      VALUES (date('now'), 'active', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, title, planned_start, planned_end, duration_minutes, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned')
    `).run(id, plan.lastInsertRowid, title, startAt.toISOString(), new Date(startAt.getTime() + minutes * 60_000).toISOString(), minutes);
    return id;
  }

  it('waits for the five-minute grace period before declaring a missed start', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    addPlannedSession({ startAt: plannedAt });

    const early = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:04:59.000Z'),
      send: async () => true,
    });
    assert.equal(early.action, 'none');

    const due = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'),
      send: async () => true,
    });
    assert.equal(due.action, 'intervened');
    assert.equal(due.commitment.title, 'Practice dynamic programming');
    assert.equal(due.commitment.state, 'missed');
    assert.ok(due.commitment.interventionDecisionId);
  });

  it('sends only one missed-start intervention for the same commitment', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    addPlannedSession({ startAt: plannedAt });
    let deliveries = 0;
    const send = async () => { deliveries += 1; return true; };

    await commitments.runCommitmentExecutionCheck({ now: new Date('2026-09-10T10:05:00.000Z'), send });
    const repeated = await commitments.runCommitmentExecutionCheck({ now: new Date('2026-09-10T10:12:00.000Z'), send });

    assert.equal(deliveries, 1);
    assert.equal(repeated.action, 'already_handled');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM coaching_decisions WHERE action_type='missed_start'").get().count, 1);
  });

  it('closes an unanswered intervention as an abandoned commitment after thirty minutes', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    addPlannedSession({ startAt: plannedAt });
    const first = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'), send: async () => true,
    });

    const timedOut = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:35:00.000Z'), send: async () => true,
    });

    assert.equal(timedOut.action, 'none');
    const closed = commitments.getCommitment(first.commitment.id);
    assert.equal(closed.state, 'abandoned');
    assert.equal(closed.outcomeScore, 0);
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='plan-session-1'").pluck().get(), 'skipped');
  });

  it('records an old unobserved start as abandoned instead of leaving it scheduled forever', async () => {
    const plannedAt = new Date('2026-09-10T02:00:00.000Z');
    addPlannedSession({ startAt: plannedAt });

    const result = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:00:00.000Z'), send: async () => true,
    });

    assert.equal(result.action, 'none');
    const closed = db.prepare("SELECT state, outcome_score FROM coaching_commitments WHERE commitment_key='planned:plan-session-1'").get();
    assert.equal(closed.state, 'abandoned');
    assert.equal(closed.outcome_score, 0);
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='plan-session-1'").pluck().get(), 'skipped');
  });

  it('marks the linked soft watch as checked in when the closed-loop coach intervenes', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    const plannedId = addPlannedSession({ startAt: plannedAt });
    db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, intended_start_at, planned_minutes, source, status, created_at
      ) VALUES ('linked-soft-watch', 'Practice dynamic programming', ?, 25, 'planner', 'pending', ?)
    `).run(plannedAt.getTime(), plannedAt.getTime() - 60_000);
    db.prepare('UPDATE planned_focus_sessions SET soft_watch_id=? WHERE id=?')
      .run('linked-soft-watch', plannedId);

    await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'),
      send: async () => true,
    });

    const linked = db.prepare('SELECT check_in_sent_at FROM soft_watch_commitments WHERE id=?')
      .get('linked-soft-watch');
    assert.equal(linked.check_in_sent_at, new Date('2026-09-10T10:05:00.000Z').getTime());
  });

  it('links a late Guardian start and completion back to the intervention decision', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    const plannedId = addPlannedSession({ startAt: plannedAt, minutes: 25 });
    await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'),
      send: async () => true,
    });

    const started = commitments.recordSessionStartedForCommitment({
      sessionId: 'guardian-1',
      title: 'Practice dynamic programming',
      plannedSessionId: plannedId,
      startedAt: new Date('2026-09-10T10:07:00.000Z'),
      plannedMinutes: 25,
    });
    assert.equal(started.state, 'started');
    assert.equal(started.startDelaySeconds, 420);

    const completed = commitments.recordSessionOutcomeForCommitment({
      sessionId: 'guardian-1',
      elapsedMinutes: 23,
      focusScore: 80,
      verifiedEvidence: true,
      completedAt: new Date('2026-09-10T10:30:00.000Z'),
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.completionRatio, 0.92);
    assert.ok(completed.outcomeScore >= 0.9);

    const decision = db.prepare(`
      SELECT status, outcome_score, evaluated_at, actual_outcome
      FROM coaching_decisions WHERE id = ?
    `).get(completed.interventionDecisionId);
    assert.equal(decision.status, 'completed');
    assert.ok(decision.outcome_score >= 0.9);
    assert.ok(decision.evaluated_at);
    assert.equal(JSON.parse(decision.actual_outcome).sessionId, 'guardian-1');
  });

  it('records a short or unverified session as abandonment rather than success', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    const plannedId = addPlannedSession({ startAt: plannedAt, minutes: 30 });
    await commitments.runCommitmentExecutionCheck({ now: new Date('2026-09-10T10:05:00.000Z'), send: async () => true });
    commitments.recordSessionStartedForCommitment({
      sessionId: 'guardian-short', title: 'Practice dynamic programming', plannedSessionId: plannedId,
      startedAt: new Date('2026-09-10T10:06:00.000Z'), plannedMinutes: 30,
    });

    const abandoned = commitments.recordSessionOutcomeForCommitment({
      sessionId: 'guardian-short', elapsedMinutes: 4, focusScore: null,
      verifiedEvidence: false, completedAt: new Date('2026-09-10T10:10:00.000Z'),
    });
    assert.equal(abandoned.state, 'abandoned');
    assert.equal(abandoned.outcomeScore, 0);
    assert.equal(db.prepare('SELECT status FROM coaching_decisions WHERE id=?').get(abandoned.interventionDecisionId).status, 'failed');
  });

  it('reschedules the original plan and evaluates the intervention as an honest recovery', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    addPlannedSession({ startAt: plannedAt, minutes: 25 });
    const intervention = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'), send: async () => true,
    });

    const rescheduled = commitments.rescheduleCommitment(intervention.commitment.id, 30, new Date('2026-09-10T10:06:00.000Z'));
    assert.equal(rescheduled.state, 'scheduled');
    assert.equal(rescheduled.plannedStartAt, '2026-09-10T10:36:00.000Z');
    const source = db.prepare('SELECT planned_start, status FROM planned_focus_sessions WHERE id=?').get('plan-session-1');
    assert.equal(source.planned_start, '2026-09-10T10:36:00.000Z');
    assert.equal(source.status, 'planned');
    const decision = db.prepare('SELECT status, outcome_score, evaluated_at FROM coaching_decisions WHERE id=?').get(intervention.commitment.interventionDecisionId);
    assert.equal(decision.status, 'accepted');
    assert.equal(decision.outcome_score, 0.25);
    assert.ok(decision.evaluated_at);

    const nextMiss = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:41:00.000Z'), send: async () => true,
    });
    assert.equal(nextMiss.action, 'intervened');
    assert.notEqual(nextMiss.commitment.interventionDecisionId, intervention.commitment.interventionDecisionId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM coaching_decisions WHERE action_type='missed_start'").get().count, 2);
  });

  it('reports learned effectiveness by intervention variant', async () => {
    const plannedAt = new Date('2026-09-10T10:00:00.000Z');
    const plannedId = addPlannedSession({ startAt: plannedAt, minutes: 20 });
    const intervention = await commitments.runCommitmentExecutionCheck({
      now: new Date('2026-09-10T10:05:00.000Z'), send: async () => true,
    });
    commitments.recordSessionStartedForCommitment({
      sessionId: 'guardian-stats', title: 'Practice dynamic programming', plannedSessionId: plannedId,
      startedAt: new Date('2026-09-10T10:05:30.000Z'), plannedMinutes: 20,
    });
    commitments.recordSessionOutcomeForCommitment({
      sessionId: 'guardian-stats', elapsedMinutes: 20, focusScore: 75,
      verifiedEvidence: true, completedAt: new Date('2026-09-10T10:25:30.000Z'),
    });

    const report = commitments.getInterventionLearningReport();
    const row = report.variants.find(item => item.variant === intervention.policy.variant);
    assert.equal(row.evaluated, 1);
    assert.equal(row.completed, 1);
    assert.ok(row.averageOutcome > 0.8);
  });

  it('selects the strongest measured intervention after every variant has enough evidence', async () => {
    const now = new Date('2026-09-10T10:05:00.000Z');
    const period = now.getHours() < 6 ? 'night' : now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';
    const scores = { direct_start: 0.2, tiny_start: 0.9, choice: 0.45 };
    for (const [variant, score] of Object.entries(scores)) {
      for (let sample = 0; sample < 2; sample += 1) {
        db.prepare(`
          INSERT INTO coaching_decisions (
            policy_version, action_type, status, channel, reason, actual_outcome,
            dedupe_key, created_at, updated_at, variant, context_key, outcome_score, evaluated_at
          ) VALUES ('seed', 'missed_start', 'completed', 'test', 'seed sample', '{}', ?, ?, ?, ?, ?, ?, ?)
        `).run(`seed:${variant}:${sample}`, now.toISOString(), now.toISOString(), variant, `normal:${period}`, score, now.toISOString());
      }
    }
    addPlannedSession({ id: 'learned-policy', startAt: new Date('2026-09-10T10:00:00.000Z') });

    const result = await commitments.runCommitmentExecutionCheck({ now, send: async () => true });

    assert.equal(result.action, 'intervened');
    assert.equal(result.policy.variant, 'tiny_start');
    assert.match(result.policy.reason, /measured outcomes/i);
  });
});
