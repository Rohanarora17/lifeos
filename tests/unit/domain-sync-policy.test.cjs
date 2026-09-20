'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

describe('cross-tab domain sync policy', () => {
  it('creates a tab origin when randomUUID is unavailable on LAN HTTP', () => {
    registerTypescript(path.resolve(__dirname, '../..'));
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const policyPath = require.resolve('../../src/lib/domain-sync.ts');
    const clientIdPath = require.resolve('../../src/lib/polyfill-crypto-uuid.ts');
    const fakeCrypto = {
      getRandomValues(bytes) {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
        return bytes;
      },
    };

    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: fakeCrypto,
      });
      delete require.cache[policyPath];
      delete require.cache[clientIdPath];
      const policy = require(policyPath);

      assert.match(
        policy.createDomainSyncOrigin(),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      delete require.cache[policyPath];
      delete require.cache[clientIdPath];
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else delete globalThis.crypto;
    }
  });

  it('reloads only for a newer revision produced outside the current tab', () => {
    registerTypescript(path.resolve(__dirname, '../..'));
    let policy = null;
    try {
      policy = require('../../src/lib/domain-sync.ts');
    } catch {
      // Expected during the first TDD run.
    }
    assert.equal(typeof policy?.shouldReloadForDomainRevision, 'function');
    assert.equal(policy.shouldReloadForDomainRevision(4, 5, false), true);
    assert.equal(policy.shouldReloadForDomainRevision(5, 5, false), false);
    assert.equal(policy.shouldReloadForDomainRevision(6, 5, false), false);
    assert.equal(policy.shouldReloadForDomainRevision(4, 5, true), false);
  });
});
