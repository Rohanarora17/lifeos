'use strict';
/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');
registerTypescript(root);

const {
  buildGuardianDurationOptions,
} = require('../../src/lib/guardian-session-options.ts');

describe('Guardian session start form', () => {
  it('creates a UUID when randomUUID is unavailable on LAN HTTP', () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const cryptoModulePath = require.resolve('../../src/lib/polyfill-crypto-uuid.ts');
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
      delete require.cache[cryptoModulePath];
      const { createClientRequestId } = require(cryptoModulePath);
      assert.match(
        createClientRequestId(),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      delete require.cache[cryptoModulePath];
      if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
      else delete globalThis.crypto;
    }
  });

  it('keeps all standard manual durations in planning mode', () => {
    const options = buildGuardianDurationOptions({
      adaptiveDuration: 45,
      plannedMinutes: 45,
      mode: 'planning',
      energy: 'medium',
    });
    const minutes = options.map(option => option.minutes);

    assert.ok(minutes.includes(30));
    assert.ok(minutes.includes(25));
    assert.ok(minutes.includes(45));
    assert.ok(minutes.includes(60));
    assert.ok(minutes.includes(90));
    assert.ok(minutes.includes(120));
  });

  it('does not lose a manually selected non-standard duration', () => {
    const options = buildGuardianDurationOptions({
      adaptiveDuration: 45,
      mode: 'planning',
      selectedMinutes: 35,
    });

    assert.equal(options.find(option => option.minutes === 35)?.label, 'Selected');
  });
});
