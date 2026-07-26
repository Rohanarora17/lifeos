'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

function todayIst() {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

describe('personalization state provenance', () => {
  let db;
  let buildPersonalizationSnapshot;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-state-provenance-');
    db = env.db;
    ({ buildPersonalizationSnapshot } = env.requireLib('personalization-context.ts'));
  });

  it('uses a neutral baseline instead of an unverified intelligence-profile mood or energy', () => {
    const snapshot = buildPersonalizationSnapshot({ surface: 'dashboard' });

    assert.equal(snapshot.userState.energy, 'medium');
    assert.equal(snapshot.userState.energySource, 'baseline');
    assert.equal(snapshot.userState.mood, null);
    assert.equal(snapshot.userState.moodSource, 'unknown');
  });

  it('uses today\'s explicit check-in values and marks their provenance', () => {
    db.prepare(`
      INSERT INTO daily_checkins (checkin_date, checkin_type, mood, energy)
      VALUES (?, 'morning', 'high', 'low')
    `).run(todayIst());

    const snapshot = buildPersonalizationSnapshot({ surface: 'dashboard' });

    assert.equal(snapshot.userState.energy, 'low');
    assert.equal(snapshot.userState.energySource, 'explicit_checkin');
    assert.equal(snapshot.userState.mood, 'high');
    assert.equal(snapshot.userState.moodSource, 'explicit_checkin');
    assert.equal(snapshot.moment.mode, 'recovery');
  });
});
