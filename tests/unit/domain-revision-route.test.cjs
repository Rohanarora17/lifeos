'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('domain revision API', () => {
  it('returns the latest canonical mutation revision without caching', async () => {
    const { db } = createIsolatedDb('lifeos-domain-revision-route-');
    db.prepare("INSERT INTO tasks (title, status) VALUES ('Graphs', 'todo')").run();

    let route = null;
    try {
      route = require('../../src/app/api/system/revision/route.ts');
    } catch {
      // Expected during the first TDD run.
    }
    assert.equal(typeof route?.GET, 'function');

    const response = await route.GET();
    const body = await response.json();
    assert.equal(body.revision, 1);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
