#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-planned-session-flow-'));
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

const { getDb } = require('../src/lib/db.ts');
const {
  createSoftWatchCommitment,
  endGuardianSession,
  startGuardianSession,
} = require('../src/lib/guardian-runtime.ts');
const { getTaskTimeProgress } = require('../src/lib/task-time-sessions.ts');

async function main() {
  const db = getDb();
  const originalDateNow = Date.now;
  const baseNow = originalDateNow();
  const planDate = todayIst();

  const taskResult = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, course, estimated_minutes)
    VALUES ('Study ZK proofs', 'todo', 'high', 'study', 'zero knowledge', 50)
  `).run();
  const taskId = Number(taskResult.lastInsertRowid);

  const planResult = db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, tomorrow_intention, status)
    VALUES (?, '00:30', '09:30', 'medium', 'high', 'Finish ZK proof study', 'active')
  `).run(planDate);
  const planId = Number(planResult.lastInsertRowid);

  const softWatch = createSoftWatchCommitment({
    targetTitle: 'Study ZK proofs',
    taskId,
    intendedStartAt: baseNow - 60_000,
    plannedMinutes: 50,
    source: 'calendar',
  });

  db.prepare(`
    INSERT INTO planned_focus_sessions (
      id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
      session_type, rule_json, reward_xp, reward_coins, soft_watch_id, status
    ) VALUES (
      'planned-session-flow', ?, ?, 'Study ZK proofs', ?, ?, 50,
      'study', '{}', 50, 25, ?, 'planned'
    )
  `).run(
    planId,
    taskId,
    new Date(baseNow - 60_000).toISOString(),
    new Date(baseNow + 49 * 60_000).toISOString(),
    softWatch.id
  );

  const started = startGuardianSession({
    topic: 'Study ZK proofs',
    durationMinutes: 50,
    mood: 'medium',
  });
  assert(started?.sessionId, 'Expected guardian session to start.');

  const locked = db.prepare(`
    SELECT status, locked_in_session_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(softWatch.id);
  assert(locked.status === 'locked_in', `Expected soft watch locked_in, got ${locked.status}.`);
  assert(locked.locked_in_session_id === started.sessionId, 'Expected soft watch to lock to the started Guardian session.');

  Date.now = () => baseNow + 50 * 60_000;
  try {
    const ended = endGuardianSession(started.sessionId);
    assert(ended?.state === 'COMPLETE', `Expected completed Guardian session, got ${ended?.state}.`);
  } finally {
    Date.now = originalDateNow;
  }

  const planned = db.prepare(`
    SELECT status
    FROM planned_focus_sessions
    WHERE id = 'planned-session-flow'
  `).get();
  assert(planned.status === 'completed', `Expected planned focus session completed, got ${planned.status}.`);

  const completedTask = await waitFor(() => {
    const row = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId);
    return row.status === 'done' ? row : null;
  }, 'Expected linked task to complete from the planned Guardian session.');

  const progress = getTaskTimeProgress(taskId);
  const linkedLog = db.prepare(`
    SELECT credited_minutes, auto_completed
    FROM task_session_logs
    WHERE task_id = ? AND session_id = ?
  `).get(taskId, started.sessionId);
  const completionReview = db.prepare(`
    SELECT status, completion_note
    FROM session_completions
    WHERE task_id = ? AND session_id = ?
  `).get(taskId, started.sessionId);

  assert(progress.creditedMinutes === 50, `Expected 50 credited minutes, got ${progress.creditedMinutes}.`);
  assert(progress.remainingMinutes === 0, `Expected 0 remaining minutes, got ${progress.remainingMinutes}.`);
  assert(linkedLog.credited_minutes === 50, `Expected linked session log to credit 50m, got ${linkedLog.credited_minutes}.`);
  assert(linkedLog.auto_completed === 1, 'Expected linked session log to mark auto completion.');
  assert(completionReview.status === 'done', `Expected completion review done, got ${completionReview.status}.`);
  assert(completionReview.completion_note.includes('50/50'), 'Expected completion review to record 50/50 linked minutes.');
  assert(Boolean(completedTask.completed_at), 'Expected completed task timestamp.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'planned Guardian session starts, completes, and finishes its linked time-target task',
    plannedSessionStatus: planned.status,
    taskStatus: completedTask.status,
    creditedMinutes: progress.creditedMinutes,
    guardianSessionId: started.sessionId,
  }, null, 2));

  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
