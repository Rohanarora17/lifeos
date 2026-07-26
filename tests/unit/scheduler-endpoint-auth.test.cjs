'use strict';

const { afterEach, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');
let fetchSchedulerEndpoint;
let schedulerRunTimestamp;
let istDateForTimestamp;
let originalFetch;

describe('scheduler endpoint client', () => {
  before(() => {
    registerTypescript(root);
    ({
      fetchSchedulerEndpoint,
      schedulerRunTimestamp,
      istDateForTimestamp,
    } = require('../../src/lib/scheduler.ts'));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LIFEOS_API_TOKEN;
  });

  it('authenticates internal jobs and preserves request headers', async () => {
    process.env.LIFEOS_API_TOKEN = 'scheduler-test-token';
    global.fetch = async (url, init) => {
      assert.equal(url, 'http://lifeos.test/api/guardian/optimize');
      const headers = new Headers(init.headers);
      assert.equal(
        headers.get('Authorization'),
        'Bearer scheduler-test-token'
      );
      assert.equal(headers.get('Content-Type'), 'application/json');
      return new Response('{}', { status: 200 });
    };

    const response = await fetchSchedulerEndpoint(
      'http://lifeos.test/api/guardian/optimize',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    assert.equal(response.status, 200);
  });

  it('fails the job when a protected endpoint rejects it', async () => {
    global.fetch = async () =>
      new Response('unauthorized', { status: 401 });

    await assert.rejects(
      fetchSchedulerEndpoint('http://lifeos.test/api/guardian/optimize', {
        method: 'POST',
      }),
      /guardian\/optimize returned 401/
    );
  });

  it('reports real UTC instants while deduplicating by the IST date', () => {
    const instant = Date.parse('2026-07-26T22:59:00.000Z');
    const timestamp = schedulerRunTimestamp(instant);
    assert.equal(timestamp, '2026-07-26T22:59:00.000Z');
    assert.equal(istDateForTimestamp(timestamp), '2026-07-27');
    assert.equal(istDateForTimestamp('not-a-date'), null);
  });
});
