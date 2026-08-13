'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Guardian Evidence V2 canonical timeline', { concurrency: false }, () => {
  function setup(mode = 'authoritative') {
    const env = createIsolatedDb('lifeos-guardian-evidence-v2-');
    const db = env.db;
    const store = env.requireLib('guardian-evidence-store.ts');
    const base = Date.parse('2030-01-01T10:00:00.000Z');
    const sessionId = `session-evidence-${Math.random()}`;
    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state, evidence_pipeline_mode
      ) VALUES (?, 'Evidence test', ?, 30, 'ACTIVE', ?)
    `).run(sessionId, base, mode);
    return { env, db, store, base, sessionId };
  }

  function native(context, id, start, end, overrides = {}) {
    const { base, sessionId } = context;
    return {
      schemaVersion: 2,
      eventId: id,
      sequence: Number(id.replace(/\D/g, '')) || 1,
      collector: 'native',
      collectorVersion: '0.3.0',
      deviceId: 'macbook-primary',
      sessionId,
      observedStart: new Date(base + start).toISOString(),
      observedEnd: new Date(base + end).toISOString(),
      capabilities: ['frontmost_app', 'input_idle'],
      privacy: { decision: 'allow', reason: 'guardian_session' },
      native: {
        frontmostApp: 'Google Chrome', windowTitle: 'Lecture', systemState: 'active',
        inputIdleSeconds: 0, screenRecordingStatus: 'authorized', captureCapable: true,
        sensitive: false, ...overrides,
      },
      chrome: null,
    };
  }

  function chrome(context, id, start, end, overrides = {}) {
    const { base, sessionId } = context;
    return {
      schemaVersion: 2,
      eventId: id,
      sequence: Number(id.replace(/\D/g, '')) || 1,
      collector: 'chrome',
      collectorVersion: '1.3.0',
      deviceId: 'chrome-primary',
      sessionId,
      observedStart: new Date(base + start).toISOString(),
      observedEnd: new Date(base + end).toISOString(),
      capabilities: ['active_tab', 'interaction', 'media_progress'],
      privacy: { decision: 'allow', reason: 'guardian_session' },
      native: null,
      chrome: {
        windowFocused: true,
        url: 'https://ocw.mit.edu/lecture', domain: 'ocw.mit.edu', title: 'Lecture',
        interaction: { keyboard: false, pointer: false, scroll: false, navigation: false, lastInputAt: null },
        media: { playing: true, progressed: true, currentTime: 25, title: 'Lecture' },
        ...overrides,
      },
    };
  }

  it('selects one time-aligned source per five-second slice and keeps the last 15 seconds provisional', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    const result = store.ingestGuardianEvidence([
      native(context, 'native-1', 0, 10_000),
      chrome(context, 'chrome-1', 0, 10_000),
      native(context, 'native-2', 10_000, 20_000, { frontmostApp: 'Preview', windowTitle: 'Algorithms.pdf' }),
    ], base + 25_000);
    assert.equal(result.accepted, 3);

    const slices = db.prepare(`
      SELECT slice_start, source, engagement_state, score_eligible, counted, provisional
      FROM guardian_activity_slices WHERE session_id = ? ORDER BY slice_start
    `).all(sessionId);
    assert.equal(slices.length, 5);
    assert.deepEqual(slices.slice(0, 2).map(row => [row.source, row.engagement_state, row.provisional]), [
      ['chrome', 'passive_engaged', 0],
      ['chrome', 'passive_engaged', 0],
    ]);
    assert.equal(slices[2].source, 'vision');
    assert.equal(slices[2].provisional, 1);
    assert.equal(new Set(slices.map(row => row.slice_start)).size, slices.length);
  });

  it('uses UTC-aligned buckets without counting time before the session began', () => {
    const context = setup();
    const shiftedStart = context.base + 1_234;
    context.base = shiftedStart;
    context.db.prepare(`UPDATE guardian_sessions SET started_at = ? WHERE session_id = ?`)
      .run(shiftedStart, context.sessionId);
    context.store.ingestGuardianEvidence([
      native(context, 'native-aligned', 0, 8_766, { frontmostApp: 'Preview' }),
    ], shiftedStart + 8_766);
    context.store.canonicalizeGuardianSession(context.sessionId, shiftedStart + 30_000, shiftedStart + 8_766);
    const row = context.db.prepare(`
      SELECT MIN(slice_bucket) AS bucket, MIN(slice_start) AS started,
             SUM(duration_seconds) AS seconds
      FROM guardian_activity_slices WHERE session_id = ?
    `).get(context.sessionId);
    assert.equal(Date.parse(row.bucket) % 5_000, 0);
    assert.equal(row.started, new Date(shiftedStart).toISOString());
    assert.equal(row.seconds, 8.766);
  });

  it('uses native frontmost evidence to suppress background Chrome', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    store.ingestGuardianEvidence([
      native(context, 'native-3', 0, 10_000, { frontmostApp: 'Visual Studio Code', windowTitle: 'guardian.ts' }),
      chrome(context, 'chrome-3', 0, 10_000),
    ], base + 30_000);
    const sources = db.prepare(`
      SELECT DISTINCT source FROM guardian_activity_slices
      WHERE session_id = ? AND provisional = 0
    `).all(sessionId).map(row => row.source);
    assert.equal(sources.includes('vision'), true);
    assert.equal(sources.includes('chrome'), false);
  });

  it('falls back to Vision when Chrome evidence is absent and never rewrites a finalized slice', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    store.ingestGuardianEvidence([native(context, 'native-4', 0, 10_000)], base + 30_000);
    assert.equal(db.prepare(`
      SELECT source FROM guardian_activity_slices
      WHERE session_id = ? AND slice_start = ?
    `).pluck().get(sessionId, new Date(base).toISOString()), 'vision');

    store.ingestGuardianEvidence([chrome(context, 'chrome-4', 0, 10_000)], base + 31_000);
    assert.equal(db.prepare(`
      SELECT source FROM guardian_activity_slices
      WHERE session_id = ? AND slice_start = ?
    `).pluck().get(sessionId, new Date(base).toISOString()), 'vision');
    assert.equal(db.prepare(`
      SELECT late_after_watermark FROM guardian_evidence_events WHERE event_id = 'chrome-4'
    `).pluck().get(), 1);
  });

  it('deduplicates retries and treats lock and privacy as unscored', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    const locked = native(context, 'native-5', 0, 5_000, { systemState: 'locked' });
    const privateEvent = native(context, 'native-6', 5_000, 10_000, {
      frontmostApp: 'Sensitive App', sensitive: true,
    });
    privateEvent.privacy = { decision: 'redact', reason: 'sensitive_window' };
    assert.equal(store.ingestGuardianEvidence([locked, privateEvent], base + 30_000).accepted, 2);
    assert.equal(store.ingestGuardianEvidence([locked], base + 30_000).duplicates, 1);
    const rows = db.prepare(`
      SELECT source, score_eligible FROM guardian_activity_slices
      WHERE session_id = ? AND slice_start < ? ORDER BY slice_start
    `).all(sessionId, new Date(base + 10_000).toISOString());
    assert.deepEqual(rows, [
      { source: 'idle', score_eligible: 0 },
      { source: 'private', score_eligible: 0 },
    ]);
  });

  it('rejects incompatible collector evidence from canonical selection', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    const oldChrome = chrome(context, 'chrome-7', 0, 10_000);
    oldChrome.collectorVersion = '1.2.0';
    const result = store.ingestGuardianEvidence([native(context, 'native-7', 0, 10_000), oldChrome], base + 30_000);
    assert.equal(result.incompatible.length, 1);
    assert.equal(db.prepare(`
      SELECT source FROM guardian_activity_slices
      WHERE session_id = ? ORDER BY slice_start LIMIT 1
    `).pluck().get(sessionId), 'vision');
  });

  it('records a cutover report without making shadow slices authoritative', () => {
    const context = setup('shadow');
    const { db, store, base, sessionId } = context;
    db.prepare(`
      INSERT INTO session_activity_intervals (
        interval_id, session_id, device_id, source, observed_start, observed_end,
        duration_seconds, state, category, score_eligible, counted,
        selection_reason, capture_status
      ) VALUES ('legacy-shadow', ?, 'chrome-primary', 'chrome', ?, ?, 30, 'active', 'productive', 1, 1,
                'legacy bridge', 'verified')
    `).run(sessionId, new Date(base).toISOString(), new Date(base + 30_000).toISOString());
    store.ingestGuardianEvidence([
      native(context, 'native-shadow', 0, 30_000),
      chrome(context, 'chrome-shadow', 0, 30_000),
    ], base + 30_000);
    store.canonicalizeGuardianSession(sessionId, base + 50_000, base + 30_000);

    assert.equal(db.prepare(`
      SELECT SUM(counted) FROM guardian_activity_slices WHERE session_id = ?
    `).pluck().get(sessionId), 0);
    const shadow = envRequire(context, 'guardian-evidence-shadow.ts');
    const report = shadow.recordGuardianShadowReport({
      sessionId,
      tick: 1,
      startedAt: base,
      totalPausedMs: 0,
      tabEventLog: [],
      focusScoreHistory: [70],
      screenContext: null,
      sessionPolicy: null,
      energyComposite: null,
    });
    assert.equal(report.accepted, true);
    assert.equal(report.canonicalSeconds, 30);
    assert.equal(shadow.getGuardianShadowRolloutStatus().eligibleForCutover, false);
  });

  it('treats input inactivity as uncertain and preserves category after presence confirmation', () => {
    const context = setup();
    const { db, store, base, sessionId } = context;
    store.ingestGuardianEvidence([
      native(context, 'native-uncertain-1', 0, 60_000, { frontmostApp: 'Preview', inputIdleSeconds: 600 }),
      native(context, 'native-uncertain-2', 60_000, 120_000, { frontmostApp: 'Preview', inputIdleSeconds: 600 }),
      native(context, 'native-uncertain-3', 120_000, 180_000, { frontmostApp: 'Preview', inputIdleSeconds: 600 }),
    ], base + 180_000);
    store.canonicalizeGuardianSession(sessionId, base + 200_000, base + 180_000);
    const before = db.prepare(`
      SELECT DISTINCT source, state, engagement_state, score_eligible, category
      FROM guardian_activity_slices WHERE session_id = ? AND provisional = 0
    `).all(sessionId);
    assert.deepEqual(before, [{
      source: 'vision', state: 'active', engagement_state: 'uncertain',
      score_eligible: 0, category: 'neutral',
    }]);

    const presence = context.env.requireLib('guardian-presence.ts');
    const observed = presence.observeFinalizedUncertainEvidence(sessionId, base + 200_000);
    assert.ok(observed.check?.checkId);
    presence.resolvePresenceCheck(observed.check.checkId, 'still_working', base + 201_000, sessionId);
    const after = db.prepare(`
      SELECT DISTINCT engagement_state, score_eligible, category
      FROM guardian_activity_slices WHERE session_id = ? AND provisional = 0
    `).all(sessionId);
    assert.deepEqual(after, [{ engagement_state: 'confirmed_active', score_eligible: 1, category: 'neutral' }]);
  });
});

function envRequire(context, file) {
  return context.env.requireLib(file);
}
