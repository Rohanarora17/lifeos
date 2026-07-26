#!/usr/bin/env node

/**
 * Tier B2: confirm / dispute trait stance promotes memory and changes prompt context.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-cognitive-stance-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { getDb } = require('../src/lib/db.ts');
const {
  computeCognitiveTraits,
  setCognitiveTraitStance,
  formatCognitiveTraitsForPrompt,
} = require('../src/lib/cognitive-traits.ts');
const { formatPersonalizationContext, buildPersonalizationSnapshot } = require('../src/lib/personalization-context.ts');

const db = getDb();

// Pressure-wired seeds
const specs = [
  { title: 'Crisis paper draft', dueOffset: 0, createOffset: -14, creditOffset: 0, focus: 90, minutes: 50 },
  { title: 'Assignment dump', dueOffset: 1, createOffset: -12, creditOffset: 1, focus: 92, minutes: 60 },
  { title: 'Last-minute review', dueOffset: 2, createOffset: -15, creditOffset: 1, focus: 88, minutes: 45 },
  { title: 'Overdue cleanup', dueOffset: -2, createOffset: -20, creditOffset: 0, focus: 86, minutes: 40 },
  { title: 'Near deadline code', dueOffset: 0, createOffset: -11, creditOffset: -1, focus: 89, minutes: 55 },
  { title: 'Rare early outline', dueOffset: 14, createOffset: -1, creditOffset: 0, focus: 68, minutes: 30 },
  { title: 'Occasional buffer work', dueOffset: 12, createOffset: -2, creditOffset: -1, focus: 70, minutes: 25 },
];

for (let i = 0; i < specs.length; i++) {
  const s = specs[i];
  const task = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
    VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', ?), ?)
  `).run(s.title, `${s.dueOffset} days`, `${s.createOffset} days`, s.minutes);
  const taskId = Number(task.lastInsertRowid);
  db.prepare(`
    INSERT INTO task_session_logs (
      task_id, session_id, session_title, credited_minutes, focus_score, credited_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
  `).run(taskId, `stance-session-${i}`, s.title, s.minutes, s.focus, `${s.creditOffset} days`);
}

const before = computeCognitiveTraits({ windowDays: 45 });
const pdiBefore = before.traits.find(t => t.id === 'pressure_dependency');
assert(pdiBefore && pdiBefore.value != null && pdiBefore.value >= 0.55, 'Seed should look pressure-wired.');
assert(pdiBefore.userStance === 'observed', 'Default stance should be observed.');
assert(before.hypotheses.some(h => h.traitId === 'pressure_dependency'), 'Expected open pressure hypothesis.');

const confirmed = setCognitiveTraitStance({
  traitId: 'pressure_dependency',
  stance: 'confirmed',
  note: 'I only really start hard work under deadline heat.',
});
assert(confirmed.stance === 'confirmed', 'Confirm should stick.');
assert(confirmed.trait.userStance === 'confirmed', 'Trait should carry confirmed stance.');
assert(confirmed.trait.confidence >= pdiBefore.confidence, 'Confirm should raise or keep confidence.');
assert(confirmed.factId != null, 'Confirm should promote a memory fact.');

const fact = db.prepare(`
  SELECT category, topic, content, confidence, source, status
  FROM mem_facts WHERE id = ?
`).get(confirmed.factId);
assert(fact, 'Memory fact should exist.');
assert(fact.category === 'identity', `Expected identity fact, got ${fact.category}.`);
assert(fact.topic === 'cognitive_pressure_dependency', `Unexpected topic ${fact.topic}.`);
assert(fact.source === 'cognitive_self_map', 'Fact source should be cognitive_self_map.');
assert(/User-confirmed/i.test(fact.content), 'Fact content should mark confirmation.');
assert(!confirmed.bundle.hypotheses.some(h => h.traitId === 'pressure_dependency'),
  'Confirmed pressure trait should drop from open hypotheses.');

const disputed = setCognitiveTraitStance({
  traitId: 'voluntary_start_rate',
  stance: 'disputed',
  note: 'I do start early more often than this suggests.',
});
const vol = disputed.bundle.traits.find(t => t.id === 'voluntary_start_rate');
const volBefore = before.traits.find(t => t.id === 'voluntary_start_rate');
assert(vol.userStance === 'disputed', 'Dispute should stick.');
assert(vol.confidence < volBefore.confidence, 'Dispute should lower confidence.');

const prompt = formatCognitiveTraitsForPrompt(confirmed.bundle);
assert(/CONFIRMED/i.test(prompt), 'Prompt formatter should include CONFIRMED traits.');
// Recompute after dispute so prompt includes both
const afterBoth = computeCognitiveTraits({ windowDays: 45 });
const promptBoth = formatCognitiveTraitsForPrompt(afterBoth);
assert(/CONFIRMED/i.test(promptBoth), 'Prompt should list confirmed wiring.');
assert(/DISPUTED/i.test(promptBoth), 'Prompt should list disputed claims.');

const personalizationPrompt = formatPersonalizationContext(buildPersonalizationSnapshot({ surface: 'agent' }));
assert(/COGNITIVE SELF-MAP/i.test(personalizationPrompt), 'Personalization context should include cognitive self-map.');
assert(/CONFIRMED/i.test(personalizationPrompt), 'Agent personalization should see confirmed trait.');

// Aspirational path
const aspire = setCognitiveTraitStance({
  traitId: 'voluntary_start_rate',
  stance: 'aspirational',
  note: 'Raise voluntary starts without killing deadline performance.',
});
assert(aspire.trait.userStance === 'aspirational', 'Aspirational stance should apply.');
const aspireFact = db.prepare(`
  SELECT category, content FROM mem_facts
  WHERE topic = 'cognitive_voluntary_start_rate' AND status != 'superseded'
  ORDER BY id DESC LIMIT 1
`).get();
assert(aspireFact.category === 'goal', `Aspirational should store as goal fact, got ${aspireFact.category}.`);
assert(/aspiration|Desired change/i.test(aspireFact.content), 'Aspiration fact should describe desired change.');

console.log(JSON.stringify({
  ok: true,
  scenario: 'confirm/dispute/aspire cognitive traits promote memory and agent context',
  confirmedPdi: confirmed.trait.value,
  confirmedConfidence: confirmed.trait.confidence,
  disputedThenAspiredVoluntary: aspire.trait.userStance,
  factId: confirmed.factId,
}, null, 2));
