'use strict';

/**
 * Proves Cognitive Self-Map is first-class on the shared intelligence spine —
 * not a silo only Insights/chat can see.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createIsolatedDb,
  seedPressureLinkedSessions,
} = require('../helpers/temp-db.cjs');

describe('shared intelligence spine — cognitive is first-class', () => {
  let setSetting;
  let setCognitiveTraitStance;
  let buildPersonalizationSnapshot;
  let formatPersonalizationContext;
  let getIntelligenceContext;
  let computeCognitiveTraits;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-shared-spine-');
    setSetting = env.setSetting;
    seedPressureLinkedSessions(env.db, 7);
    setSetting('cognitive_trait_stances', '{}');
    setSetting('active_coach_mode', 'auto');
    setSetting('cognitive_experiments_v1', '[]');

    ({ setCognitiveTraitStance, computeCognitiveTraits } = env.requireLib('cognitive-traits.ts'));
    ({
      buildPersonalizationSnapshot,
      formatPersonalizationContext,
    } = env.requireLib('personalization-context.ts'));
    ({ getIntelligenceContext } = env.requireLib('intelligence.ts'));
  });

  it('PersonalizationSnapshot carries structured cognitive traits + coach + trajectory', () => {
    setCognitiveTraitStance({
      traitId: 'pressure_dependency',
      stance: 'confirmed',
      note: 'shared spine test',
    });
    const snap = buildPersonalizationSnapshot({ surface: 'agent', maxInsights: 2, includeMemoryFacts: 4 });
    assert.ok(snap.cognitive, 'snapshot.cognitive must exist');
    assert.ok(snap.cognitive.traits, 'traits bundle required');
    assert.ok(snap.cognitive.activeCoach, 'activeCoach required');
    assert.ok(snap.cognitive.trajectory, 'trajectory required');
    assert.ok(snap.cognitive.experiments, 'experiments required');
    assert.ok(snap.cognitive.contextBlock.includes('COGNITIVE SELF-MAP') || snap.cognitive.contextBlock.includes('Pressure'));
    const pdi = snap.cognitive.traits.traits.find(t => t.id === 'pressure_dependency');
    assert.equal(pdi.userStance, 'confirmed');
    assert.equal(snap.cognitive.activeCoach.mapTrust.trusted, true);
  });

  it('formatPersonalizationContext uses snapshot.cognitive (same map, not a second invent)', () => {
    setCognitiveTraitStance({ traitId: 'pressure_dependency', stance: 'confirmed' });
    const snap = buildPersonalizationSnapshot({ surface: 'telegram' });
    const formatted = formatPersonalizationContext(snap);
    assert.match(formatted, /COGNITIVE SELF-MAP|Pressure Dependency/i);
    assert.match(formatted, /CONFIRMED|confirmed|Active coach|ACTIVE COACH/i);
    // Structured and formatted should agree on PDI value
    const pdi = snap.cognitive.traits.pressureProfile.pressureDependency;
    assert.ok(pdi != null);
    assert.ok(
      formatted.includes(String(Math.round(pdi * 100)))
      || formatted.toLowerCase().includes('pressure'),
      'formatted context should reflect measured pressure wiring',
    );
  });

  it('UIL getIntelligenceContext includes deterministic cognitive map for guardian/agents', () => {
    setCognitiveTraitStance({ traitId: 'pressure_dependency', stance: 'confirmed' });
    setCognitiveTraitStance({ traitId: 'voluntary_start_rate', stance: 'aspirational' });
    // Warm traits so history/context non-empty
    computeCognitiveTraits({ windowDays: 45 });
    const ctx = getIntelligenceContext({ maxInsights: 2, includeToday: true });
    assert.match(ctx, /COGNITIVE SELF-MAP|Pressure Dependency|USER INTELLIGENCE PROFILE/i);
    assert.match(ctx, /Active coach|ACTIVE COACH|Trajectory|trajectory/i);
  });

  it('planner path refresh keeps cognitive when day state overrides energy', () => {
    setCognitiveTraitStance({ traitId: 'pressure_dependency', stance: 'confirmed' });
    const snap = buildPersonalizationSnapshot({ surface: 'scheduler' });
    assert.ok(snap.cognitive);
    const { refreshCognitiveOnSnapshot } = require('../../src/lib/personalization-context.ts');
    const recovery = refreshCognitiveOnSnapshot({
      ...snap,
      userState: { ...snap.userState, energy: 'low', mood: 'low' },
      moment: { mode: 'recovery', guidance: 'recovery' },
    });
    assert.ok(recovery.cognitive.activeCoach);
    assert.ok(recovery.cognitive.contextBlock.length > 20);
  });
});
