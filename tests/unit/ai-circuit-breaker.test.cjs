'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

registerTypescript(path.resolve(__dirname, '../..'));
const { AiCircuitBreaker } = require('../../src/lib/ai-circuit-breaker.ts');

describe('AI model circuit breaker', () => {
  it('opens after three capacity failures and admits a half-open probe later', () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 3, windowMs: 600_000, openMs: 1_800_000 });
    const error = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    breaker.recordFailure('pro', error, 1_000);
    breaker.recordFailure('pro', error, 2_000);
    assert.equal(breaker.canAttempt('pro', 2_500), true);
    breaker.recordFailure('pro', error, 3_000);
    assert.equal(breaker.canAttempt('pro', 4_000), false);
    assert.equal(breaker.canAttempt('pro', 1_803_001), true);
    assert.equal(breaker.isHalfOpenProbe('pro'), true);
    assert.equal(breaker.canAttempt('pro', 1_803_002), false);
    breaker.recordSuccess('pro');
    assert.equal(breaker.canAttempt('pro', 1_803_003), true);
  });

  it('ignores ordinary validation errors and resets after success', () => {
    const breaker = new AiCircuitBreaker({ failureThreshold: 2, windowMs: 100, openMs: 100 });
    breaker.recordFailure('pro', new Error('invalid JSON'), 1);
    assert.equal(breaker.snapshot(2).length, 0);
    const error = Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    breaker.recordFailure('pro', error, 3);
    breaker.recordSuccess('pro');
    assert.equal(breaker.snapshot(4).length, 0);
  });
});
