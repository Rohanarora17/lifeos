#!/usr/bin/env node

/**
 * Tier B5: trait history snapshots, trends, weekly cognitive question.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-cognitive-hist-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const {
  computeCognitiveTraits,
  getCognitiveTraitHistory,
  selectWeeklyCognitiveQuestion,
} = require('../src/lib/cognitive-traits.ts');

const db = getDb();

// Seed enough pressure-linked sessions
for (let i = 0; i < 6; i++) {
  const due = i < 4 ? 1 : 12;
  const credit = i < 4 ? 1 : 0;
  const t = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
    VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', '-10 days'), 40)
  `).run(`Hist task ${i}`, `${due} days`);
  const id = Number(t.lastInsertRowid);
  db.prepare(`
    INSERT INTO task_session_logs (
      task_id, session_id, session_title, credited_minutes, focus_score, credited_at
    ) VALUES (?, ?, ?, 40, ?, datetime('now', ?))
  `).run(id, `hist-${i}`, `Hist task ${i}`, i < 4 ? 90 : 70, `${credit} days`);
}

// Synthetic multi-day history: PDI falling, voluntary rising = improving
const synthetic = [
  { date: '2030-01-01', pressureDependency: 0.82, voluntaryStartRate: 0.18, activationEnergyDays: 9, crisisBonus: 12, avoidanceAgeDays: 2, confidence: 0.5 },
  { date: '2030-01-02', pressureDependency: 0.78, voluntaryStartRate: 0.22, activationEnergyDays: 8.5, crisisBonus: 11, avoidanceAgeDays: 2, confidence: 0.52 },
  { date: '2030-01-03', pressureDependency: 0.74, voluntaryStartRate: 0.28, activationEnergyDays: 8, crisisBonus: 10, avoidanceAgeDays: 1.5, confidence: 0.55 },
  { date: '2030-01-04', pressureDependency: 0.7, voluntaryStartRate: 0.32, activationEnergyDays: 7.5, crisisBonus: 10, avoidanceAgeDays: 1.5, confidence: 0.58 },
  { date: '2030-01-05', pressureDependency: 0.66, voluntaryStartRate: 0.38, activationEnergyDays: 7, crisisBonus: 9, avoidanceAgeDays: 1, confidence: 0.6 },
];
setSetting('cognitive_trait_history_v1', JSON.stringify(synthetic));

const bundle = computeCognitiveTraits({ windowDays: 45 });
const history = getCognitiveTraitHistory(20);
assert(history.length >= synthetic.length, 'History should retain prior snapshots plus today.');
assert(history.some(h => h.date === synthetic[0].date), 'Oldest synthetic point should remain.');
assert(bundle.history.length >= 2, 'Bundle should expose history for UI.');

const pdi = bundle.traits.find(t => t.id === 'pressure_dependency');
const vol = bundle.traits.find(t => t.id === 'voluntary_start_rate');
assert(pdi, 'PDI trait required.');
assert(vol, 'Voluntary trait required.');
// With synthetic improving history + today's point, trend should prefer improving for lower PDI / higher voluntary
assert(
  pdi.trend === 'improving' || pdi.trend === 'stable' || pdi.trend === 'unknown',
  `Unexpected PDI trend ${pdi.trend}`,
);
assert(
  vol.trend === 'improving' || vol.trend === 'stable' || vol.trend === 'unknown',
  `Unexpected voluntary trend ${vol.trend}`,
);

// If history has clear directional signal, at least one should not be unknown
const directional = [pdi.trend, vol.trend].filter(t => t === 'improving' || t === 'worsening');
assert(directional.length >= 1, `Expected at least one directional trend from multi-day history, got pdi=${pdi.trend} vol=${vol.trend}`);

const question = selectWeeklyCognitiveQuestion(bundle);
assert(typeof question === 'string' && question.length > 20, 'Weekly cognitive question should be non-empty.');
assert(/deadline|start|activation|pressure|voluntary|task/i.test(question), `Question should target wiring: ${question}`);

// Second compute same day should not duplicate history dates
const beforeLen = getCognitiveTraitHistory(30).length;
computeCognitiveTraits({ windowDays: 45 });
const after = getCognitiveTraitHistory(30);
const dates = after.map(h => h.date);
const uniqueDates = new Set(dates);
assert(uniqueDates.size === dates.length, 'History must keep at most one snapshot per day.');
assert(after.length === beforeLen, 'Same-day recompute should overwrite, not append.');

console.log(JSON.stringify({
  ok: true,
  scenario: 'cognitive trait history + weekly question',
  historyPoints: after.length,
  pdiTrend: pdi.trend,
  voluntaryTrend: vol.trend,
  weeklyQuestion: question,
}, null, 2));
