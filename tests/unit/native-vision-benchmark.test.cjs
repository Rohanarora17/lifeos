'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  labels,
  makeCases,
  renderFixture,
  scoreResults,
} = require('../../scripts/benchmark-native-vision.cjs');

describe('native vision benchmark harness', () => {
  it('builds a balanced 60-case corpus with synthetic titles', () => {
    const cases = makeCases();
    assert.equal(cases.length, 60);
    for (const label of labels) {
      assert.equal(cases.filter((testCase) => testCase.label === label).length, 12);
    }
    for (const testCase of cases) {
      assert.match(renderFixture(testCase), new RegExp(`BENCH-${testCase.id}`));
    }
  });

  it('passes all gates for perfect predictions and skipped static repeats', () => {
    const results = makeCases().map((testCase) => ({
      expectedLabel: testCase.label,
      predictedLabel: testCase.label,
      expectedAlignment: testCase.expectedAlignment,
      predictedAlignment: testCase.expectedAlignment,
      captureStatus: 'captured',
      titleMatched: true,
      analysisReason: null,
    }));
    const staticResults = Array.from({ length: 12 }, () => ({
      predictedLabel: 'unknown',
      analysisReason: 'no_change',
    }));

    const summary = scoreResults(results, staticResults);
    assert.equal(summary.sampleCount, 60);
    assert.equal(summary.macroF1, 1);
    assert.equal(summary.alignmentMae, 0);
    assert.deepEqual(summary.gates, {
      categoryMacroF1: true,
      alignmentMae: true,
      privacy: true,
      staticHandling: true,
    });
  });

  it('counts unknown predictions as false negatives', () => {
    const cases = makeCases();
    const results = cases.map((testCase, index) => ({
      expectedLabel: testCase.label,
      predictedLabel: index === 0 ? 'unknown' : testCase.label,
      expectedAlignment: testCase.expectedAlignment,
      predictedAlignment: testCase.expectedAlignment,
      captureStatus: 'captured',
      titleMatched: true,
      analysisReason: index === 0 ? 'invalid_assessment' : null,
    }));

    const summary = scoreResults(results, []);
    assert.equal(summary.invalidAssessments, 1);
    assert.ok(summary.macroF1 < 1);
  });
});
