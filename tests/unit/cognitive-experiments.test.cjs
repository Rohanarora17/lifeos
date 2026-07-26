'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createIsolatedDb,
  seedPressureLinkedSessions,
  seedNonUrgentTask,
} = require('../helpers/temp-db.cjs');

describe('cognitive experiments (B4) — offer/decline/accept + planner bias', () => {
  let db;
  let setSetting;
  let proposeCognitiveExperiment;
  let respondToCognitiveExperiment;
  let getPlannerExperimentBias;
  let getCognitiveExperimentState;
  let generateNextDayPlan;
  let taskId;

  before(() => {
    const env = createIsolatedDb('lifeos-cog-exp-');
    db = env.db;
    setSetting = env.setSetting;
    setSetting('morning_brief_time', '09:00');
    seedPressureLinkedSessions(db, 7);
    taskId = seedNonUrgentTask(db).id;

    ({
      proposeCognitiveExperiment,
      respondToCognitiveExperiment,
      getPlannerExperimentBias,
      getCognitiveExperimentState,
    } = env.requireLib('cognitive-experiments.ts'));
    ({ generateNextDayPlan } = env.requireLib('next-day-planner.ts'));
  });

  beforeEach(() => {
    // Keep pressure data; reset experiment store between cases that need a clean offer
  });

  it('proposes an offer for pressure-wired users', () => {
    setSetting('cognitive_experiments_v1', '[]');
    const proposed = proposeCognitiveExperiment();
    assert.equal(proposed.created, true);
    assert.ok(proposed.experiment);
    assert.equal(proposed.experiment.status, 'offered');
    assert.ok(
      proposed.experiment.kind === 'activation_block'
      || proposed.experiment.kind === 'early_synthetic_deadline',
    );
  });

  it('decline leaves planner unbiased', async () => {
    setSetting('cognitive_experiments_v1', '[]');
    const proposed = proposeCognitiveExperiment();
    respondToCognitiveExperiment({ experimentId: proposed.experiment.id, response: 'declined' });
    assert.equal(getPlannerExperimentBias().active, false);

    const plan = await generateNextDayPlan({
      planDate: '2031-06-01',
      sleepTime: '23:30',
      wakeEstimate: '08:30',
      mood: 'medium',
      energy: 'medium',
      tomorrowIntention: 'Deep paper synthesis',
      selectedTaskIds: [taskId],
      syncCalendar: false,
      regenerate: true,
    });
    const session = plan.sessions.find(s => s.task_id === taskId);
    assert.ok(session, 'selected task still schedules after decline');
    const rule = JSON.parse(session.rule_json);
    assert.ok(!/Light experiment active/i.test(rule.guidance || ''));
  });

  it('accept activation block creates soft-watch and shortens planned session', async () => {
    setSetting('cognitive_experiments_v1', '[]');
    const proposed = proposeCognitiveExperiment();
    assert.ok(proposed.experiment);

    // Pin activation experiment onto the non-urgent research task
    const { getSetting } = require('../../src/lib/db.ts');
    const rows = JSON.parse(getSetting('cognitive_experiments_v1'));
    const last = rows[rows.length - 1];
    last.suggestedTaskId = taskId;
    last.suggestedTaskTitle = 'Deep paper synthesis';
    last.kind = 'activation_block';
    last.durationMinutes = 15;
    last.title = '15-minute activation block';
    last.status = 'offered';
    setSetting('cognitive_experiments_v1', JSON.stringify(rows));

    const accepted = respondToCognitiveExperiment({ experimentId: last.id, response: 'accepted' });
    assert.equal(accepted.experiment.status, 'accepted');
    assert.ok(accepted.experiment.softWatchId);

    const soft = db.prepare('SELECT * FROM soft_watch_commitments WHERE id = ?').get(accepted.experiment.softWatchId);
    assert.ok(soft);
    assert.equal(soft.status, 'pending');
    assert.equal(Number(soft.task_id), taskId);

    const bias = getPlannerExperimentBias();
    assert.equal(bias.active, true);
    assert.equal(bias.kind, 'activation_block');
    assert.equal(bias.taskId, taskId);
    assert.equal(bias.preferredActivationMinutes, 15);

    const plan = await generateNextDayPlan({
      planDate: '2031-06-02',
      sleepTime: '23:30',
      wakeEstimate: '08:30',
      mood: 'medium',
      energy: 'medium',
      tomorrowIntention: 'Deep paper synthesis',
      selectedTaskIds: [taskId],
      syncCalendar: false,
      regenerate: true,
    });
    const session = plan.sessions.find(s => s.task_id === taskId);
    assert.ok(session);
    assert.ok(session.duration_minutes <= 25, `expected short activation block, got ${session.duration_minutes}`);
    const rule = JSON.parse(session.rule_json);
    assert.match(rule.guidance || '', /Light experiment active|activation block/i);
    const candidate = plan.candidateTasks.find(c => c.id === taskId);
    assert.match(candidate.reason, /activation block|light experiment/i);
  });

  it('accept early synthetic deadline boosts target and injects guidance', async () => {
    setSetting('cognitive_experiments_v1', '[]');
    // Clear any active from previous test by completing/cancelling via empty store
    const offered = {
      id: 'exp_synthetic_test',
      kind: 'early_synthetic_deadline',
      status: 'offered',
      title: 'Early synthetic deadline',
      rationale: 'test',
      traitSignals: ['high PDI'],
      suggestedTaskId: taskId,
      suggestedTaskTitle: 'Deep paper synthesis',
      durationMinutes: 45,
      syntheticDueDate: '2031-06-05',
      offeredAt: new Date().toISOString(),
      respondedAt: null,
      expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      softWatchId: null,
      notes: null,
    };
    setSetting('cognitive_experiments_v1', JSON.stringify([offered]));
    const accepted = respondToCognitiveExperiment({ experimentId: offered.id, response: 'accepted' });
    assert.equal(accepted.experiment.status, 'accepted');

    const bias = getPlannerExperimentBias();
    assert.equal(bias.active, true);
    assert.equal(bias.kind, 'early_synthetic_deadline');
    assert.equal(bias.syntheticDueDate, '2031-06-05');
    assert.ok(bias.scoreBoost >= 40);

    const plan = await generateNextDayPlan({
      planDate: '2031-06-03',
      sleepTime: '23:30',
      wakeEstimate: '08:30',
      mood: 'medium',
      energy: 'high',
      tomorrowIntention: 'Deep paper synthesis',
      selectedTaskIds: [taskId],
      syncCalendar: false,
      regenerate: true,
    });
    const session = plan.sessions.find(s => s.task_id === taskId);
    assert.ok(session);
    const rule = JSON.parse(session.rule_json);
    assert.match(rule.guidance || '', /synthetic deadline|Light experiment active/i);
    const candidate = plan.candidateTasks.find(c => c.id === taskId);
    assert.match(candidate.reason, /synthetic due|light experiment/i);
  });

  it('blocks a second offer while an experiment is active', () => {
    const state = getCognitiveExperimentState();
    assert.ok(state.active, 'expected an active experiment from prior accept');
    const blocked = proposeCognitiveExperiment();
    assert.equal(blocked.created, false);
    assert.ok(state.offerBlockReason || blocked.state.offerBlockReason);
  });
});
