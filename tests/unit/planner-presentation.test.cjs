'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

registerTypescript(process.cwd());

describe('adaptive planner presentation', () => {
  it('uses today-specific labels when revising the current plan', () => {
    const { getPlannerLabels } = require('../../src/lib/planner-presentation.ts');
    assert.deepEqual(getPlannerLabels('today'), {
      title: 'Adaptive Day Planner',
      intentionLabel: 'Context for the rest of today',
      blocksLabel: 'Remaining Today Blocks',
      generateLabel: 'Replan Today',
    });
  });

  it('shows the calendar date for a block that crosses midnight', () => {
    const { formatPlannerSessionStart } = require('../../src/lib/planner-presentation.ts');
    assert.equal(
      formatPlannerSessionStart('2026-09-15T01:00:00.000+05:30'),
      'Tue, 15 Sep · 01:00',
    );
  });

  it('keeps a failed AI replan visible instead of replacing the current plan', () => {
    const { plannerApiErrorMessage } = require('../../src/lib/planner-presentation.ts');
    assert.equal(plannerApiErrorMessage({ success: false, error: 'unsafe AI schedule' }), 'unsafe AI schedule');
    assert.equal(plannerApiErrorMessage({ success: true }), null);
  });
});
