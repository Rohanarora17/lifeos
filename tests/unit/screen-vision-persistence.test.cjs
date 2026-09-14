'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('screen vision persistence', () => {
  it('stores one analyzed Vision signal in the migrated observation schema', () => {
    const env = createIsolatedDb('lifeos-screen-vision-persistence-');
    const { persistVisionSignal } = env.requireLib('screen-vision.ts');
    const capturedAt = Date.parse('2026-09-14T00:00:00.000Z');

    persistVisionSignal({
      taskAlignment: 92,
      engagementDepth: 'active_learning',
      appInFocus: 'Notability',
      windowTitle: 'Graphs notes',
      contentSummary: 'Reviewing graph traversal notes.',
      specificContent: 'Breadth-first search recurrence',
      distractionIndicators: [],
      progressIndicator: 'Added a worked example',
      confidence: 0.93,
      changeFromPrevious: 'moderate',
      capturedAt,
    }, null);

    const row = env.db.prepare(`
      SELECT observed_at, source, app, window_title, activity, category,
        attention_quality, specific_content, productive_for_goals, confidence,
        session_id, task_alignment, engagement_depth, distraction_indicators,
        progress_indicator, change_magnitude
      FROM screen_observations
    `).get();

    assert.deepEqual(row, {
      observed_at: '2026-09-14T00:00:00.000Z',
      source: 'screen_vision',
      app: 'Notability',
      window_title: 'Graphs notes',
      activity: 'Reviewing graph traversal notes.',
      category: 'deep_work',
      attention_quality: 'focused',
      specific_content: 'Breadth-first search recurrence',
      productive_for_goals: 1,
      confidence: 0.93,
      session_id: null,
      task_alignment: 92,
      engagement_depth: 'active_learning',
      distraction_indicators: '[]',
      progress_indicator: 'Added a worked example',
      change_magnitude: 'moderate',
    });
  });
});
