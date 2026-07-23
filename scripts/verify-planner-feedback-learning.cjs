#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-planner-feedback-'));
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
const { recordTaskRecommendationFeedback } = require('../src/lib/adaptive-task-recommendations.ts');
const { generateNextDayPlan, getNextDayPlan } = require('../src/lib/next-day-planner.ts');

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

async function main() {
  const db = getDb();
  const planDate = '2030-04-08';
  setSetting('morning_brief_time', '09:00');

  const rejectedTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Archive generic inbox backlog', 'todo', 'high', 'admin', 'life admin', 'medium', 45, ?, 1
    )
  `).run(planDate);
  const reinforcedTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Read ZK proof notes', 'todo', 'high', 'research', 'zero knowledge', 'medium', 45, ?, 2
    )
  `).run(planDate);

  const rejectedTaskId = Number(rejectedTask.lastInsertRowid);
  const reinforcedTaskId = Number(reinforcedTask.lastInsertRowid);

  db.prepare(`
    INSERT INTO calendar_events (id, title, description, start_time, end_time, location)
    VALUES ('calendar_busy_feedback_window', 'Existing afternoon commitments', 'Force planner to choose one feedback-shaped block', ?, ?, 'Calendar')
  `).run(
    istDate(planDate, '10:20').toISOString(),
    istDate(planDate, '23:00').toISOString()
  );

  recordTaskRecommendationFeedback({
    taskId: rejectedTaskId,
    feedback: 'wrong',
    surface: 'dashboard',
    reason: 'This was the wrong task for a planning day.',
  });
  recordTaskRecommendationFeedback({
    taskId: rejectedTaskId,
    feedback: 'not_now',
    surface: 'dashboard',
    reason: 'Do not schedule inbox cleanup before study.',
  });
  recordTaskRecommendationFeedback({
    taskId: reinforcedTaskId,
    feedback: 'started',
    surface: 'dashboard',
    reason: 'This is exactly the kind of study block I wanted.',
  });
  recordTaskRecommendationFeedback({
    taskId: reinforcedTaskId,
    feedback: 'completed',
    surface: 'dashboard',
    reason: 'This recommendation led to useful work.',
  });

  const feedbackRows = db.prepare('SELECT task_id, feedback FROM task_recommendation_feedback ORDER BY id ASC').all();
  assert(feedbackRows.length === 4, `Expected 4 task feedback rows, got ${feedbackRows.length}.`);

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '23:00',
    wakeEstimate: '09:00',
    mood: 'medium',
    energy: 'medium',
    eveningNotes: 'Tomorrow should prefer recommendations that actually worked.',
    tomorrowIntention: 'Plan useful focus work',
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.sessions.length >= 1, 'Expected planner to create at least one session.');
  assert(payload.sessions[0].task_id === reinforcedTaskId, `Expected reinforced task first, got ${payload.sessions[0].task_id}.`);
  assert(!payload.sessions.some(session => session.task_id === rejectedTaskId), 'Expected rejected task not to receive a planned session.');

  const plan = getNextDayPlan(planDate);
  const reinforcedCandidate = plan.candidateTasks.find(task => task.id === reinforcedTaskId);
  const rejectedCandidate = plan.candidateTasks.find(task => task.id === rejectedTaskId);
  assert(reinforcedCandidate, 'Expected reinforced task to remain in candidate list.');
  assert(rejectedCandidate, 'Expected rejected task to remain visible for review, even if not scheduled.');
  assert(
    reinforcedCandidate.score > rejectedCandidate.score,
    `Expected feedback to rank reinforced task above rejected task, got ${reinforcedCandidate.score} <= ${rejectedCandidate.score}.`
  );
  assert(
    reinforcedCandidate.reason.includes('previous feedback says this task fits'),
    'Expected reinforced candidate reason to cite positive feedback.'
  );
  assert(
    rejectedCandidate.reason.includes('previously marked wrong fit') || rejectedCandidate.reason.includes('previously deferred'),
    'Expected rejected candidate reason to cite negative feedback.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'task recommendation feedback changes later planning choices',
    planDate,
    firstSessionTaskId: payload.sessions[0].task_id,
    reinforcedScore: reinforcedCandidate.score,
    rejectedScore: rejectedCandidate.score,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
