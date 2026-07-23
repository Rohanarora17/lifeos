#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-task-time-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const { getDb } = require('../src/lib/db.ts');
const {
  creditSessionTimeToTasks,
  getTaskTimeProgress,
} = require('../src/lib/task-time-sessions.ts');

const db = getDb();

const task = db.prepare(`
  INSERT INTO tasks (title, status, priority, task_type, course, estimated_minutes)
  VALUES ('Study zks', 'todo', 'high', 'study', 'zk systems', 120)
`).run();
const taskId = Number(task.lastInsertRowid);

const firstCredit = creditSessionTimeToTasks({
  sessionId: 'focus-zks-1',
  topic: 'study zks',
  elapsedMinutes: 45,
  avgFocusScore: 82,
});
const afterFirst = getTaskTimeProgress(taskId);
const statusAfterFirst = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);

assert(firstCredit.length === 1, 'Expected the first focus session to match the ZK task.');
assert(afterFirst.creditedMinutes === 45, `Expected 45 credited minutes, got ${afterFirst.creditedMinutes}.`);
assert(afterFirst.remainingMinutes === 75, `Expected 75 remaining minutes, got ${afterFirst.remainingMinutes}.`);
assert(statusAfterFirst.status !== 'done', 'Task should not complete before the 120 minute target.');

const secondCredit = creditSessionTimeToTasks({
  sessionId: 'focus-zks-2',
  topic: 'study zks',
  elapsedMinutes: 75,
  avgFocusScore: 88,
});
const afterSecond = getTaskTimeProgress(taskId);
const completedTask = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId);
const linkedSessions = db.prepare(`
  SELECT session_id, credited_minutes, auto_completed
  FROM task_session_logs
  WHERE task_id = ?
  ORDER BY session_id ASC
`).all(taskId);
const completionReview = db.prepare(`
  SELECT status, completion_note
  FROM session_completions
  WHERE task_id = ? AND session_id = 'focus-zks-2'
`).get(taskId);
const ledgerRows = db.prepare('SELECT amount, reason FROM coin_ledger ORDER BY id ASC').all();

assert(secondCredit.length === 1, 'Expected the second focus session to match the ZK task.');
assert(secondCredit[0].completed === true, 'Expected the task to complete on the second focus session.');
assert(afterSecond.creditedMinutes === 120, `Expected 120 credited minutes, got ${afterSecond.creditedMinutes}.`);
assert(afterSecond.remainingMinutes === 0, `Expected 0 remaining minutes, got ${afterSecond.remainingMinutes}.`);
assert(afterSecond.percent === 100, `Expected 100 percent progress, got ${afterSecond.percent}.`);
assert(completedTask.status === 'done', `Expected completed task status, got ${completedTask.status}.`);
assert(Boolean(completedTask.completed_at), 'Expected completed_at to be populated.');
assert(linkedSessions.length === 2, `Expected 2 linked sessions, got ${linkedSessions.length}.`);
assert(linkedSessions[0].credited_minutes === 45, 'Expected first linked session to preserve 45 credited minutes.');
assert(linkedSessions[1].credited_minutes === 75, 'Expected second linked session to preserve 75 credited minutes.');
assert(linkedSessions[1].auto_completed === 1, 'Expected final linked session to be marked as auto-completing.');
assert(completionReview.status === 'done', 'Expected completion review to be marked done.');
assert(completionReview.completion_note.includes('120/120'), 'Expected completion review to record accumulated minutes.');
assert(ledgerRows.length === 1, `Expected one coin ledger row, got ${ledgerRows.length}.`);
assert(ledgerRows[0].amount > 0, 'Expected a positive adaptive coin reward.');
assert(ledgerRows[0].reason.includes('Study zks'), 'Expected ledger reason to mention the completed task.');

console.log(JSON.stringify({
  ok: true,
  dbPath,
  scenario: 'time-target task completes from accumulated linked focus sessions',
  taskId,
  creditedMinutes: afterSecond.creditedMinutes,
  linkedSessions: linkedSessions.length,
  rewardCoins: ledgerRows[0].amount,
}, null, 2));
