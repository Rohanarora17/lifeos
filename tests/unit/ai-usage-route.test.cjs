'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('AI usage API', () => {
  it('separates attempts, recovered operations, and terminal failures', async () => {
    const env = createIsolatedDb('lifeos-ai-usage-route-');
    const usage = env.requireLib('ai-usage.ts');
    const base = {
      requestedModel: 'gemini-3.1-pro-preview',
      operation: 'generate',
      feature: 'next_day_planner',
      workClass: 'interactive',
      qualityTier: 'reasoning',
      trigger: 'regenerate',
      latencyMs: 10,
    };
    usage.recordAiUsageAttempt({ ...base, requestId: 'a:primary:1', logicalRequestId: 'a', actualModel: 'gemini-3.1-pro-preview', status: 'failed', attempt: 1, usedFallback: false, error: Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }) });
    usage.recordAiUsageAttempt({ ...base, requestId: 'a:fallback:1', logicalRequestId: 'a', actualModel: 'gemini-2.5-pro', status: 'success', attempt: 1, usedFallback: true, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });
    usage.recordAiUsageAttempt({ ...base, requestId: 'b:primary:1', logicalRequestId: 'b', actualModel: 'gemini-3.1-pro-preview', status: 'success', attempt: 1, usedFallback: false, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 40 } });
    usage.recordAiUsageAttempt({ ...base, requestId: 'c:primary:1', logicalRequestId: 'c', actualModel: 'gemini-3.1-pro-preview', status: 'failed', attempt: 1, usedFallback: false, error: new Error('fetch failed') });
    usage.recordAiUsageAttempt({ ...base, requestId: 'd:primary:1', logicalRequestId: 'd', actualModel: 'gemini-3.1-pro-preview', status: 'cancelled', attempt: 1, usedFallback: false });

    const routePath = require.resolve('../../src/app/api/ai/usage/route.ts');
    delete require.cache[routePath];
    const { GET } = require(routePath);
    const response = await GET();
    const payload = await response.json();

    assert.equal(payload.periods.allTime.attempts, 5);
    assert.equal(payload.periods.allTime.logicalOperations, 4);
    assert.equal(payload.periods.allTime.firstTrySuccesses, 1);
    assert.equal(payload.periods.allTime.recoveredOperations, 1);
    assert.equal(payload.periods.allTime.terminalFailures, 1);
    assert.equal(payload.periods.allTime.cancelledOperations, 1);
    assert.equal(payload.periods.allTime.failedAttempts, 2);
    assert.equal(payload.periods.allTime.fallbackAttempts, 1);
    assert.equal(payload.periods.allTime.reasoningTokens, 40);
    assert.equal(payload.byFeature[0].feature, 'next_day_planner');
    assert.equal(payload.byFeature[0].logicalOperations, 4);
    assert.equal(payload.byFeature[0].terminalFailures, 1);
    assert.equal(payload.optimizationSignals.unattributedAttempts, 0);
    assert.equal(payload.optimizationSignals.reasoningSharePercent, 14);
    assert.equal(payload.optimizationSignals.repeatedSuccessfulAttempts, 0);
  });
});
