'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-screen-vision-validation-');
const { parseVisionAssessment, shouldEscalateVisionAssessment } = env.requireLib('screen-vision.ts');

function validAssessment(overrides = {}) {
  return JSON.stringify({
    taskAlignment: 82,
    engagementDepth: 'active_creation',
    contentSummary: 'A synthetic audit document is open.',
    specificContent: 'LifeOS Guardian Audit',
    distractionIndicators: [],
    progressIndicator: 'Audit text was entered.',
    confidence: 0.91,
    ...overrides,
  });
}

describe('screen vision assessment validation', () => {
  it('escalates invalid or low-confidence Flash-Lite assessments', () => {
    assert.equal(shouldEscalateVisionAssessment(null), true);
    assert.equal(shouldEscalateVisionAssessment({ confidence: 0.64 }), true);
    assert.equal(shouldEscalateVisionAssessment({ confidence: 0.65 }), false);
  });

  it('accepts a complete supported assessment', () => {
    const result = parseVisionAssessment(validAssessment());
    assert.equal(result.taskAlignment, 82);
    assert.equal(result.engagementDepth, 'active_creation');
  });

  it('rejects malformed JSON instead of manufacturing a neutral score', () => {
    assert.equal(parseVisionAssessment('{not json'), null);
  });

  it('rejects unsupported enums and non-finite or out-of-range scores', () => {
    assert.equal(parseVisionAssessment(validAssessment({ engagementDepth: 'very_focused' })), null);
    assert.equal(parseVisionAssessment(validAssessment({ taskAlignment: 'NaN' })), null);
    assert.equal(parseVisionAssessment(validAssessment({ taskAlignment: 101 })), null);
    assert.equal(parseVisionAssessment(validAssessment({ confidence: -0.1 })), null);
  });

  it('rejects oversized or incorrectly typed evidence fields', () => {
    assert.equal(parseVisionAssessment(validAssessment({ contentSummary: 'x'.repeat(1_001) })), null);
    assert.equal(parseVisionAssessment(validAssessment({ distractionIndicators: [42] })), null);
  });
});
