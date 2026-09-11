'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('diagnostics route', () => {
  it('reports canonical browser telemetry freshness', async () => {
    const env = createIsolatedDb('lifeos-diagnostics-route-');
    const observedStart = new Date(Date.now() - 10_000).toISOString();
    const observedEnd = new Date().toISOString();

    env.db.prepare(`
      INSERT INTO telemetry_events_v1 (
        event_id, version, device_id, source, observed_start, observed_end,
        duration_seconds, state, provenance_json, privacy_decision, privacy_reason
      ) VALUES (?, 1, 'test-browser', 'browser_extension', ?, ?, 10, 'active', '{}', 'allow', 'test')
    `).run('diagnostics-browser-event', observedStart, observedEnd);

    const routePath = require.resolve('../../src/app/api/diagnostics/route.ts');
    delete require.cache[routePath];
    const { GET } = require(routePath);
    const response = await GET({
      headers: {
        get(name) {
          return name.toLowerCase() === 'x-lifeos-auth-kind' ? 'bearer' : null;
        },
      },
    });
    const payload = await response.json();

    assert.equal(payload.telemetry.browser.status, 'fresh');
    assert.equal(payload.telemetry.browser.observedAt, observedEnd);
  });

  it('reports a terminal AI billing failure instead of treating configuration as health', async () => {
    const env = createIsolatedDb('lifeos-diagnostics-ai-health-');
    const ai = env.requireLib('ai.ts');
    const billingError = Object.assign(
      new Error('Vertex request denied: BILLING_DISABLED for the configured project'),
      { status: 403 },
    );
    const failingClient = {
      models: {
        generateContent: async () => { throw billingError; },
      },
    };

    await assert.rejects(
      ai.generateWithFallback(failingClient, { model: 'gemini-3.1-flash-lite', contents: 'health probe' }),
      /BILLING_DISABLED/,
    );

    const routePath = require.resolve('../../src/app/api/diagnostics/route.ts');
    delete require.cache[routePath];
    const { GET } = require(routePath);
    const response = await GET({ headers: { get: () => null } });
    const payload = await response.json();

    assert.equal(payload.models.vertex.status, 'failed');
    assert.equal(payload.models.vertex.failureCode, 'BILLING_DISABLED');
    assert.equal(payload.models.vertex.modelAvailabilityVerified, false);
    assert.match(payload.models.vertex.message, /billing/i);
    assert.equal(payload.models.vertex.consecutiveFailures, 1);

    const successfulClient = {
      models: {
        generateContent: async () => ({ text: '{"ok":true}' }),
      },
    };
    await ai.generateWithFallback(successfulClient, {
      model: 'gemini-3.1-flash-lite',
      contents: 'recovery probe',
    });
    const recoveredResponse = await GET({ headers: { get: () => null } });
    const recovered = await recoveredResponse.json();
    assert.equal(recovered.models.vertex.status, 'healthy');
    assert.equal(recovered.models.vertex.failureCode, null);
    assert.equal(recovered.models.vertex.consecutiveFailures, 0);
    assert.equal(recovered.models.vertex.modelAvailabilityVerified, true);
  });
});
