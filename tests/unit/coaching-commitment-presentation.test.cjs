'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('coaching commitment presentation', () => {
  const env = createIsolatedDb('lifeos-coaching-presentation-');
  const { getCommitmentPresentation } = env.requireLib('coaching-commitment-presentation.ts');

  it('presents a future scheduled commitment as upcoming', () => {
    const presentation = getCommitmentPresentation({
      state: 'scheduled',
      plannedStartAt: '2026-09-14T17:30:00.000Z',
    }, new Date('2026-09-13T23:30:00.000Z'));

    assert.equal(presentation.isUpcoming, true);
    assert.equal(presentation.primaryActionLabel, 'Start early');
    assert.equal(presentation.showBlockerPrompt, false);
    assert.match(presentation.statusMessage, /scheduled time/i);
  });

  it('asks for a blocker only after the planned start has passed', () => {
    const presentation = getCommitmentPresentation({
      state: 'missed',
      plannedStartAt: '2026-09-14T17:30:00.000Z',
    }, new Date('2026-09-14T17:36:00.000Z'));

    assert.equal(presentation.isUpcoming, false);
    assert.equal(presentation.primaryActionLabel, 'Start now');
    assert.equal(presentation.showBlockerPrompt, true);
  });
});
