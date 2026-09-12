'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('AI usage ledger', () => {
  let env;
  let db;
  let usage;

  beforeEach(() => {
    env = createIsolatedDb('lifeos-ai-usage-');
    db = env.db;
    usage = env.requireLib('ai-usage.ts');
  });

  it('estimates Gemini 3.1 Flash-Lite cost from uncached input, cached input, and output', () => {
    const result = usage.estimateAiCostUsd('gemini-3.1-flash-lite', {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
      reasoningTokens: 50_000,
    });
    // 800k * $0.25/M + 200k * $0.025/M + 150k * $1.50/M
    assert.equal(result, 0.43);
  });

  it('persists success and failure attempts without charging failures', () => {
    usage.recordAiUsageAttempt({
      requestId: 'request-success', requestedModel: 'gemini-3.1-flash-lite',
      actualModel: 'gemini-3.1-flash-lite', operation: 'generate', feature: 'guardian/activity',
      status: 'success', attempt: 1, usedFallback: false, latencyMs: 120,
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 50, totalTokenCount: 1250 },
    });
    usage.recordAiUsageAttempt({
      requestId: 'request-failure', requestedModel: 'gemini-3.1-pro-preview',
      actualModel: 'gemini-3.1-pro-preview', operation: 'generate', feature: 'planner',
      status: 'failed', attempt: 1, usedFallback: false, latencyMs: 50,
      error: new Error('RESOURCE_EXHAUSTED'),
    });

    const rows = db.prepare('SELECT status, input_tokens, output_tokens, reasoning_tokens, estimated_cost_usd FROM ai_usage_events ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      status: 'success', input_tokens: 1000, output_tokens: 200,
      reasoning_tokens: 50, estimated_cost_usd: 0.000625,
    });
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].estimated_cost_usd, 0);
  });

  it('prices usage already returned by a cancelled stream', () => {
    usage.recordAiUsageAttempt({
      requestId: 'request-cancelled', requestedModel: 'gemini-2.5-flash',
      actualModel: 'gemini-2.5-flash', operation: 'stream', feature: 'assistant',
      status: 'cancelled', attempt: 1, usedFallback: false, latencyMs: 80,
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500, totalTokenCount: 1500 },
    });

    const row = db.prepare("SELECT status, estimated_cost_usd FROM ai_usage_events WHERE request_id='request-cancelled'").get();
    assert.deepEqual(row, { status: 'cancelled', estimated_cost_usd: 0.00155 });
  });
});
