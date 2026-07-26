'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  createIsolatedDb,
  seedPressureLinkedSessions,
  seedSteadyLinkedSessions,
} = require('../helpers/temp-db.cjs');

describe('cognitive traits (B1) — real SQLite runtime', () => {
  let pressureBundle;
  let steadyBundle;

  before(() => {
    const pressure = createIsolatedDb('lifeos-cog-traits-p-');
    seedPressureLinkedSessions(pressure.db, 7);
    pressureBundle = pressure.requireLib('cognitive-traits.ts').computeCognitiveTraits({ windowDays: 45 });

    const steady = createIsolatedDb('lifeos-cog-traits-s-');
    seedSteadyLinkedSessions(steady.db);
    steadyBundle = steady.requireLib('cognitive-traits.ts').computeCognitiveTraits({ windowDays: 45 });
  });

  it('computes higher PDI for pressure-wired history than steady starters', () => {
    const p = pressureBundle.traits.find(t => t.id === 'pressure_dependency');
    const s = steadyBundle.traits.find(t => t.id === 'pressure_dependency');
    assert.ok(p?.value != null, 'pressure PDI required');
    assert.ok(s?.value != null, 'steady PDI required');
    assert.ok(p.value > s.value, `PDI pressure ${p.value} should exceed steady ${s.value}`);
    assert.ok(p.value >= 0.55, `expected high pressure PDI, got ${p.value}`);
  });

  it('computes lower voluntary start rate for pressure-wired history', () => {
    const p = pressureBundle.traits.find(t => t.id === 'voluntary_start_rate');
    const s = steadyBundle.traits.find(t => t.id === 'voluntary_start_rate');
    assert.ok(p?.value != null && s?.value != null);
    assert.ok(s.value > p.value, `voluntary steady ${s.value} should exceed pressure ${p.value}`);
  });

  it('reports activation energy, avoidance, and crisis bonus with evidence', () => {
    const activation = pressureBundle.traits.find(t => t.id === 'activation_energy');
    const avoidance = pressureBundle.traits.find(t => t.id === 'avoidance_age');
    const crisis = pressureBundle.traits.find(t => t.id === 'crisis_performance_bonus');
    assert.ok(activation?.value != null && activation.value >= 3);
    assert.ok(avoidance?.value != null);
    assert.ok(crisis?.value != null);
    assert.ok(crisis.evidence.length >= 1);
    assert.ok(pressureBundle.summary.length > 40);
  });

  it('exposes pressureProfile and hypotheses for high-PDI users', () => {
    assert.ok(pressureBundle.pressureProfile.pressureDependency != null);
    assert.ok(Array.isArray(pressureBundle.hypotheses));
    assert.ok(
      pressureBundle.hypotheses.some(h => h.traitId === 'pressure_dependency' || h.traitId === 'voluntary_start_rate'),
      'expected open wiring hypothesis',
    );
  });

  it('wires traits into self-model beliefs', () => {
    const env = createIsolatedDb('lifeos-cog-self-');
    seedPressureLinkedSessions(env.db, 7);
    const { computeCognitiveTraits } = env.requireLib('cognitive-traits.ts');
    const { buildPersonalizationSnapshot } = env.requireLib('personalization-context.ts');
    const { getIntelligenceProfile } = env.requireLib('intelligence.ts');
    const { buildSelfModel } = env.requireLib('self-model.ts');
    const traits = computeCognitiveTraits({ windowDays: 45 });
    const selfModel = buildSelfModel({
      snapshot: buildPersonalizationSnapshot({ surface: 'self_model' }),
      profile: getIntelligenceProfile(),
      feedbackFacts: [],
      cognitiveTraits: traits,
    });
    assert.ok(selfModel.beliefs.some(b => b.id === 'cognitive_pressure_dependency'));
    assert.ok(selfModel.cognitiveTraits.pressureProfile.pressureDependency != null);
    assert.match(selfModel.summary, /pressure|crisis|deadline|voluntary/i);
  });
});
