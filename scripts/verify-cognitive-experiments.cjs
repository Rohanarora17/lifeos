#!/usr/bin/env node

/**
 * Tier B4: light experiments — offer/accept/decline and planner bias.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-cognitive-exp-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const {
  proposeCognitiveExperiment,
  respondToCognitiveExperiment,
  getPlannerExperimentBias,
  getCognitiveExperimentState,
} = require('../src/lib/cognitive-experiments.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  setSetting('morning_brief_time', '09:00');

  // Non-urgent high-value task + pressure-wired history
  const task = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, energy_required, estimated_minutes, due_date, created_at
    ) VALUES (
      'Deep paper synthesis', 'todo', 'high', 'research', 'high', 90,
      date('now', '+14 days'), datetime('now', '-12 days')
    )
  `).run();
  const taskId = Number(task.lastInsertRowid);

  // Pressure-wired linked sessions on other tasks so traits fire
  const pressureSpecs = [
    { title: 'Crisis A', dueOffset: 0, createOffset: -14, creditOffset: 0, focus: 90, minutes: 50 },
    { title: 'Crisis B', dueOffset: 1, createOffset: -12, creditOffset: 1, focus: 91, minutes: 55 },
    { title: 'Crisis C', dueOffset: 2, createOffset: -15, creditOffset: 1, focus: 88, minutes: 40 },
    { title: 'Crisis D', dueOffset: -1, createOffset: -18, creditOffset: 0, focus: 87, minutes: 45 },
    { title: 'Crisis E', dueOffset: 0, createOffset: -10, creditOffset: -1, focus: 89, minutes: 50 },
    { title: 'Calm lag', dueOffset: 14, createOffset: -10, creditOffset: 0, focus: 68, minutes: 30 },
    { title: 'Calm lag 2', dueOffset: 12, createOffset: -9, creditOffset: -1, focus: 70, minutes: 25 },
  ];

  for (let i = 0; i < pressureSpecs.length; i++) {
    const s = pressureSpecs[i];
    const t = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', ?), ?)
    `).run(s.title, `${s.dueOffset} days`, `${s.createOffset} days`, s.minutes);
    const id = Number(t.lastInsertRowid);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `).run(id, `exp-seed-${i}`, s.title, s.minutes, s.focus, `${s.creditOffset} days`);
  }

  // 1) Propose offer
  const proposed = proposeCognitiveExperiment();
  assert(proposed.created, 'Expected a new experiment offer for pressure-wired user.');
  assert(proposed.experiment, 'Expected experiment payload.');
  assert(proposed.experiment.status === 'offered', 'New experiment should be offered.');
  assert(
    proposed.experiment.kind === 'activation_block' || proposed.experiment.kind === 'early_synthetic_deadline',
    `Unexpected experiment kind ${proposed.experiment.kind}`,
  );

  const offeredId = proposed.experiment.id;
  const offeredKind = proposed.experiment.kind;

  // 2) Decline leaves planner unbiased
  const declined = respondToCognitiveExperiment({ experimentId: offeredId, response: 'declined' });
  assert(declined.experiment.status === 'declined', 'Decline should stick.');
  const biasAfterDecline = getPlannerExperimentBias();
  assert(!biasAfterDecline.active, 'Declined experiment must not bias planner.');

  const planDeclined = await generateNextDayPlan({
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
  const sessionDeclined = planDeclined.sessions.find(s => s.task_id === taskId);
  assert(sessionDeclined, 'Planner should still schedule selected task after decline.');
  const ruleDeclined = JSON.parse(sessionDeclined.rule_json);
  assert(
    !/Light experiment active/i.test(ruleDeclined.guidance || ''),
    'Declined path must not inject experiment guidance into session rules.',
  );

  // 3) Fresh offer after store reset; pin activation block to target task
  setSetting('cognitive_experiments_v1', '[]');
  const proposed2 = proposeCognitiveExperiment();
  assert(proposed2.created && proposed2.experiment, 'Expected a second offer after store reset.');

  const { getSetting } = require('../src/lib/db.ts');
  const rows = JSON.parse(getSetting('cognitive_experiments_v1'));
  rows[rows.length - 1].suggestedTaskId = taskId;
  rows[rows.length - 1].suggestedTaskTitle = 'Deep paper synthesis';
  rows[rows.length - 1].kind = 'activation_block';
  rows[rows.length - 1].durationMinutes = 15;
  rows[rows.length - 1].title = '15-minute activation block';
  setSetting('cognitive_experiments_v1', JSON.stringify(rows));
  const forcedOfferId = rows[rows.length - 1].id;

  const accepted = respondToCognitiveExperiment({ experimentId: forcedOfferId, response: 'accepted' });
  assert(accepted.experiment.status === 'accepted', 'Accept should stick.');
  assert(accepted.experiment.softWatchId, 'Accept should create a soft-watch commitment id.');

  const soft = db.prepare('SELECT * FROM soft_watch_commitments WHERE id = ?').get(accepted.experiment.softWatchId);
  assert(soft, 'Soft-watch row should exist.');
  assert(soft.status === 'pending', 'Soft-watch should be pending.');
  assert(Number(soft.task_id) === taskId, 'Soft-watch should target experiment task.');

  const bias = getPlannerExperimentBias();
  assert(bias.active, 'Accepted experiment should activate planner bias.');
  assert(bias.kind === 'activation_block', 'Bias kind should be activation_block.');
  assert(bias.taskId === taskId, 'Bias should target experiment task.');
  assert(bias.preferredActivationMinutes === 15, 'Activation minutes should be 15.');

  const planAccepted = await generateNextDayPlan({
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
  const sessionAccepted = planAccepted.sessions.find(s => s.task_id === taskId);
  assert(sessionAccepted, 'Accepted experiment should still schedule target task.');
  assert(
    sessionAccepted.duration_minutes <= 25,
    `Activation experiment should shorten block, got ${sessionAccepted.duration_minutes}m`,
  );
  const ruleAccepted = JSON.parse(sessionAccepted.rule_json);
  assert(
    /Light experiment active|activation block/i.test(ruleAccepted.guidance || ''),
    `Expected experiment guidance in rule, got: ${ruleAccepted.guidance}`,
  );
  const candidate = planAccepted.candidateTasks.find(c => c.id === taskId);
  assert(candidate, 'Target should appear in candidates.');
  assert(
    /activation block|light experiment/i.test(candidate.reason),
    `Candidate reason should cite experiment, got: ${candidate.reason}`,
  );

  // 4) Only one active at a time
  const blocked = proposeCognitiveExperiment();
  assert(!blocked.created, 'Should not create another experiment while one is active.');
  const state = getCognitiveExperimentState();
  assert(state.active && state.active.id === forcedOfferId, 'Active experiment should remain.');
  assert(state.offerBlockReason, 'Should explain why another offer is blocked.');

  console.log(JSON.stringify({
    ok: true,
    scenario: 'light experiment offer/decline/accept + planner bias',
    firstOfferKind: offeredKind,
    acceptedKind: 'activation_block',
    declinedGuidanceClean: true,
    acceptedDuration: sessionAccepted.duration_minutes,
    softWatchId: accepted.experiment.softWatchId,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});