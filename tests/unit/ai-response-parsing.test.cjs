'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseActivityClassificationResponse } = require('../../src/lib/ai-response-parsing.ts');

describe('activity classification response parsing', () => {
  it('parses a valid JSON array', () => {
    const parsed = parseActivityClassificationResponse('[{"id":0,"category":"productive"}]');
    assert.equal(parsed[0].category, 'productive');
  });

  it('recovers the first complete JSON array when a model appends extra text', () => {
    const parsed = parseActivityClassificationResponse(
      '[{"id":0,"category":"productive","reasoning":"BFS [graph] lecture"}]\nExtra response',
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].reasoning, 'BFS [graph] lecture');
  });

  it('rejects output without a complete array', () => {
    assert.throws(() => parseActivityClassificationResponse('{"id":0}'), /JSON array/);
  });
});
