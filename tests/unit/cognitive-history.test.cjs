'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb, seedPressureLinkedSessions } = require('../helpers/temp-db.cjs');

describe('cognitive history (B5) — snapshots, trends, weekly question', () => {
  let setSetting;
  let computeCognitiveTraits;
  let getCognitiveTraitHistory;
  let selectWeeklyCognitiveQuestion;

  before(() => {
    const env = createIsolatedDb('lifeos-cog-hist-');
    setSetting = env.setSetting;
    seedPressureLinkedSessions(env.db, 6);
    ({
      computeCognitiveTraits,
      getCognitiveTraitHistory,
      selectWeeklyCognitiveQuestion,
    } = env.requireLib('cognitive-traits.ts'));
  });

  it('records at most one history point per day and keeps prior points', () => {
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
    assert.ok(history.length >= synthetic.length);
    assert.ok(history.some(h => h.date === '2030-01-01'));
    assert.ok(bundle.history.length >= 2);

    const beforeLen = getCognitiveTraitHistory(30).length;
    computeCognitiveTraits({ windowDays: 45 });
    const after = getCognitiveTraitHistory(30);
    const dates = after.map(h => h.date);
    assert.equal(new Set(dates).size, dates.length, 'one snapshot per day');
    assert.equal(after.length, beforeLen, 'same-day recompute overwrites');
  });

  it('derives improving trends from multi-day PDI drop / voluntary rise', () => {
    const synthetic = [
      { date: '2030-02-01', pressureDependency: 0.85, voluntaryStartRate: 0.15, activationEnergyDays: 10, crisisBonus: 14, avoidanceAgeDays: 3, confidence: 0.5 },
      { date: '2030-02-02', pressureDependency: 0.8, voluntaryStartRate: 0.2, activationEnergyDays: 9, crisisBonus: 13, avoidanceAgeDays: 2.5, confidence: 0.52 },
      { date: '2030-02-03', pressureDependency: 0.74, voluntaryStartRate: 0.28, activationEnergyDays: 8, crisisBonus: 12, avoidanceAgeDays: 2, confidence: 0.55 },
      { date: '2030-02-04', pressureDependency: 0.68, voluntaryStartRate: 0.35, activationEnergyDays: 7, crisisBonus: 11, avoidanceAgeDays: 1.5, confidence: 0.58 },
      { date: '2030-02-05', pressureDependency: 0.6, voluntaryStartRate: 0.42, activationEnergyDays: 6, crisisBonus: 10, avoidanceAgeDays: 1, confidence: 0.6 },
    ];
    setSetting('cognitive_trait_history_v1', JSON.stringify(synthetic));
    const bundle = computeCognitiveTraits({ windowDays: 45 });
    const pdi = bundle.traits.find(t => t.id === 'pressure_dependency');
    const vol = bundle.traits.find(t => t.id === 'voluntary_start_rate');
    const directional = [pdi.trend, vol.trend].filter(t => t === 'improving' || t === 'worsening');
    assert.ok(directional.length >= 1, `expected directional trend, got pdi=${pdi.trend} vol=${vol.trend}`);
  });

  it('selects a concrete weekly cognitive question', () => {
    const bundle = computeCognitiveTraits({ windowDays: 45 });
    const question = selectWeeklyCognitiveQuestion(bundle);
    assert.equal(typeof question, 'string');
    assert.ok(question.length > 20);
    assert.match(question, /deadline|start|activation|pressure|voluntary|task/i);
  });
});
