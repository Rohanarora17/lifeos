'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

describe('Telegram update transport', () => {
  afterEach(() => { delete process.env.LIFEOS_API_TOKEN; });

  it('forwards command and callback updates unchanged to the application webhook', async () => {
    let transport = null;
    try {
      transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    } catch { /* RED until the transport is implemented */ }
    assert.equal(typeof transport?.forwardTelegramUpdate, 'function');

    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const command = { update_id: 10, message: { chat: { id: 123 }, text: '/addtask Write tests' } };
    const callback = { update_id: 11, callback_query: { id: 'cb-1', data: 'task:start:7', message: { chat: { id: 123 } } } };

    assert.equal(await transport.forwardTelegramUpdate({ appUrl: 'http://lifeos.test', update: command, fetchImpl: fakeFetch }), true);
    assert.equal(await transport.forwardTelegramUpdate({ appUrl: 'http://lifeos.test/', update: callback, fetchImpl: fakeFetch }), true);
    assert.deepEqual(seen, [
      { url: 'http://lifeos.test/api/telegram/webhook', body: command },
      { url: 'http://lifeos.test/api/telegram/webhook', body: callback },
    ]);
  });

  it('authenticates forwarded updates with the LifeOS API token', async () => {
    const transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    let authorization = null;
    const ok = await transport.forwardTelegramUpdate({
      appUrl: 'http://lifeos.test',
      apiToken: 'internal-api-token',
      update: { update_id: 12, callback_query: { id: 'cb-auth', data: 'commit:block:4' } },
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init.headers).get('Authorization');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(ok, true);
    assert.equal(authorization, 'Bearer internal-api-token');
  });

  it('preserves LifeOS authentication through batched update delivery', async () => {
    const transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    const authorizations = [];
    const result = await transport.deliverTelegramUpdates({
      appUrl: 'http://lifeos.test',
      apiToken: 'batch-api-token',
      updates: [{ update_id: 13 }, { update_id: 14 }],
      fetchImpl: async (_url, init) => {
        authorizations.push(new Headers(init.headers).get('Authorization'));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.deepEqual(result, { nextOffset: 15, delivered: 2 });
    assert.deepEqual(authorizations, ['Bearer batch-api-token', 'Bearer batch-api-token']);
  });

  it('uses the daemon LIFEOS_API_TOKEN when the poller caller does not pass one', async () => {
    process.env.LIFEOS_API_TOKEN = 'daemon-environment-token';
    const transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    let authorization = null;
    const result = await transport.deliverTelegramUpdates({
      appUrl: 'http://lifeos.test',
      updates: [{ update_id: 15 }],
      fetchImpl: async (_url, init) => {
        authorization = new Headers(init.headers).get('Authorization');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.deepEqual(result, { nextOffset: 16, delivered: 1 });
    assert.equal(authorization, 'Bearer daemon-environment-token');
  });

  it('does not advance past a failed application delivery', async () => {
    let transport = null;
    try {
      transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    } catch { /* RED until the transport is implemented */ }
    assert.equal(typeof transport?.deliverTelegramUpdates, 'function');

    let calls = 0;
    const result = await transport.deliverTelegramUpdates({
      appUrl: 'http://lifeos.test',
      updates: [{ update_id: 20 }, { update_id: 21 }],
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: calls === 1 ? 503 : 200 });
      },
    });
    assert.deepEqual(result, { nextOffset: null, delivered: 0 });
    assert.equal(calls, 1);
  });

  it('advances through successful updates but retains the first failed update for retry', async () => {
    const transport = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/telegram-update-forwarder.mjs')).href);
    let calls = 0;
    const result = await transport.deliverTelegramUpdates({
      appUrl: 'http://lifeos.test',
      updates: [{ update_id: 30 }, { update_id: 31 }, { update_id: 32 }],
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: calls === 2 ? 503 : 200 });
      },
    });
    assert.deepEqual(result, { nextOffset: 31, delivered: 1 });
    assert.equal(calls, 2);
  });
});
