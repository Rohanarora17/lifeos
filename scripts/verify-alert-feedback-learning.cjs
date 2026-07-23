#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-alert-feedback-'));
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
const { recordAlertFeedback, sendAlert } = require('../src/lib/notifications.ts');
const { buildAdaptiveAlertCenterPolicy } = require('../src/lib/adaptive-alert-policy.ts');
const { buildPersonalizationSnapshot } = require('../src/lib/personalization-context.ts');

async function sendSeedAlert(type, severity, key, message) {
  const sent = await sendAlert(type, message, severity, { key, skipAiRewrite: true });
  assert(sent === true, `Expected seed alert ${key} to send.`);
  const alert = getDb().prepare('SELECT * FROM alerts WHERE type = ?').get(key);
  assert(alert, `Expected alert row for ${key}.`);
  return alert;
}

async function main() {
  const db = getDb();

  for (let index = 0; index < 3; index += 1) {
    const alert = await sendSeedAlert(
      'task_reminder',
      'warning',
      `task_reminder_seed_${index}`,
      `Study reminder seed ${index}`
    );
    const updated = recordAlertFeedback(alert.id, 'not_helpful', 'This reminder interrupted the wrong time.');
    assert(updated.feedback === 'not_helpful', 'Expected not-helpful alert feedback to persist.');
  }

  const softenedSent = await sendAlert(
    'task_reminder',
    'Study zks now',
    'warning',
    { key: 'task_reminder_after_negative_feedback', skipAiRewrite: true }
  );
  assert(softenedSent === true, 'Expected warning alert to still send after negative feedback, but softened.');
  const softened = db.prepare('SELECT * FROM alerts WHERE type = ?').get('task_reminder_after_negative_feedback');
  assert(softened.severity === 'info', `Expected learned task reminder severity info, got ${softened.severity}.`);
  assert(
    softened.adaptive_reason.includes('softened because recent task_reminder alerts were rarely useful'),
    'Expected adaptive reason to mention learned softening from weak feedback.'
  );
  assert(
    softened.adaptive_reason.includes('extended dedup from past alert feedback'),
    'Expected adaptive reason to mention extended dedup from alert feedback.'
  );

  const taskOutcomes = db.prepare(`
    SELECT helpful, actual_outcome, was_corrected, correction_text
    FROM agent_action_outcomes
    WHERE action_type = 'alert:task_reminder'
      AND actual_outcome LIKE '%"source":"alert_feedback"%'
  `).all();
  assert(taskOutcomes.length === 3, `Expected 3 rated task reminder outcomes, got ${taskOutcomes.length}.`);
  assert(taskOutcomes.every(row => row.helpful === 0), 'Expected not-helpful alert feedback to update outcome helpful flags.');
  assert(taskOutcomes.every(row => row.was_corrected === 1), 'Expected not-helpful alert feedback to mark outcomes corrected.');
  assert(taskOutcomes.every(row => row.correction_text.includes('interrupted')), 'Expected correction text to preserve user reason.');

  db.prepare(`
    UPDATE alerts
    SET created_at = datetime('now', '-3 hours')
    WHERE type LIKE 'task_reminder_%'
  `).run();

  for (let index = 0; index < 3; index += 1) {
    const alert = await sendSeedAlert(
      'habit_streak',
      'info',
      `habit_streak_seed_${index}`,
      `Habit streak seed ${index}`
    );
    const updated = recordAlertFeedback(alert.id, 'dismissed', 'Habit nudges are not useful today.');
    assert(updated.feedback === 'dismissed', 'Expected dismissed alert feedback to persist.');
  }

  const suppressed = await sendAlert(
    'habit_streak',
    'Keep the streak alive',
    'info',
    { key: 'habit_streak_after_dismissals', skipAiRewrite: true }
  );
  assert(suppressed === false, 'Expected repeated dismissed habit alerts to suppress the next info alert.');
  const suppressedRow = db.prepare('SELECT * FROM alerts WHERE type = ?').get('habit_streak_after_dismissals');
  assert(!suppressedRow, 'Expected suppressed alert to avoid inserting an alert row.');

  const rawAlerts = db.prepare('SELECT * FROM alerts ORDER BY id ASC').all();
  const snapshot = buildPersonalizationSnapshot({
    surface: 'notification',
    maxInsights: 2,
    includeMemoryFacts: 2,
  });
  const { visibleAlerts, policy } = buildAdaptiveAlertCenterPolicy(rawAlerts, snapshot);
  assert(policy.learnedQuietedCount >= 3, `Expected alert center to quiet learned-dismissed alerts, got ${policy.learnedQuietedCount}.`);
  assert(
    policy.reason.includes('quieted from your feedback'),
    'Expected alert center policy reason to name user feedback as the quieting source.'
  );
  assert(
    visibleAlerts.every(alert => !alert.type.startsWith('habit_streak_seed_')),
    'Expected dismissed habit alert family to be hidden from visible alerts.'
  );

  const learningEpisodes = db.prepare(`
    SELECT summary, raw_context
    FROM mem_episodes
    WHERE raw_context LIKE '%"source":"alert"%'
    ORDER BY id ASC
  `).all();
  assert(learningEpisodes.length === 6, `Expected 6 alert feedback memory episodes, got ${learningEpisodes.length}.`);

  const learningFacts = db.prepare(`
    SELECT topic, content, source, confirmed_count
    FROM mem_facts
    WHERE source = 'feedback_learning'
      AND topic IN ('alert_not_helpful', 'alert_timing')
    ORDER BY topic ASC
  `).all();
  assert(learningFacts.length === 2, `Expected 2 distilled alert feedback facts, got ${learningFacts.length}.`);
  assert(learningFacts.every(row => row.confirmed_count >= 3), 'Expected repeated feedback to reinforce memory facts.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'alert feedback changes later notification decisions',
    softenedSeverity: softened.severity,
    learnedQuietedCount: policy.learnedQuietedCount,
    feedbackEpisodes: learningEpisodes.length,
    feedbackFacts: learningFacts.length,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
