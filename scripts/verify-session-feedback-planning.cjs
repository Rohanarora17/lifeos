#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-session-feedback-'));
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
const { generateNextDayPlan, getNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const planDate = '2030-05-10';
  setSetting('morning_brief_time', '09:00');

  const task = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Read ZK protocol paper', 'todo', 'high', 'research', 'zero knowledge', 'medium', 90, ?
    )
  `).run(planDate);
  const taskId = Number(task.lastInsertRowid);

  db.prepare(`
    INSERT INTO guardian_session_summaries (
      session_id, target_title, goal_title, mood, started_at, duration_minutes, elapsed_minutes,
      average_focus_score, final_focus_score, blocked_count, override_count, distraction_events,
      productive_events, neutral_events, dominant_distraction_domain, completed_at
    ) VALUES (
      'guardian-zk-too-long', 'Read ZK protocol paper', 'ZK learning', 'medium', datetime('now', '-2 days'),
      70, 70, 46, 42, 0, 0, 4, 3, 1, 'youtube.com', datetime('now', '-2 days')
    )
  `).run();
  db.prepare(`
    INSERT INTO session_feedback (
      session_id, raw_text, system_distraction_events, prediction_error_focus,
      session_length_fit, self_awareness_score, processed_at
    ) VALUES (
      'guardian-zk-too-long',
      'This ZK reading block was too long and I drifted. Shorter blocks would work better.',
      'youtube.com drift',
      1,
      'too_long',
      0.8,
      datetime('now', '-2 days')
    )
  `).run();

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '23:30',
    wakeEstimate: '09:00',
    mood: 'medium',
    energy: 'medium',
    eveningNotes: 'Use what yesterday feedback said about session length.',
    tomorrowIntention: 'Read ZK protocol paper',
    selectedTaskIds: [taskId],
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.sessions.length >= 1, 'Expected planner to create a session.');
  const first = payload.sessions[0];
  const rule = JSON.parse(first.rule_json);
  assert(first.task_id === taskId, `Expected planned session to target task ${taskId}, got ${first.task_id}.`);
  assert(first.session_type === 'research_reading', `Expected research_reading session type, got ${first.session_type}.`);
  assert(first.duration_minutes <= 50, `Expected session feedback to shorten the reading block to 50m or less, got ${first.duration_minutes}.`);
  assert(
    rule.guidance.includes('recent Guardian feedback said similar sessions were too long'),
    'Expected session rule guidance to include Guardian feedback reason.'
  );

  const plan = getNextDayPlan(planDate);
  const candidate = plan.candidateTasks.find(row => row.id === taskId);
  assert(candidate, 'Expected task to appear in candidate tasks.');
  assert(
    candidate.reason.includes('session feedback says shorter blocks work better'),
    'Expected candidate reason to cite session feedback.'
  );
  assert(
    candidate.reason.includes('past feedback reported lower focus than expected'),
    'Expected candidate reason to cite focus prediction feedback.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'guardian session feedback shortens later planning blocks',
    planDate,
    taskId,
    plannedMinutes: first.duration_minutes,
    sessionType: first.session_type,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
