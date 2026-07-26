'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-assessment-claim-');
const {
  buildAssessmentClaim,
  canDriveDecision,
  containsRelativeDateLanguage,
} = env.requireLib('assessment-claim.ts');

function input(overrides = {}) {
  return {
    id: 'focus-window',
    value: '09:00-11:00',
    sampleSize: 10,
    distinctDays: 5,
    evidenceReferences: ['guardian_session_summaries:1'],
    observationStart: '2030-01-01T00:00:00.000Z',
    observationEnd: '2030-01-10T00:00:00.000Z',
    computedAt: '2030-01-10T01:00:00.000Z',
    expiresAt: '2030-01-11T01:00:00.000Z',
    algorithmVersion: 'claim-rules-v1',
    modelVersion: null,
    userStance: 'unreviewed',
    strength: 'decision',
    ...overrides,
  };
}

describe('AssessmentClaimV1', () => {
  const now = Date.parse('2030-01-10T02:00:00.000Z');

  it('keeps cold-start data unknown and hypotheses below decision thresholds', () => {
    assert.equal(buildAssessmentClaim(input({ sampleSize: 4 }), now).status, 'unknown');
    assert.equal(
      buildAssessmentClaim(input({ sampleSize: 9, distinctDays: 4 }), now).status,
      'hypothesis',
    );
  });

  it('requires ten samples across five days for decisions', () => {
    const claim = buildAssessmentClaim(input(), now);
    assert.equal(claim.status, 'supported');
    assert.equal(canDriveDecision(claim), true);
  });

  it('requires user confirmation for strong identity claims', () => {
    const unreviewed = buildAssessmentClaim(input({
      id: 'coaching-style',
      value: 'direct',
      sampleSize: 30,
      distinctDays: 20,
      strength: 'identity',
    }), now);
    assert.equal(unreviewed.status, 'hypothesis');
    assert.equal(canDriveDecision(unreviewed), false);

    const confirmed = buildAssessmentClaim(input({
      id: 'coaching-style',
      value: 'direct',
      sampleSize: 30,
      distinctDays: 20,
      strength: 'identity',
      userStance: 'confirmed',
    }), now);
    assert.equal(confirmed.status, 'confirmed');
  });

  it('expires stale claims and rejects relative dates', () => {
    assert.equal(buildAssessmentClaim(input({
      expiresAt: '2030-01-09T00:00:00.000Z',
    }), now).status, 'expired');
    const relative = buildAssessmentClaim(input({
      value: 'Tomorrow 9am-11am',
    }), now);
    assert.equal(relative.status, 'unknown');
    assert.equal(relative.value, null);
    assert.equal(containsRelativeDateLanguage('this evening'), true);
  });

  it('makes disputed claims ineligible regardless of sample size', () => {
    const claim = buildAssessmentClaim(input({ userStance: 'disputed' }), now);
    assert.equal(claim.status, 'disputed');
    assert.equal(canDriveDecision(claim), false);
  });
});
