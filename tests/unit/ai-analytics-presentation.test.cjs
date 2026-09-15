'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('AI analytics presentation', () => {
  it('distinguishes recovered operations from terminal failures', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/app/analytics/page.tsx'), 'utf8');
    assert.match(source, /Recovered operations/);
    assert.match(source, /Terminal failures/);
    assert.match(source, /Reasoning share/);
    assert.match(source, /By work class/);
    assert.doesNotMatch(source, /label="Failures"/);
  });
});
