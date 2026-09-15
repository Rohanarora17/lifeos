'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('unified AI runtime', () => {
  it('applies feature routing and records one attributed logical operation', async () => {
    const env = createIsolatedDb('lifeos-ai-runtime-');
    const aiRuntime = env.requireLib('ai.ts');
    const calls = [];
    const client = {
      models: {
        generateContent: async params => {
          calls.push(params);
          return { text: '{"message":"go"}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } };
        },
      },
    };

    await aiRuntime.generateWithFallback(client, {
      model: 'gemini-3.1-pro-preview',
      contents: 'rewrite this alert',
    }, { feature: 'alert_rewrite', trigger: 'task_due', entityId: 'task:4' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
    assert.equal(calls[0].config.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.equal(calls[0].config.httpOptions.timeout, 25_000);

    const row = env.db.prepare(`
      SELECT feature, work_class, quality_tier, trigger, entity_id, logical_request_id,
             requested_model, actual_model
      FROM ai_usage_events
    `).get();
    assert.equal(row.feature, 'alert_rewrite');
    assert.equal(row.work_class, 'background');
    assert.equal(row.quality_tier, 'routine');
    assert.equal(row.trigger, 'task_due');
    assert.equal(row.entity_id, 'task:4');
    assert.ok(row.logical_request_id);
    assert.equal(row.requested_model, 'gemini-3.1-pro-preview');
    assert.equal(row.actual_model, 'gemini-3.1-flash-lite');
  });

  it('falls back immediately after resource exhaustion without retrying Pro', async () => {
    const env = createIsolatedDb('lifeos-ai-429-');
    const aiRuntime = env.requireLib('ai.ts');
    const models = [];
    const requests = [];
    const client = {
      models: {
        generateContent: async params => {
          models.push(params.model);
          requests.push(params);
          if (params.model === 'gemini-3.1-pro-preview') {
            throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
          }
          return { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        },
      },
    };

    await aiRuntime.generateWithFallback(client, {
      model: 'gemini-3.1-pro-preview', contents: 'make a plan',
    }, { feature: 'next_day_planner', trigger: 'regenerate' });

    assert.deepEqual(models, ['gemini-3.1-pro-preview', 'gemini-2.5-pro']);
    assert.equal(requests[1].config.thinkingConfig.thinkingLevel, undefined);
    assert.equal(requests[1].config.thinkingConfig.thinkingBudget, 1_024);
    const rows = env.db.prepare('SELECT logical_request_id, status, used_fallback FROM ai_usage_events ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].logical_request_id, rows[1].logical_request_id);
    assert.deepEqual(rows.map(row => [row.status, row.used_fallback]), [['failed', 0], ['success', 1]]);
  });

  it('shares one in-flight request for identical concurrent work', async () => {
    const env = createIsolatedDb('lifeos-ai-single-flight-');
    const aiRuntime = env.requireLib('ai.ts');
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const client = { models: { generateContent: async () => {
      calls += 1;
      await gate;
      return { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    } } };
    const params = { model: 'gemini-3.1-pro-preview', contents: 'same prompt' };
    const context = { feature: 'task_prioritization', trigger: 'scheduler' };
    const first = aiRuntime.generateWithFallback(client, params, context);
    const second = aiRuntime.generateWithFallback(client, params, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM ai_usage_events').get().count, 1);
  });

  it('retries one transient 500 on the same model before fallback', async () => {
    const env = createIsolatedDb('lifeos-ai-500-');
    const aiRuntime = env.requireLib('ai.ts');
    const models = [];
    const client = { models: { generateContent: async params => {
      models.push(params.model);
      if (models.length === 1) throw Object.assign(new Error('INTERNAL'), { status: 500 });
      return { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    } } };
    await aiRuntime.generateWithFallback(client, { model: 'gemini-3.1-pro-preview', contents: 'plan' }, { feature: 'next_day_planner' });
    assert.deepEqual(models, ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview']);
  });

  it('does not repeat a timed-out primary request before fallback', async () => {
    const env = createIsolatedDb('lifeos-ai-timeout-');
    const aiRuntime = env.requireLib('ai.ts');
    const models = [];
    const client = { models: { generateContent: async params => {
      models.push(params.model);
      if (params.model === 'gemini-3.1-pro-preview') {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
      }
      return { text: '{}', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
    } } };
    await aiRuntime.generateWithFallback(client, { model: 'gemini-3.1-pro-preview', contents: 'plan timeout' }, { feature: 'next_day_planner' });
    assert.deepEqual(models, ['gemini-3.1-pro-preview', 'gemini-2.5-pro']);
  });
});
