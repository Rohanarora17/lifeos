'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-diagnostic-freshness-');
const { assessFreshness } = env.requireLib('diagnostic-freshness.ts');

describe('diagnostic freshness', () => {
  const now = Date.parse('2030-01-01T12:00:00.000Z');

  it('marks observations within the threshold as fresh', () => {
    const result = assessFreshness('2030-01-01T11:59:45.000Z', 30, now);
    assert.equal(result.status, 'fresh');
    assert.equal(result.ageSeconds, 15);
  });

  it('marks older observations as stale', () => {
    const result = assessFreshness('2030-01-01T11:55:00.000Z', 60, now);
    assert.equal(result.status, 'stale');
    assert.equal(result.ageSeconds, 300);
  });

  it('distinguishes missing and malformed timestamps', () => {
    assert.equal(assessFreshness(null, 60, now).status, 'missing');
    assert.equal(assessFreshness('tomorrow morning', 60, now).status, 'invalid');
  });
});
