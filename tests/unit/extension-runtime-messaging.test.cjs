'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let runtimeMessaging = {};
try {
  runtimeMessaging = require('../../extension/runtime-messaging.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}

describe('extension runtime messaging', () => {
  it('loads the safe runtime helper before Guardian in extension release 1.3.3', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../extension/manifest.json'),
      'utf8',
    ));
    assert.equal(manifest.version, '1.3.3');
    assert.deepEqual(manifest.content_scripts[0].js, ['runtime-messaging.js', 'guardian.js']);
  });

  it('turns an invalidated extension context into a handled delivery result', async () => {
    const send = runtimeMessaging.sendRuntimeMessage;
    const result = typeof send === 'function'
      ? await send({ runtime: undefined }, { type: 'GUARDIAN_PAGE_EVIDENCE' })
      : null;

    assert.deepEqual(result, {
      delivered: false,
      error: 'extension_context_invalidated',
      response: null,
    });
  });

  it('handles both synchronous invalidation and rejected delivery without throwing', async () => {
    const send = runtimeMessaging.sendRuntimeMessage;
    const synchronous = {
      runtime: {
        id: 'lifeos-test',
        sendMessage() { throw new Error('Extension context invalidated.'); },
      },
    };
    const rejected = {
      runtime: {
        id: 'lifeos-test',
        sendMessage() { return Promise.reject(new Error('Extension context invalidated.')); },
      },
    };

    const syncResult = typeof send === 'function' ? await send(synchronous, { type: 'PING' }) : null;
    const rejectedResult = typeof send === 'function' ? await send(rejected, { type: 'PING' }) : null;
    assert.equal(syncResult?.error, 'extension_context_invalidated');
    assert.equal(rejectedResult?.error, 'extension_context_invalidated');
  });
});
