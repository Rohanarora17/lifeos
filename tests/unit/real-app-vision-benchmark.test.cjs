'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  labels,
  makeCases,
  makePrivacyCases,
} = require('../../scripts/benchmark-real-app-vision.cjs');

test('real-app matrix is balanced across all vision labels', () => {
  const cases = makeCases();
  assert.equal(cases.length, 40);
  for (const label of labels) {
    assert.equal(cases.filter((testCase) => testCase.label === label).length, 8);
  }
});

test('real-app matrix covers the required application families', () => {
  const cases = makeCases();
  const kinds = new Set(cases.map((testCase) => testCase.kind));
  assert.deepEqual(
    [...kinds].sort(),
    ['browser', 'editor', 'pdf', 'video'],
  );
});

test('privacy matrix requires pre-capture denial for communication apps', () => {
  const cases = makePrivacyCases();
  assert.equal(cases.length, 4);
  assert.ok(cases.every((testCase) => testCase.expectedRule.startsWith('sensitive_app:')));
});

test('real-app matrix keeps expected alignments within score bounds', () => {
  assert.ok(
    makeCases().every(
      (testCase) => testCase.expectedAlignment >= 0 && testCase.expectedAlignment <= 100,
    ),
  );
});
