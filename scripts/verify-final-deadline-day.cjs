#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-deadline-day-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function todayIst() {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const { runAlertEngine } = require('../src/lib/notifications.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const planDate = todayIst();
  const overdueDate = addDays(planDate, -1);
  setSetting('morning_brief_time', '08:30');

  const pressureTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, due_time
    ) VALUES (
      'Submit ZK assignment', 'todo', 'critical', 'assignment', 'zero knowledge', 'high', 80, ?, '18:00'
    )
  `).run(overdueDate);
  const optionalTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Organize study notes', 'todo', 'low', 'task', 'general', 'low', 30, ?
    )
  `).run(addDays(planDate, 7));
  const pressureTaskId = Number(pressureTask.lastInsertRowid);
  const optionalTaskId = Number(optionalTask.lastInsertRowid);

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '23:30',
    wakeEstimate: '08:30',
    mood: 'medium',
    energy: 'high',
    eveningNotes: 'Deadline pressure day: overdue assignment needs relief before optional cleanup.',
    tomorrowIntention: 'Submit ZK assignment first, optional notes only after deadline relief',
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.plan, 'Expected deadline-day plan to be created.');
  assert(payload.personalization.mode === 'deadline_pressure', `Expected deadline_pressure mode, got ${payload.personalization.mode}.`);
  assert(payload.sessions.length >= 1, 'Expected at least one deadline-relief planned session.');

  const first = payload.sessions[0];
  const rule = JSON.parse(first.rule_json);
  assert(first.task_id === pressureTaskId, `Expected overdue critical task first, got ${first.task_id}.`);
  assert(first.task_id !== optionalTaskId, 'Expected optional low-priority task not to be first.');
  assert(first.duration_minutes >= 45, `Expected deadline block to preserve a substantial work block, got ${first.duration_minutes}m.`);
  assert(
    rule.rewardReason.includes('deadline-pressure day rewards concrete task progress'),
    'Expected XP reward reason to cite deadline-pressure task progress.'
  );
  assert(
    rule.rewardReason.includes('deadline pressure is active'),
    'Expected coin reward reason to cite active deadline pressure.'
  );

  const pressureCandidate = payload.candidateTasks.find(task => task.id === pressureTaskId);
  const optionalCandidate = payload.candidateTasks.find(task => task.id === optionalTaskId);
  assert(pressureCandidate, 'Expected pressure task candidate.');
  assert(optionalCandidate, 'Expected optional task candidate.');
  assert(pressureCandidate.reason.includes('due soon'), 'Expected pressure candidate to cite due soon.');
  assert(pressureCandidate.score > optionalCandidate.score, 'Expected pressure task to outrank optional task.');

  const alertResult = await runAlertEngine();
  const expectedAlertKey = `task_deadline_${pressureTaskId}_overdue`;
  assert(
    alertResult.triggered.includes(expectedAlertKey),
    `Expected alert engine to trigger ${expectedAlertKey}, got ${alertResult.triggered.join(', ')}.`
  );

  const alert = db.prepare('SELECT type, message, severity, adaptive_reason FROM alerts WHERE type = ?').get(expectedAlertKey);
  assert(alert, 'Expected overdue task alert row.');
  assert(alert.severity === 'urgent', `Expected urgent overdue alert, got ${alert.severity}.`);
  assert(alert.message.includes('Submit ZK assignment'), 'Expected alert message to name the overdue task.');
  assert(alert.adaptive_reason.includes('task is overdue'), 'Expected alert reason to cite overdue task.');
  assert(
    alert.adaptive_reason.includes('linked task reminder to planned focus session'),
    'Expected alert reason to link the reminder to the planned focus session.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'deadline day prioritizes overdue work and keeps protective reminders visible',
    planDate,
    firstSessionTitle: first.title,
    firstSessionMinutes: first.duration_minutes,
    alertType: alert.type,
    alertSeverity: alert.severity,
    rewardReason: rule.rewardReason,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
