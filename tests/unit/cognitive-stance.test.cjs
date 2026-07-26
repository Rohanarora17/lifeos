'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb, seedPressureLinkedSessions } = require('../helpers/temp-db.cjs');

describe('cognitive trait stance (B2) — confirm/dispute/aspire + memory', () => {
  let db;
  let computeCognitiveTraits;
  let setCognitiveTraitStance;
  let formatCognitiveTraitsForPrompt;
  let formatPersonalizationContext;
  let buildPersonalizationSnapshot;

  before(() => {
    const env = createIsolatedDb('lifeos-cog-stance-');
    db = env.db;
    seedPressureLinkedSessions(db, 7);
    ({
      computeCognitiveTraits,
      setCognitiveTraitStance,
      formatCognitiveTraitsForPrompt,
    } = env.requireLib('cognitive-traits.ts'));
    ({
      formatPersonalizationContext,
      buildPersonalizationSnapshot,
    } = env.requireLib('personalization-context.ts'));
  });

  it('defaults to observed and exposes open pressure hypothesis', () => {
    const before = computeCognitiveTraits({ windowDays: 45 });
    const pdi = before.traits.find(t => t.id === 'pressure_dependency');
    assert.equal(pdi.userStance, 'observed');
    assert.ok(before.hypotheses.some(h => h.traitId === 'pressure_dependency'));
  });

  it('confirm promotes identity memory fact and drops hypothesis', () => {
    const before = computeCognitiveTraits({ windowDays: 45 });
    const pdiBefore = before.traits.find(t => t.id === 'pressure_dependency');
    const confirmed = setCognitiveTraitStance({
      traitId: 'pressure_dependency',
      stance: 'confirmed',
      note: 'I only start hard work under deadline heat.',
    });
    assert.equal(confirmed.stance, 'confirmed');
    assert.equal(confirmed.trait.userStance, 'confirmed');
    assert.ok(confirmed.trait.confidence >= pdiBefore.confidence);
    assert.ok(confirmed.factId != null);

    const fact = db.prepare('SELECT * FROM mem_facts WHERE id = ?').get(confirmed.factId);
    assert.equal(fact.category, 'identity');
    assert.equal(fact.topic, 'cognitive_pressure_dependency');
    assert.equal(fact.source, 'cognitive_self_map');
    assert.match(fact.content, /User-confirmed/i);
    assert.ok(!confirmed.bundle.hypotheses.some(h => h.traitId === 'pressure_dependency'));
  });

  it('dispute lowers confidence and aspirational writes goal fact', () => {
    const before = computeCognitiveTraits({ windowDays: 45 });
    const volBefore = before.traits.find(t => t.id === 'voluntary_start_rate');
    const disputed = setCognitiveTraitStance({
      traitId: 'voluntary_start_rate',
      stance: 'disputed',
      note: 'I start early more than this suggests.',
    });
    assert.equal(disputed.trait.userStance, 'disputed');
    assert.ok(disputed.trait.confidence < volBefore.confidence);

    const aspired = setCognitiveTraitStance({
      traitId: 'voluntary_start_rate',
      stance: 'aspirational',
      note: 'Raise voluntary starts without killing deadline performance.',
    });
    assert.equal(aspired.trait.userStance, 'aspirational');
    const fact = db.prepare(`
      SELECT category, content FROM mem_facts
      WHERE topic = 'cognitive_voluntary_start_rate' AND status != 'superseded'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.equal(fact.category, 'goal');
    assert.match(fact.content, /aspiration|Desired change/i);
  });

  it('agent personalization context includes CONFIRMED/DISPUTED wiring', () => {
    const bundle = computeCognitiveTraits({ windowDays: 45 });
    const prompt = formatCognitiveTraitsForPrompt(bundle);
    assert.match(prompt, /CONFIRMED/i);
    const full = formatPersonalizationContext(buildPersonalizationSnapshot({ surface: 'agent' }));
    assert.match(full, /COGNITIVE SELF-MAP/i);
    assert.match(full, /CONFIRMED/i);
  });
});
