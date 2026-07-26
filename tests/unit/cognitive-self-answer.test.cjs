'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createIsolatedDb,
  seedPressureLinkedSessions,
} = require('../helpers/temp-db.cjs');

describe('cognitive self-answer + multi-week trajectory', () => {
  let setSetting;
  let setCognitiveTraitStance;
  let isCognitiveSelfQuestion;
  let detectCognitiveQuestionFocus;
  let buildCognitiveSelfAnswer;
  let getCognitiveTrajectory;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-self-answer-');
    setSetting = env.setSetting;
    seedPressureLinkedSessions(env.db, 7);
    setSetting('cognitive_trait_stances', '{}');
    setSetting('cognitive_experiments_v1', '[]');
    setSetting('active_coach_mode', 'auto');

    ({ setCognitiveTraitStance } = env.requireLib('cognitive-traits.ts'));
    ({
      isCognitiveSelfQuestion,
      detectCognitiveQuestionFocus,
      buildCognitiveSelfAnswer,
      getCognitiveTrajectory,
    } = env.requireLib('cognitive-self-answer.ts'));
  });

  it('detects self-map questions and focus buckets', () => {
    assert.equal(isCognitiveSelfQuestion('Why am I only productive under pressure?'), true);
    assert.equal(isCognitiveSelfQuestion('what time is my meeting'), false);
    assert.equal(detectCognitiveQuestionFocus('when does my brain work best'), 'when');
    assert.equal(detectCognitiveQuestionFocus('why do I procrastinate'), 'why');
    assert.equal(detectCognitiveQuestionFocus('how do I work in deep sessions'), 'how');
    assert.equal(detectCognitiveQuestionFocus('show my trajectory over weeks'), 'trajectory');
    assert.equal(detectCognitiveQuestionFocus('how do I rewire without deadlines'), 'rewiring');
    assert.equal(detectCognitiveQuestionFocus('pressure dependency profile'), 'pressure');
  });

  it('builds grounded pressure answer from seeded traits', () => {
    const answer = buildCognitiveSelfAnswer('Why am I only productive under pressure?');
    assert.equal(answer.matched, true);
    assert.equal(answer.focus, 'why');
    assert.ok(answer.summary.length > 20);
    assert.ok(answer.sections.length >= 1);
    assert.ok(answer.plainText.toLowerCase().includes('pressure') || answer.summary.toLowerCase().includes('pressure'));
    assert.ok(answer.confidence >= 0);
    assert.ok(answer.markdown.includes('###'));
  });

  it('builds multi-week trajectory from multi-day history snapshots', () => {
    // Two weeks of synthetic history with directional signal
    const history = [];
    for (let d = 1; d <= 7; d++) {
      history.push({
        date: `2030-03-0${d}`,
        pressureDependency: 0.8 - d * 0.01,
        voluntaryStartRate: 0.2 + d * 0.01,
        activationEnergyDays: 8,
        crisisBonus: 10,
        avoidanceAgeDays: 1,
        confidence: 0.5,
      });
    }
    for (let d = 1; d <= 7; d++) {
      const day = d + 7;
      const date = day < 10 ? `2030-03-0${day}` : `2030-03-${day}`;
      history.push({
        date,
        pressureDependency: 0.7 - d * 0.02,
        voluntaryStartRate: 0.3 + d * 0.02,
        activationEnergyDays: 7,
        crisisBonus: 9,
        avoidanceAgeDays: 1,
        confidence: 0.55,
      });
    }
    setSetting('cognitive_trait_history_v1', JSON.stringify(history));

    const traj = getCognitiveTrajectory({ historyLimit: 90 });
    assert.ok(traj.points.length >= 14);
    assert.ok(traj.weeks.length >= 2, `expected >=2 weeks, got ${traj.weeks.length}`);
    assert.equal(traj.enoughData, true);
    assert.ok(traj.headline.length > 10);

    const answer = buildCognitiveSelfAnswer('Show my wiring trajectory over weeks');
    assert.equal(answer.focus, 'trajectory');
    assert.match(answer.summary + answer.plainText, /week|snapshot|trajectory|PDI|voluntary/i);
  });

  it('rewiring answer references coach trust state', () => {
    setCognitiveTraitStance({
      traitId: 'pressure_dependency',
      stance: 'confirmed',
      note: 'true for me',
    });
    const answer = buildCognitiveSelfAnswer('How do I rewire without needing deadlines?');
    assert.equal(answer.focus, 'rewiring');
    assert.ok(answer.sections.some(s => /coach|experiment/i.test(s.heading + s.body)));
  });
});
