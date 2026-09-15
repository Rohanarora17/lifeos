'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

registerTypescript(path.resolve(__dirname, '../..'));

const {
  AI_FEATURE_POLICIES,
  resolveAiExecutionPolicy,
} = require('../../src/lib/ai-execution-policy.ts');

describe('unified AI execution policy', () => {
  it('routes routine work to Flash-Lite with minimal thinking', () => {
    const policy = resolveAiExecutionPolicy('gemini-3.1-pro-preview', {
      feature: 'alert_rewrite',
      trigger: 'task_due',
    });

    assert.equal(policy.model, 'gemini-3.1-flash-lite');
    assert.equal(policy.workClass, 'background');
    assert.equal(policy.qualityTier, 'routine');
    assert.equal(policy.thinkingLevel, 'minimal');
    assert.equal(policy.timeoutMs, 25_000);
  });

  it('keeps unified intelligence synthesis on Pro with bounded reasoning', () => {
    const policy = resolveAiExecutionPolicy('gemini-3.1-flash-lite', {
      feature: 'unified_intelligence_synthesis',
      trigger: 'session_end',
    });

    assert.equal(policy.model, 'gemini-3.1-pro-preview');
    assert.equal(policy.workClass, 'background');
    assert.equal(policy.qualityTier, 'reasoning');
    assert.equal(policy.thinkingLevel, 'medium');
  });

  it('has no unattributed feature policy', () => {
    assert.equal(Object.hasOwn(AI_FEATURE_POLICIES, 'unknown'), false);
    for (const [feature, policy] of Object.entries(AI_FEATURE_POLICIES)) {
      assert.ok(policy.workClass, `${feature} is missing a work class`);
      assert.ok(policy.qualityTier, `${feature} is missing a quality tier`);
    }
  });
});
