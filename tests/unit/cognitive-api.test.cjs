'use strict';

/**
 * API-level tests for personalization model routes using the real handlers
 * (no HTTP server) — still executes production route code + SQLite.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb, seedPressureLinkedSessions, seedNonUrgentTask } = require('../helpers/temp-db.cjs');

function mockRequest(body) {
  return {
    json: async () => body,
  };
}

describe('personalization model API (B2–B4 route surface)', () => {
  let GET;
  let POST;
  let setSetting;

  before(() => {
    const env = createIsolatedDb('lifeos-cog-api-');
    setSetting = env.setSetting;
    seedPressureLinkedSessions(env.db, 7);
    seedNonUrgentTask(env.db);
    setSetting('cognitive_experiments_v1', '[]');
    ({ GET, POST } = require('../../src/app/api/personalization/model/route.ts'));
  });

  it('GET returns cognitiveTraits, hypotheses, experiments, pressureProfile, activeCoach', async () => {
    const res = await GET();
    const payload = await res.json();
    assert.ok(payload.cognitiveTraits);
    assert.ok(payload.pressureProfile);
    assert.ok(Array.isArray(payload.hypotheses) || Array.isArray(payload.cognitiveTraits.hypotheses));
    assert.ok(payload.experiments);
    assert.ok(payload.selfModel);
    assert.ok(payload.activeCoach, 'GET must expose activeCoach policy');
    assert.ok(payload.plannerBias, 'GET must expose plannerBias summary');
    assert.ok(payload.trajectory, 'GET must expose multi-week trajectory');
    assert.equal(typeof payload.trajectory.enoughData, 'boolean');
    assert.equal(typeof payload.activeCoach.mapTrust?.trusted, 'boolean');
    assert.ok(
      payload.cognitiveTraits.traits.some(t => t.id === 'pressure_dependency'),
    );
  });

  it('POST set_active_coach_mode toggles off and auto', async () => {
    const offRes = await POST(mockRequest({ action: 'set_active_coach_mode', mode: 'off' }));
    assert.equal(offRes.status, 200);
    const offBody = await offRes.json();
    assert.equal(offBody.mode, 'off');
    assert.equal(offBody.activeCoach.mode, 'off');
    assert.equal(offBody.activeCoach.enabled, false);

    const onRes = await POST(mockRequest({ action: 'set_active_coach_mode', mode: 'auto' }));
    const onBody = await onRes.json();
    assert.equal(onBody.mode, 'auto');
    assert.equal(onBody.activeCoach.mode, 'auto');
  });

  it('POST set_stance confirms a trait and returns updated model', async () => {
    const res = await POST(mockRequest({
      action: 'set_stance',
      traitId: 'pressure_dependency',
      stance: 'confirmed',
      note: 'API confirm',
    }));
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.stance, 'confirmed');
    assert.ok(payload.factId != null);
    const trait = payload.cognitiveTraits.traits.find(t => t.id === 'pressure_dependency');
    assert.equal(trait.userStance, 'confirmed');
  });

  it('POST propose_experiment and respond_experiment accept path', async () => {
    setSetting('cognitive_experiments_v1', '[]');
    // Complete any active by clearing store already done
    const proposeRes = await POST(mockRequest({ action: 'propose_experiment' }));
    const proposed = await proposeRes.json();
    assert.equal(proposed.ok, true);
    // May be created:false if traits already offered on GET ensure — force clear
    if (!proposed.experiment) {
      setSetting('cognitive_experiments_v1', '[]');
      const again = await POST(mockRequest({ action: 'propose_experiment' }));
      const againBody = await again.json();
      assert.ok(againBody.experiment, 'expected experiment offer');
      const acceptRes = await POST(mockRequest({
        action: 'respond_experiment',
        experimentId: againBody.experiment.id,
        response: 'accepted',
      }));
      const accepted = await acceptRes.json();
      assert.equal(accepted.ok, true);
      assert.equal(accepted.experiment.status, 'accepted');
      return;
    }

    const acceptRes = await POST(mockRequest({
      action: 'respond_experiment',
      experimentId: proposed.experiment.id,
      response: 'declined',
    }));
    const declined = await acceptRes.json();
    assert.equal(declined.ok, true);
    assert.equal(declined.experiment.status, 'declined');
  });

  it('POST rejects invalid traitId', async () => {
    const res = await POST(mockRequest({
      action: 'set_stance',
      traitId: 'not_a_trait',
      stance: 'confirmed',
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});
