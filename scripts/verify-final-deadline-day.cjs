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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 6_000) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  while (((globalThis.performance?.now?.() ?? Date.now()) - started) < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(message);
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
const {
  endGuardianSession,
  startGuardianSession,
} = require('../src/lib/guardian-runtime.ts');
const { getTaskTimeProgress } = require('../src/lib/task-time-sessions.ts');

async function main() {
  const db = getDb();
  const planDate = todayIst();
  const overdueDate = addDays(planDate, -1);
  setSetting('morning_brief_time', '08:30');

  const pressureTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, due_time
    ) VALUES (
      'Submit ZK assignment', 'todo', 'critical', 'assignment', 'zero knowledge', 'high', 60, ?, '18:00'
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

  const originalDateNow = Date.now;
  const sessionStartMs = new Date(first.planned_start).getTime();
  Date.now = () => sessionStartMs;
  let started;
  try {
    started = startGuardianSession({
      topic: first.title,
      durationMinutes: first.duration_minutes,
      mood: 'medium',
    });
  } finally {
    Date.now = originalDateNow;
  }
  assert(started?.sessionId, 'Expected deadline Guardian session to start.');

  const locked = db.prepare(`
    SELECT status, locked_in_session_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(first.soft_watch_id);
  assert(locked.status === 'locked_in', `Expected deadline soft watch locked_in, got ${locked.status}.`);
  assert(locked.locked_in_session_id === started.sessionId, 'Expected deadline soft watch to lock to the started session.');

  Date.now = () => sessionStartMs + first.duration_minutes * 60_000;
  try {
    const ended = endGuardianSession(started.sessionId);
    assert(ended?.state === 'COMPLETE', `Expected deadline Guardian session complete, got ${ended?.state}.`);
  } finally {
    Date.now = originalDateNow;
  }

  const completedSession = db.prepare(`
    SELECT status
    FROM planned_focus_sessions
    WHERE id = ?
  `).get(first.id);
  assert(completedSession.status === 'completed', `Expected deadline planned session completed, got ${completedSession.status}.`);

  const completedTask = await waitFor(() => {
    const row = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(pressureTaskId);
    return row.status === 'done' ? row : null;
  }, 'Expected deadline focus minutes to complete the linked task.');
  const progress = getTaskTimeProgress(pressureTaskId);
  assert(progress.creditedMinutes === first.duration_minutes, `Expected ${first.duration_minutes} credited minutes, got ${progress.creditedMinutes}.`);
  assert(progress.remainingMinutes === 0, `Expected no remaining deadline task minutes, got ${progress.remainingMinutes}.`);
  assert(Boolean(completedTask.completed_at), 'Expected deadline task completion timestamp.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'deadline day prioritizes overdue work, keeps protective reminders visible, and completes linked time',
    planDate,
    firstSessionTitle: first.title,
    firstSessionMinutes: first.duration_minutes,
    alertType: alert.type,
    alertSeverity: alert.severity,
    rewardReason: rule.rewardReason,
    creditedMinutes: progress.creditedMinutes,
    taskStatus: completedTask.status,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
