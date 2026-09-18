'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

describe('cross-tab domain sync policy', () => {
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
