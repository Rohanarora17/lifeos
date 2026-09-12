'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  countMeaningfulContextSwitches,
  countDistractionRevisits,
  averageContinuousDwellSeconds,
} = require('../../src/lib/guardian-continuity.ts');

function tab(url, classification = 'on_topic') {
  return { type: 'tab', url, payload: { classification } };
}

describe('Guardian continuity signals', () => {
  it('does not treat repeated telemetry for one page as tab switches', () => {
    const events = Array.from({ length: 12 }, () => tab('https://youtube.com/watch?v=bfs'));
    assert.equal(countMeaningfulContextSwitches(events), 0);
  });

  it('counts actual context transitions', () => {
    const events = [
      tab('https://youtube.com/watch?v=bfs'),
      tab('https://youtube.com/watch?v=bfs'),
      tab('https://notes.example/bfs'),
      { type: 'native_context', payload: { appInFocus: 'Notability' } },
      { type: 'native_context', payload: { appInFocus: 'Notability' } },
    ];
    assert.equal(countMeaningfulContextSwitches(events), 2);
  });

  it('counts revisits only after leaving and returning to a distraction', () => {
    const events = [
      tab('https://instagram.com/reels/1', 'distraction'),
      tab('https://instagram.com/reels/1', 'distraction'),
      tab('https://youtube.com/watch?v=bfs', 'on_topic'),
      tab('https://instagram.com/reels/2', 'distraction'),
    ];
    assert.equal(countDistractionRevisits(events), 1);
  });

  it('combines repeated dwell reports for the same page and ignores native Chrome fallback', () => {
    const events = [
      { ...tab('https://youtube.com/watch?v=bfs'), dwellSeconds: 30 },
      { type: 'native_context', dwellSeconds: 9, payload: { appInFocus: 'Google Chrome' } },
      { ...tab('https://youtube.com/watch?v=bfs'), dwellSeconds: 30 },
    ];
    assert.equal(countMeaningfulContextSwitches(events), 0);
    assert.equal(averageContinuousDwellSeconds(events), 60);
  });
});
