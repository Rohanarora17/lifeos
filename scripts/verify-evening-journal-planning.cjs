#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-evening-journal-planning-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const checkinDate = '2030-06-14';
  const planDate = '2030-06-15';
  setSetting('morning_brief_time', '09:00');

  const lowEnergyTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Review ZK flashcards gently', 'todo', 'high', 'study', 'zero knowledge', 'low', 30, ?, 1
    )
  `).run(planDate);
  const highEnergyTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Implement ZK prover benchmark', 'todo', 'high', 'coding', 'zero knowledge', 'high', 60, '2030-06-20', 2
    )
  `).run();
  const lowEnergyTaskId = Number(lowEnergyTask.lastInsertRowid);
  const highEnergyTaskId = Number(highEnergyTask.lastInsertRowid);

  const checkinResult = db.prepare(`
    INSERT INTO daily_checkins (
      checkin_date, checkin_type, sleep_time, wake_estimate, mood, energy,
      day_events, tomorrow_intention, raw_transcript, tomorrow_score
    ) VALUES (
      ?, 'evening', '02:00', '09:00', 'low', 'low',
      'Family work ran late and drained my focus; tomorrow needs a lighter recovery start.',
      'Study ZK without draining myself',
      'Could not sleep until 2am. Mood and energy are low. I still want ZK tomorrow, but make it lighter. 5',
      5
    )
  `).run(checkinDate);
  const checkinId = Number(checkinResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO calendar_events (id, title, description, start_time, end_time, location)
    VALUES ('busy_after_recovery_window', 'Fixed commitments', 'Leave only the first recovery-sized block open', ?, ?, 'Calendar')
  `).run(
    istDate(planDate, '10:00').toISOString(),
    istDate(planDate, '23:00').toISOString()
  );

  const payload = await generateNextDayPlan({
    planDate,
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.plan, 'Expected a generated plan.');
  assert(payload.plan.source_checkin_id === checkinId, `Expected plan to cite latest evening check-in ${checkinId}, got ${payload.plan.source_checkin_id}.`);
  assert(payload.plan.sleep_time === '02:00', `Expected late sleep from evening journal, got ${payload.plan.sleep_time}.`);
  assert(payload.plan.wake_estimate === '09:00', `Expected wake estimate from evening journal, got ${payload.plan.wake_estimate}.`);
  assert(payload.plan.mood === 'low', `Expected low mood from evening journal, got ${payload.plan.mood}.`);
  assert(payload.plan.energy === 'low', `Expected low energy from evening journal, got ${payload.plan.energy}.`);
  assert(
    payload.plan.evening_notes.includes('Family work ran late'),
    'Expected day events from evening journal to persist into plan notes.'
  );

  assert(payload.suggestedInputs.source === 'existing_plan', `Expected returned suggested inputs to read the saved plan, got ${payload.suggestedInputs.source}.`);
  assert(payload.personalization.mode === 'recovery', `Expected recovery personalization mode, got ${payload.personalization.mode}.`);
  assert(payload.personalization.energy === 'low', `Expected low personalization energy, got ${payload.personalization.energy}.`);

  assert(payload.sessions.length >= 1, 'Expected planner to schedule at least one recovery block.');
  const first = payload.sessions[0];
  assert(first.task_id === lowEnergyTaskId, `Expected low-energy journal-compatible task first, got ${first.task_id}.`);
  assert(first.duration_minutes <= 35, `Expected recovery block to stay 35m or less, got ${first.duration_minutes}.`);
  assert(!payload.sessions.some(session => session.task_id === highEnergyTaskId), 'Expected high-energy task not to be scheduled into the constrained recovery window.');

  const lowCandidate = payload.candidateTasks.find(task => task.id === lowEnergyTaskId);
  const highCandidate = payload.candidateTasks.find(task => task.id === highEnergyTaskId);
  assert(lowCandidate, 'Expected low-energy task candidate.');
  assert(highCandidate, 'Expected high-energy task candidate.');
  assert(
    lowCandidate.score > highCandidate.score,
    `Expected evening journal energy to rank low-energy task higher, got ${lowCandidate.score} <= ${highCandidate.score}.`
  );
  assert(
    lowCandidate.reason.includes('low-energy fit'),
    'Expected low-energy candidate reason to cite low-energy fit.'
  );
  assert(
    highCandidate.reason.includes('defer if drained'),
    'Expected high-energy candidate reason to cite drained-energy deferral.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'evening journal signals change the next generated plan',
    checkinDate,
    planDate,
    sourceCheckinId: payload.plan.source_checkin_id,
    mode: payload.personalization.mode,
    firstSessionTaskId: first.task_id,
    firstSessionMinutes: first.duration_minutes,
    lowCandidateScore: lowCandidate.score,
    highCandidateScore: highCandidate.score,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
