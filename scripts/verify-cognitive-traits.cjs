#!/usr/bin/env node

/**
 * Tier B1: deterministic pressure / activation traits.
 * Seeds a pressure-wired user and a steady starter; asserts relative ordering.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function traitById(bundle, id) {
  return bundle.traits.find(t => t.id === id);
}

function seedPressureWired(db) {
  // days_until_due ≈ dueOffset - creditOffset
  // near ≤2, far ≥7. Crisis focus high; calm focus lower.
  const specs = [
    { title: 'Crisis paper draft', dueOffset: 0, createOffset: -14, creditOffset: 0, focus: 90, minutes: 50 },
    { title: 'Assignment dump', dueOffset: 1, createOffset: -12, creditOffset: 1, focus: 92, minutes: 60 },
    { title: 'Last-minute review', dueOffset: 2, createOffset: -15, creditOffset: 1, focus: 88, minutes: 45 },
    { title: 'Overdue cleanup', dueOffset: -2, createOffset: -20, creditOffset: 0, focus: 86, minutes: 40 },
    { title: 'Near deadline code', dueOffset: 0, createOffset: -11, creditOffset: -1, focus: 89, minutes: 55 },
    // Calm baselines (far from due) with weaker focus — minority of starts
    { title: 'Rare early outline', dueOffset: 14, createOffset: -1, creditOffset: 0, focus: 68, minutes: 30 },
    { title: 'Occasional buffer work', dueOffset: 12, createOffset: -2, creditOffset: -1, focus: 70, minutes: 25 },
  ];

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', ?), ?)
    `).run(
      s.title,
      `${s.dueOffset} days`,
      `${s.createOffset} days`,
      s.minutes,
    );
    const taskId = Number(task.lastInsertRowid);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `).run(
      taskId,
      `pressure-session-${i}`,
      s.title,
      s.minutes,
      s.focus,
      `${s.creditOffset} days`,
    );
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, mood, started_at, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at
      ) VALUES (?, ?, 'medium', datetime('now', ?), ?, ?, ?, ?, datetime('now', ?))
    `).run(
      `pressure-session-${i}`,
      s.title,
      `${s.creditOffset} days`,
      s.minutes,
      s.minutes,
      s.focus,
      s.focus,
      `${s.creditOffset} days`,
    );
  }
}

function seedSteadyStarter(db) {
  // Mostly far-from-deadline starts (dueOffset - creditOffset ≥ 7)
  const specs = [
    { title: 'Early outline', dueOffset: 14, createOffset: -1, creditOffset: 0, focus: 80, minutes: 45 },
    { title: 'Planned study block', dueOffset: 12, createOffset: -1, creditOffset: -1, focus: 82, minutes: 50 },
    { title: 'Steady coding', dueOffset: 15, createOffset: 0, creditOffset: 0, focus: 81, minutes: 55 },
    { title: 'Week-ahead reading', dueOffset: 10, createOffset: -2, creditOffset: -2, focus: 79, minutes: 40 },
    { title: 'Buffered writeup', dueOffset: 11, createOffset: -1, creditOffset: 0, focus: 78, minutes: 35 },
    { title: 'Spaced review', dueOffset: 9, createOffset: 0, creditOffset: 0, focus: 77, minutes: 30 },
    // One crisis start as noise
    { title: 'Unexpected fire drill', dueOffset: 1, createOffset: -5, creditOffset: 1, focus: 72, minutes: 30 },
  ];

  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'medium', 'study', date('now', ?), datetime('now', ?), ?)
    `).run(
      s.title,
      `${s.dueOffset} days`,
      `${s.createOffset} days`,
      s.minutes,
    );
    const taskId = Number(task.lastInsertRowid);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `).run(
      taskId,
      `steady-session-${i}`,
      s.title,
      s.minutes,
      s.focus,
      `${s.creditOffset} days`,
    );
  }
}

function runProfile(label, seeder) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `lifeos-cognitive-${label}-`));
  const dbPath = path.join(tempDir, 'lifeos.db');
  process.env.LIFEOS_DB_PATH = dbPath;
  process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

  // Clear module cache so getDb picks up new path
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}lib${path.sep}`) || key.includes(`${path.sep}scripts${path.sep}`)) {
      // keep register-ts; drop lib modules bound to prior db
      if (key.includes(`${path.sep}src${path.sep}lib${path.sep}`)) delete require.cache[key];
    }
  }

  registerTypescript(root);
  const { getDb } = require('../src/lib/db.ts');
  const { computeCognitiveTraits } = require('../src/lib/cognitive-traits.ts');
  const { buildPersonalizationSnapshot } = require('../src/lib/personalization-context.ts');
  const { getIntelligenceProfile } = require('../src/lib/intelligence.ts');
  const { buildSelfModel } = require('../src/lib/self-model.ts');

  const db = getDb();
  seeder(db);

  const traits = computeCognitiveTraits({ windowDays: 45 });
  const snapshot = buildPersonalizationSnapshot({ surface: 'self_model' });
  const profile = getIntelligenceProfile();
  const selfModel = buildSelfModel({
    snapshot,
    profile,
    feedbackFacts: [],
    cognitiveTraits: traits,
  });

  return { traits, selfModel, dbPath };
}

function main() {
  const pressure = runProfile('pressure', seedPressureWired);
  const steady = runProfile('steady', seedSteadyStarter);

  const pPdi = traitById(pressure.traits, 'pressure_dependency');
  const sPdi = traitById(steady.traits, 'pressure_dependency');
  const pVol = traitById(pressure.traits, 'voluntary_start_rate');
  const sVol = traitById(steady.traits, 'voluntary_start_rate');
  const pAct = traitById(pressure.traits, 'activation_energy');
  const pAvoid = traitById(pressure.traits, 'avoidance_age');
  const pCrisis = traitById(pressure.traits, 'crisis_performance_bonus');

  assert(pPdi && pPdi.value != null, 'Pressure-wired profile must produce a PDI value.');
  assert(sPdi && sPdi.value != null, 'Steady profile must produce a PDI value.');
  assert(pPdi.value > sPdi.value, `Expected pressure PDI (${pPdi.value}) > steady PDI (${sPdi.value}).`);
  assert(pPdi.value >= 0.55, `Expected high pressure PDI, got ${pPdi.value}.`);
  assert(sPdi.value <= 0.55, `Expected lower steady PDI, got ${sPdi.value}.`);

  assert(pVol && pVol.value != null, 'Pressure profile needs voluntary start rate.');
  assert(sVol && sVol.value != null, 'Steady profile needs voluntary start rate.');
  assert(sVol.value > pVol.value, `Expected steady voluntary rate (${sVol.value}) > pressure (${pVol.value}).`);

  assert(pAct && pAct.value != null && pAct.value >= 3, `Expected high activation lag for pressure user, got ${pAct?.value}.`);
  assert(pAvoid && pAvoid.value != null && pAvoid.value > 0, 'Expected overdue avoidance age for pressure-wired seeds.');
  assert(pCrisis && pCrisis.value != null, 'Expected crisis bonus computation for pressure-wired seeds.');
  assert(pCrisis.value > 0, `Expected positive crisis focus bonus, got ${pCrisis.value}.`);

  assert(pPdi.confidence > 0, 'PDI confidence should be positive with samples.');
  assert(pPdi.evidence.length >= 2, 'PDI should carry evidence.');
  assert(
    pressure.selfModel.beliefs.some(b => b.id === 'cognitive_pressure_dependency'),
    'Self-model should include pressure dependency belief.',
  );
  assert(
    pressure.selfModel.cognitiveTraits.pressureProfile.pressureDependency != null,
    'Self-model should expose pressureProfile.',
  );
  assert(
    /pressure|crisis|deadline|voluntary/i.test(pressure.selfModel.summary),
    `Self-model summary should mention cognitive wiring, got: ${pressure.selfModel.summary}`,
  );

  console.log(JSON.stringify({
    ok: true,
    scenario: 'pressure-wired vs steady-starter cognitive traits',
    pressure: {
      pdi: pPdi.value,
      voluntary: pVol.value,
      activationDays: pAct.value,
      avoidanceDays: pAvoid.value,
      crisisBonus: pCrisis.value,
      confidence: pressure.traits.pressureProfile.confidence,
      summary: pressure.traits.summary,
    },
    steady: {
      pdi: sPdi.value,
      voluntary: sVol.value,
      confidence: steady.traits.pressureProfile.confidence,
    },
  }, null, 2));
}

main();
