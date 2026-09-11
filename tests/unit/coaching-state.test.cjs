'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

function isoDaysAgo(days, extraMinutes = 0) {
  return new Date(Date.now() - days * 86_400_000 - extraMinutes * 60_000).toISOString();
}

describe('active coaching engagement and recovery', () => {
  let env;
  let db;
  let coaching;
  let adaptive;

  beforeEach(() => {
    env = createIsolatedDb('lifeos-coaching-');
    db = env.db;
    coaching = env.requireLib('coaching-state.ts');
    adaptive = env.requireLib('adaptive-command-defaults.ts');
  });

  function seedAbsentWeek() {
    try {
    db.prepare(`
      INSERT INTO tasks (title, status, priority, due_date, created_at, updated_at)
      VALUES ('Learn dynamic programming', 'doing', 'high', date('now', '-5 days'), datetime('now', '-14 days'), datetime('now', '-8 days'))
    `).run();
    db.prepare(`
      INSERT INTO daily_checkins (checkin_date, checkin_type, raw_transcript, received_at)
      VALUES (date('now', '-8 days'), 'morning', 'old commitment', datetime('now', '-8 days'))
    `).run();
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES ('old-session', 'DSA', 30, 20, 70, 70, datetime('now', '-8 days'), datetime('now', '-8 days'))
    `).run();
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, status, created_at, updated_at)
      VALUES (date('now', '-3 days'), 'active', datetime('now', '-4 days'), datetime('now', '-4 days'))
    `).run();
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO planned_focus_sessions (
          id, plan_id, title, planned_start, planned_end, duration_minutes, status
        ) VALUES (?, ?, 'DSA practice', ?, ?, 30, 'planned')
      `).run(`missed-${i}`, plan.lastInsertRowid, isoDaysAgo(3 - i), isoDaysAgo(3 - i, -30));
    }
    } catch (error) {
      throw new Error(`Failed to seed absent week: ${error.message}`, { cause: error });
    }
  }

  it('changes strategy after an absent week', () => {
    seedAbsentWeek();
    const state = coaching.getCoachingState();
    assert.equal(state.engagement, 'disengaged');
    assert.equal(state.missedOpportunities, 2);
    assert.equal(state.overdueTasks, 1);
    assert.match(state.reason, /recovery conversation/i);
    assert.equal(coaching.shouldSuppressRoutineCoaching('deadline').suppress, true);
    assert.equal(coaching.shouldSuppressRoutineCoaching('deadline').suppress, true);
    const suppressions = db.prepare(`
      SELECT COUNT(*) AS count FROM coaching_decisions
      WHERE action_type = 'suppress_routine'
    `).get();
    assert.equal(suppressions.count, 1);
    assert.match(coaching.buildRecoveryMessage(state), /Repeating the old reminders will not solve/i);
    assert.equal(adaptive.getAdaptiveSessionMinuteDecision().minutes, 10);
    assert.equal(adaptive.getAdaptiveSessionMinuteDecision(25).minutes, 25);
  });

  it('does not turn missing collector evidence into disengagement', () => {
    db.prepare(`
      INSERT INTO tasks (title, status, priority, created_at, updated_at)
      VALUES ('Current work', 'doing', 'medium', datetime('now', '-4 days'), datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO coaching_events (event_type, source, occurred_at, payload_json)
      VALUES ('human_contact', 'test', ?, '{}')
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES ('recent', 'Current work', 20, 20, 75, 75, datetime('now'), datetime('now', '-20 minutes'))
    `).run();
    const state = coaching.getCoachingState();
    assert.equal(state.coverage, 'missing');
    assert.equal(state.engagement, 'active');
  });

  it('uses shared collector evidence and reports incomplete device coverage as partial', () => {
    const now = new Date('2030-01-01T10:00:00.000Z');
    const client = env.requireLib('guardian-client-status.ts');
    client.recordNativeClientHeartbeat({
      deviceId: 'macbook',
      clientVersion: '0.3.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Google Chrome',
      systemState: 'active',
      observedAt: now.toISOString(),
    });
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'chrome:macbook',
      collectorVersion: '1.3.3',
      windowFocused: true,
      observedAt: new Date(now.getTime() - 5_000).toISOString(),
    });

    const state = coaching.getCoachingState({ now });
    assert.deepEqual(state.coverageSources, {
      chrome: 'current',
      macbookVision: 'current',
      phone: 'missing',
    });
    assert.equal(state.coverage, 'partial');
    assert.equal(state.lastEvidenceAt, now.toISOString());
  });

  it('uses observed UTC evidence time instead of timezone-free ingestion time', () => {
    const now = new Date('2030-01-01T10:01:00.000Z');
    db.prepare(`
      INSERT INTO telemetry_events_v1 (
        event_id, version, device_id, source, observed_start, observed_end,
        duration_seconds, state, session_id, provenance_json, privacy_decision,
        privacy_reason, ingested_at
      ) VALUES ('utc-evidence', 1, 'macbook', 'browser_extension', ?, ?, 30,
                'active', NULL, '{}', 'allow', 'waking_hours_metadata', '2030-01-01 10:00:30')
    `).run('2030-01-01T10:00:00.000Z', '2030-01-01T10:00:30.000Z');

    const state = coaching.getCoachingState({ now });
    assert.equal(state.coverageSources.chrome, 'current');
    assert.equal(state.lastEvidenceAt, '2030-01-01T10:00:30.000Z');
  });

  it('treats bounded device clock skew as current evidence', () => {
    const now = new Date();
    const client = env.requireLib('guardian-client-status.ts');
    const ahead = new Date(now.getTime() + 3 * 60_000).toISOString();
    client.recordNativeClientHeartbeat({
      deviceId: 'skewed-macbook',
      clientVersion: '0.3.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Google Chrome',
      systemState: 'active',
      observedAt: ahead,
    });
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'skewed-chrome',
      collectorVersion: '1.3.3',
      windowFocused: true,
      observedAt: ahead,
    });

    const state = coaching.getCoachingState({ now });
    assert.equal(state.coverageSources.chrome, 'current');
    assert.equal(state.coverageSources.macbookVision, 'current');
  });

  it('describes same-day participation without displaying zero days', () => {
    const now = new Date();
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('history_start_date', ?)`)
      .run(now.toISOString().slice(0, 10));
    db.prepare(`
      INSERT INTO coaching_events (event_type, source, occurred_at, payload_json)
      VALUES ('human_contact', 'test', ?, '{}')
    `).run(new Date(now.getTime() - 60_000).toISOString());
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES ('today-session', 'Graphs', 20, 20, 80, 80, ?, ?)
    `).run(
      new Date(now.getTime() - 30_000).toISOString(),
      new Date(now.getTime() - 20 * 60_000).toISOString(),
    );

    const state = coaching.getCoachingState({ now });
    assert.ok(state.evidence.includes('Meaningful interaction today'));
    assert.ok(state.evidence.includes('Focus session completed today'));
    assert.equal(state.evidence.some(item => item.startsWith('0 days')), false);
  });

  it('does not revive pre-reset backlog as a fresh recovery failure', () => {
    const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('history_start_date', ?)`).run(today);
    db.prepare(`
      INSERT INTO tasks (title, status, priority, due_date, created_at, updated_at)
      VALUES ('Old backlog', 'doing', 'high', date('now', '-20 days'), datetime('now', '-40 days'), datetime('now', '-30 days'))
    `).run();
    const state = coaching.getCoachingState();
    assert.equal(state.overdueTasks, 0);
    assert.equal(state.engagement, 'active');
  });

  it('keeps recovery unresolved after a reply until action follows', () => {
    seedAbsentWeek();
    const episode = coaching.ensureRecoveryEpisode();
    assert.ok(episode);
    assert.equal(coaching.getCoachingState().engagement, 'disengaged');
    coaching.recordHumanContact('test_reply');
    const response = coaching.handleRecoveryResponse('I am overwhelmed by everything that is overdue');
    assert.equal(response.handled, true);
    assert.match(response.reply, /backlog/i);
    const state = coaching.getCoachingState();
    assert.equal(state.engagement, 'reconnecting');
    assert.equal(state.episode.blockerKind, 'overload');
    assert.equal(state.episode.acceptedAt, null);
  });

  it('requires two completed restart sessions before returning active', () => {
    seedAbsentWeek();
    coaching.ensureRecoveryEpisode();
    coaching.recordHumanContact('test_reply');
    coaching.handleRecoveryResponse('I was tired and could not start');
    const accepted = coaching.acceptRecoveryRestart({ minutes: 5 });
    assert.equal(accepted.engagement, 'reconnecting');
    const acceptedAt = accepted.episode.acceptedAt;
    for (let i = 0; i < 2; i++) {
      const completedAt = new Date(new Date(acceptedAt).getTime() + (i + 1) * 60_000).toISOString();
      db.prepare(`
        INSERT INTO guardian_session_summaries (
          session_id, target_title, duration_minutes, elapsed_minutes,
          average_focus_score, final_focus_score, completed_at, started_at
        ) VALUES (?, 'Restart', 5, 5, 70, 70, ?, ?)
      `).run(`restart-${i}`, completedAt, completedAt);
    }
    const state = coaching.getCoachingState({ now: new Date(new Date(acceptedAt).getTime() + 5 * 60_000) });
    assert.equal(state.engagement, 'active');
    assert.equal(state.episode, null);
  });

  it('deduplicates recovery outreach by local day', () => {
    seedAbsentWeek();
    const state = coaching.getCoachingState();
    const episode = coaching.ensureRecoveryEpisode(state);
    assert.equal(coaching.recoveryOutreachDue(state), true);
    const key = `recovery:${coaching.localDateKey()}`;
    coaching.recordCoachingDecision({
      episodeId: episode.id,
      actionType: 'recovery_outreach',
      status: 'sent',
      reason: 'test',
      dedupeKey: key,
    });
    assert.equal(coaching.recoveryOutreachDue(coaching.getCoachingState()), false);
  });

  it('honors pause and resume explicitly', () => {
    seedAbsentWeek();
    coaching.ensureRecoveryEpisode();
    assert.equal(coaching.setCoachingPaused(true).engagement, 'paused');
    const resumed = coaching.setCoachingPaused(false);
    assert.equal(resumed.engagement, 'reconnecting');
  });
});
