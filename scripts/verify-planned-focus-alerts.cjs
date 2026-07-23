#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-planned-focus-alerts-'));
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

function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const { getDb } = require('../src/lib/db.ts');
const { sendAlert } = require('../src/lib/notifications.ts');

async function main() {
  const db = getDb();
  const planDate = todayIst();

  const taskResult = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, estimated_minutes)
    VALUES ('Study ZK proofs', 'todo', 'high', 'study', 60)
  `).run();
  const taskId = Number(taskResult.lastInsertRowid);

  const planResult = db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, tomorrow_intention, status)
    VALUES (?, '00:30', '09:30', 'medium', 'high', 'Protect ZK study block', 'active')
  `).run(planDate);
  const planId = Number(planResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO planned_focus_sessions (
      id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
      session_type, rule_json, reward_xp, reward_coins, status
    ) VALUES (
      'planned-focus-alert-test', ?, ?, 'Study ZK proofs', ?, ?, 50,
      'study', '{}', 40, 20, 'planned'
    )
  `).run(planId, taskId, isoMinutesFromNow(-5), isoMinutesFromNow(45));

  const routineSuppressed = await sendAlert(
    'habit_streak',
    'Routine habit nudge',
    'info',
    { key: 'habit_during_planned_focus', skipAiRewrite: true }
  );
  assert(routineSuppressed === false, 'Expected routine habit alert to suppress during planned focus.');
  const routineRow = db.prepare('SELECT * FROM alerts WHERE type = ?').get('habit_during_planned_focus');
  assert(!routineRow, 'Expected suppressed routine alert not to create an alert row.');

  const taskSent = await sendAlert(
    'task_reminder',
    'Time to study ZK proofs.',
    'warning',
    {
      key: 'zk_task_planned_focus_link',
      skipAiRewrite: true,
      context: { taskId, title: 'Study ZK proofs' },
    }
  );
  assert(taskSent === true, 'Expected task-specific warning to still send.');
  const taskRow = db.prepare('SELECT * FROM alerts WHERE type = ?').get('zk_task_planned_focus_link');
  assert(taskRow, 'Expected planned task reminder alert row.');
  assert(
    taskRow.message.includes("already on today's focus plan"),
    'Expected task reminder to mention the existing planned focus block.'
  );
  assert(
    taskRow.adaptive_reason.includes('linked task reminder to planned focus session'),
    'Expected adaptive reason to explain planned-focus linking.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'notifications respect active planned focus sessions',
    routineSuppressed,
    taskSeverity: taskRow.severity,
    taskReason: taskRow.adaptive_reason,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
