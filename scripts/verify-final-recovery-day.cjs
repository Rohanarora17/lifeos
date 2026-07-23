#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-recovery-day-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const planDate = '2030-06-03';
  setSetting('morning_brief_time', '09:30');

  const lightTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Math Academy light review', 'todo', 'medium', 'math', 'probability', 'low', 30, ?
    )
  `).run(planDate);
  const heavyTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Implement ZK proof benchmark', 'todo', 'high', 'coding', 'zero knowledge', 'high', 90, ?
    )
  `).run(planDate);
  const lightTaskId = Number(lightTask.lastInsertRowid);
  const heavyTaskId = Number(heavyTask.lastInsertRowid);

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '02:15',
    wakeEstimate: '10:30',
    mood: 'low',
    energy: 'low',
    eveningNotes: 'Could not sleep until after 2am. Tomorrow needs minimum viable progress, not a heavy push.',
    tomorrowIntention: 'Keep math alive lightly and avoid heavy ZK implementation unless energy recovers',
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.plan, 'Expected recovery-day plan to be created.');
  assert(payload.plan.mood === 'low', `Expected low mood on plan, got ${payload.plan.mood}.`);
  assert(payload.plan.energy === 'low', `Expected low energy on plan, got ${payload.plan.energy}.`);
  assert(payload.personalization.mode === 'recovery', `Expected recovery personalization mode, got ${payload.personalization.mode}.`);
  assert(payload.personalization.energy === 'low', `Expected low personalization energy, got ${payload.personalization.energy}.`);
  assert(payload.sessions.length >= 1, 'Expected at least one recovery-safe planned session.');

  const first = payload.sessions[0];
  const rule = JSON.parse(first.rule_json);
  assert(first.task_id === lightTaskId, `Expected light low-energy task first, got task ${first.task_id}.`);
  assert(first.task_id !== heavyTaskId, 'Expected heavy high-energy task not to be the first recovery block.');
  assert(first.duration_minutes <= 30, `Expected recovery block <= 30m, got ${first.duration_minutes}m.`);
  assert(first.reward_xp > 0, 'Expected adaptive XP for recovery block.');
  assert(first.reward_coins > 0, 'Expected adaptive coins for recovery block.');
  assert(
    rule.rewardReason.includes('small recovery-compatible block gets consistency credit'),
    'Expected reward reason to cite recovery-compatible block sizing.'
  );
  assert(
    rule.rewardReason.includes('recovery mode shaped'),
    'Expected reward reason to cite recovery mode shaping.'
  );

  const lightCandidate = payload.candidateTasks.find(task => task.id === lightTaskId);
  const heavyCandidate = payload.candidateTasks.find(task => task.id === heavyTaskId);
  assert(lightCandidate, 'Expected light task candidate.');
  assert(heavyCandidate, 'Expected heavy task candidate.');
  assert(lightCandidate.reason.includes('low-energy fit'), 'Expected light candidate to cite low-energy fit.');
  assert(heavyCandidate.reason.includes('defer if drained'), 'Expected heavy candidate to cite low-energy deferral.');
  assert(lightCandidate.score > heavyCandidate.score, 'Expected low-energy task to outrank heavy task on recovery day.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'recovery day uses sleep mood energy to select smaller low-friction planned work',
    planDate,
    firstSessionTitle: first.title,
    firstSessionMinutes: first.duration_minutes,
    mode: payload.personalization.mode,
    rewardReason: rule.rewardReason,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
