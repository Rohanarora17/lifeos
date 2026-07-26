'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-rate-limit-');
const {
  consumeRateLimit,
  resetRateLimitsForTests,
} = env.requireLib('rate-limit.ts');

describe('in-process rate limiter', () => {
  beforeEach(() => resetRateLimitsForTests());

  it('allows requests within a fixed window and blocks overflow', () => {
    assert.equal(consumeRateLimit('login:one', { limit: 2, windowMs: 60_000, now: 1_000 }).allowed, true);
    assert.equal(consumeRateLimit('login:one', { limit: 2, windowMs: 60_000, now: 2_000 }).allowed, true);
    const blocked = consumeRateLimit('login:one', { limit: 2, windowMs: 60_000, now: 3_000 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.retryAfterSeconds, 58);
  });

  it('starts a fresh bucket after expiry', () => {
    consumeRateLimit('login:two', { limit: 1, windowMs: 1_000, now: 1_000 });
    assert.equal(
      consumeRateLimit('login:two', { limit: 1, windowMs: 1_000, now: 1_500 }).allowed,
      false,
    );
    assert.equal(
      consumeRateLimit('login:two', { limit: 1, windowMs: 1_000, now: 2_000 }).allowed,
      true,
    );
  });

  it('isolates different keys', () => {
    consumeRateLimit('login:a', { limit: 1, windowMs: 60_000, now: 1_000 });
    assert.equal(
      consumeRateLimit('login:b', { limit: 1, windowMs: 60_000, now: 1_000 }).allowed,
      true,
    );
  });
});
