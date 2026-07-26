'use strict';

const { before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

function request(payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    headers: {
      get(name) {
        const key = name.toLowerCase();
        if (key === 'content-length') return String(Buffer.byteLength(raw));
        if (key === 'x-real-ip') return '127.0.0.1';
        return null;
      },
    },
    text: async () => raw,
  };
}

function event(eventId) {
  return {
    version: 1,
    eventId,
    deviceId: 'test-device',
    source: 'native_macos',
    observedStart: '2030-01-01T10:00:00.000Z',
    observedEnd: '2030-01-01T10:00:10.000Z',
    state: 'active',
    sessionId: null,
    application: null,
    window: null,
    tab: null,
    group: null,
    provenance: {
      collector: 'test',
      collectorVersion: '1',
      adaptedFrom: null,
    },
    privacy: { decision: 'allow', reason: 'test_fixture' },
  };
}

describe('telemetry ingestion API', () => {
  let POST;
  let resetRateLimitsForTests;

  before(() => {
    const env = createIsolatedDb('lifeos-telemetry-api-');
    ({ resetRateLimitsForTests } = env.requireLib('rate-limit.ts'));
    ({ POST } = require('../../src/app/api/telemetry/events/route.ts'));
  });

  beforeEach(() => resetRateLimitsForTests());

  it('accepts a batch and reports idempotent retries', async () => {
    const first = await POST(request({ events: [event('api-one')] }));
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), {
      accepted: 1,
      duplicates: 0,
      rejected: [],
    });

    const retry = await POST(request(event('api-one')));
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).duplicates, 1);
  });

  it('returns 422 when every event is invalid', async () => {
    const response = await POST(request({ broken: true }));
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected.length, 1);
  });

  it('rejects invalid JSON before ingestion', async () => {
    const response = await POST(request('{'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_json');
  });
});
