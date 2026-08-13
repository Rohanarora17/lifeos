import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getActiveGuardianSession, pauseGuardianSession, tickGuardianSession } from '@/lib/guardian-runtime';
import { touchIntelligence } from '@/lib/intelligence';
import { recordExplicitFeedbackLearning, type ExplicitFeedback } from '@/lib/feedback-learning';
import type { NativeIngestPayload } from '@/lib/focus-copilot-types';
import type { GuardianEvent } from '@/lib/guardian-types';
import {
  classifyNativeAppActivity,
  maybeAskNativeCategory,
} from '@/lib/native-app-classification';
import {
  getBrowserCollectorState,
  isChromeApplication,
  recordNativeClientHeartbeat,
} from '@/lib/guardian-client-status';
import { arbitrateSessionActivity, recordSessionActivityInterval } from '@/lib/session-activity';
import {
  getPendingPresenceCheck,
  hasRecentTaskAlignedVisionEvidence,
  hasRecentStillWorkingConfirmation,
  isWithinSessionPresenceGrace,
  observeStaticActivity,
  STATIC_ACTIVITY_GRACE_MS,
} from '@/lib/guardian-presence';
import { getSessionEvidenceMode } from '@/lib/guardian-evidence-store';

function clampConfidence(value: unknown): number {
  return Math.max(0, Math.min(1, typeof value === 'number' ? value : 0.7));
}

function attentionForActivityCategory(
  category: string,
  fallback?: NativeIngestPayload['attentionQuality'],
) {
  if (fallback) return fallback;
  if (category === 'productive') return 'focused';
  if (category === 'distraction') return 'distracted';
  return 'consuming';
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as NativeIngestPayload;

    if (body.kind === 'capture_heartbeat') {
      const inputIdleSeconds = Math.max(0, Number(body.inputIdleSeconds ?? 0));
      const activeBeforeHeartbeat = getActiveGuardianSession();
      const observedAtMs = body.observedAt ? Date.parse(body.observedAt) : Date.now();
      const browser = activeBeforeHeartbeat
        ? getBrowserCollectorState(activeBeforeHeartbeat.sessionId)
        : { fresh: false, mediaPlaybackActive: false };
      const foregroundMediaActive = Boolean(
        activeBeforeHeartbeat
        && isChromeApplication(body.appInFocus)
        && browser.fresh
        && browser.mediaPlaybackActive,
      );
      const confirmedStaticActive = Boolean(
        activeBeforeHeartbeat
        && hasRecentStillWorkingConfirmation(activeBeforeHeartbeat.sessionId),
      );
      const taskAlignedVisionActive = Boolean(
        activeBeforeHeartbeat
        && hasRecentTaskAlignedVisionEvidence({
          sessionId: activeBeforeHeartbeat.sessionId,
          app: body.appInFocus,
          windowTitle: body.windowTitle,
          now: observedAtMs,
        }),
      );
      const sessionGraceActive = Boolean(
        activeBeforeHeartbeat
        && isWithinSessionPresenceGrace(activeBeforeHeartbeat.sessionId, observedAtMs),
      );
      const effectiveSystemState = body.systemState === 'idle'
        && (
          foregroundMediaActive
          || confirmedStaticActive
          || taskAlignedVisionActive
          || sessionGraceActive
          || (inputIdleSeconds > 0 && inputIdleSeconds * 1_000 < STATIC_ACTIVITY_GRACE_MS)
        )
        ? 'active'
        : body.systemState;
      recordNativeClientHeartbeat({
        deviceId: body.deviceId,
        clientVersion: body.clientVersion,
        screenRecordingStatus: body.screenRecordingStatus,
        captureCapable: body.captureCapable,
        frontmostApp: body.appInFocus,
        frontmostWindowTitle: body.windowTitle,
        systemState: effectiveSystemState,
        activeSessionId: body.sessionId,
        metadata: {
          ...(body.metadata ?? {}), inputIdleSeconds, foregroundMediaActive,
          confirmedStaticActive, taskAlignedVisionActive, sessionGraceActive,
        },
        observedAt: body.observedAt,
      });
      const activeSession = getActiveGuardianSession();
      let presenceCheck = activeSession ? getPendingPresenceCheck(activeSession.sessionId) : null;
      if (
        activeSession
        && activeSession.state === 'ACTIVE'
        && body.systemState === 'idle'
        && inputIdleSeconds * 1_000 >= STATIC_ACTIVITY_GRACE_MS
        && !foregroundMediaActive
        && !confirmedStaticActive
        && !taskAlignedVisionActive
      ) {
        const presence = observeStaticActivity({
          sessionId: activeSession.sessionId,
          inputIdleSeconds,
          app: body.appInFocus,
          windowTitle: body.windowTitle,
          observedAt: observedAtMs,
        });
        presenceCheck = presence.check;
        if (presence.timedOut && presence.check) {
          pauseGuardianSession(activeSession.sessionId, 'presence_unconfirmed');
        }
      } else if (activeSession && effectiveSystemState === 'locked') {
        const arbitration = arbitrateSessionActivity(activeSession.sessionId, 'idle');
        if (arbitration.accepted) {
          const observedEnd = body.observedAt || new Date().toISOString();
          recordSessionActivityInterval({
            sessionId: activeSession.sessionId,
            source: 'idle',
            observedStart: new Date(Date.parse(observedEnd) - 5_000).toISOString(),
            observedEnd,
            state: 'locked',
            app: 'macOS',
            title: 'Device locked',
            category: 'neutral',
            scoreEligible: false,
            selectionReason: arbitration.reason,
            captureStatus: 'verified_system_state',
            engagementState: 'inactive',
            engagementConfidence: 1,
          });
        }
      }
      return NextResponse.json({
        ok: true,
        active: !!activeSession,
        sessionId: activeSession?.sessionId ?? null,
        presenceCheck,
      });
    }

    const activeSession = getActiveGuardianSession();
    const sessionId = body.sessionId || activeSession?.sessionId || null;

    if (!sessionId || !activeSession || activeSession.sessionId !== sessionId) {
      return NextResponse.json({ ok: false, error: 'No active guardian session for native ingest' }, { status: 409 });
    }

    const db = getDb();

    if (body.kind === 'app_dwell') {
      const durationSeconds = Math.max(0, Math.round(body.durationSeconds ?? 0));
      if (durationSeconds <= 0) {
        return NextResponse.json({ ok: false, error: 'durationSeconds must be positive' }, { status: 400 });
      }

      const app = body.appInFocus || 'Unknown App';
      const title = body.windowTitle || '';
      if (app === 'Sensitive App') {
        const arbitration = arbitrateSessionActivity(sessionId, 'private');
        if (arbitration.accepted) {
          const observedEnd = new Date().toISOString();
          recordSessionActivityInterval({
            sessionId,
            source: 'private',
            observedStart: new Date(Date.now() - durationSeconds * 1_000).toISOString(),
            observedEnd,
            state: 'private',
            app,
            category: 'neutral',
            scoreEligible: false,
            selectionReason: arbitration.reason,
            captureStatus: 'privacy_skipped',
            engagementState: 'private',
            engagementConfidence: 1,
          });
        }
        return NextResponse.json({ ok: true, stored: 'private_interval', counted: false });
      }
      const classified = classifyNativeAppActivity({
        app,
        title,
        clientCategory: body.category ?? null,
        sessionActive: true,
        sessionTargetTitle: activeSession.targetTitle,
      });

      const activityCategory = classified.activityCategory;
      const startedAt = body.startedAt || new Date(Date.now() - durationSeconds * 1000).toISOString();
      const endedAt = new Date(Date.parse(startedAt) + durationSeconds * 1_000).toISOString();
      const arbitration = arbitrateSessionActivity(sessionId, 'vision');
      const evidenceMode = getSessionEvidenceMode(sessionId);
      const inferred = {
        source: 'native_copilot',
        app,
        title,
        sessionId,
        internal: classified.internal,
        category: activityCategory,
        activityCategory,
        confidence: classified.confidence,
        needsUserAsk: classified.needsUserAsk,
        reason: classified.reason,
        preferenceDomain: classified.preferenceDomain,
        classifySource: classified.source,
      };

      const confidenceLabel =
        classified.confidence >= 0.85 ? 'high' :
        classified.confidence >= 0.55 ? 'medium' : 'low';

      const result = db.prepare(`
        INSERT INTO activities
          (url, domain, title, category, subcategory, started_at, ended_at, duration_seconds,
           ai_classification, classification_confidence, device_name, guardian_session_id,
           counted, capture_source, selection_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'vision', ?)
      `).run(
        `native://${encodeURIComponent(app)}`,
        app,
        title || app,
        activityCategory,
        'native_app',
        startedAt,
        endedAt,
        durationSeconds,
        JSON.stringify(inferred),
        confidenceLabel,
        'LifeOS Native Copilot',
        sessionId,
        arbitration.reason,
      );

      const activityId = Number(result.lastInsertRowid);

      if (!arbitration.accepted && evidenceMode !== 'authoritative') {
        return NextResponse.json({
          ok: true,
          stored: 'raw_activity',
          counted: false,
          selectedSource: arbitration.selectedSource,
          reason: arbitration.reason,
        });
      }

      if (evidenceMode !== 'authoritative') {
        recordSessionActivityInterval({
          sessionId,
          source: 'vision',
          observedStart: startedAt,
          observedEnd: endedAt,
          app,
          windowTitle: title,
          url: `native://${encodeURIComponent(app)}`,
          domain: `native:${app.toLowerCase()}`,
          title: title || app,
          category: activityCategory,
          subcategory: 'native_app',
          selectionReason: arbitration.reason,
          evidence: { rawActivityId: activityId, confidence: classified.confidence },
        });
      }

      const event: GuardianEvent = {
        sessionId,
        type: 'native_context',
        timestamp: Date.now(),
        url: `native://${encodeURIComponent(app)}`,
        domain: `native:${app.toLowerCase()}`,
        title: title || app,
        dwellSeconds: durationSeconds,
        payload: {
          kind: body.kind,
          appInFocus: app,
          windowTitle: title,
          category: activityCategory,
          internal: classified.internal,
          needsUserAsk: classified.needsUserAsk,
          metadata: body.metadata ?? {},
          captureSource: 'vision',
          sourceVerified: true,
        },
      };
      await tickGuardianSession(sessionId, event);
      touchIntelligence('native_app_dwell');

      let asked = false;
      if (classified.needsUserAsk && activityId > 0) {
        try {
          const askResult = await maybeAskNativeCategory({
            app,
            activityId,
            sessionId,
            sessionTargetTitle: activeSession.targetTitle || 'focus session',
            classify: classified,
          });
          asked = askResult.asked;
        } catch (err) {
          console.warn('[native/ingest] ask loop failed:', err);
        }
      }

      return NextResponse.json({
        ok: true,
        stored: 'activities',
        category: activityCategory,
        internal: classified.internal,
        needsUserAsk: classified.needsUserAsk,
        asked,
        confidence: classified.confidence,
        counted: true,
        selectedSource: 'vision',
      });
    }

    if (body.kind === 'observation_summary' || body.kind === 'sensitivity_skip') {
      const app = body.appInFocus || 'Unknown App';
      const title = body.windowTitle || '';
      const classified = body.kind === 'sensitivity_skip'
        ? {
            internal: 'idle' as const,
            activityCategory: 'neutral' as const,
            confidence: 0.9,
            needsUserAsk: false,
            reason: 'privacy skip',
            preferenceDomain: `native:${app.toLowerCase()}`,
            source: 'rules' as const,
          }
        : classifyNativeAppActivity({
            app,
            title,
            clientCategory: body.category ?? null,
            sessionActive: true,
            sessionTargetTitle: activeSession.targetTitle,
          });

      const activityCategory = classified.activityCategory;
      const attention = attentionForActivityCategory(activityCategory, body.attentionQuality);
      const activity = body.kind === 'sensitivity_skip'
        ? `Native capture skipped: ${body.reason || 'sensitive context'}`
        : (body.specificContent || `${app}: ${title}`.slice(0, 220));

      db.prepare(`
        INSERT INTO screen_observations
          (observed_at, source, app, window_title, activity, category, content_type, attention_quality,
           specific_content, productive_for_goals, confidence, session_id, raw_description)
        VALUES (?, 'native_copilot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        body.observedAt && Number.isFinite(Date.parse(body.observedAt))
          ? new Date(body.observedAt).toISOString()
          : new Date().toISOString(),
        app,
        title,
        activity,
        activityCategory,
        'native_app',
        attention,
        body.specificContent || title || app,
        (body.productiveForGoals || activityCategory === 'productive') ? 1 : 0,
        clampConfidence(body.confidence ?? classified.confidence),
        sessionId,
        JSON.stringify({
          kind: body.kind,
          reason: body.reason ?? classified.reason,
          internal: classified.internal,
          metadata: body.metadata ?? {},
        }),
      );

      if (body.kind === 'sensitivity_skip') {
        const arbitration = arbitrateSessionActivity(sessionId, 'private');
        if (arbitration.accepted) {
          const endedAt = new Date().toISOString();
          recordSessionActivityInterval({
            sessionId,
            source: 'private',
            observedStart: new Date(Date.now() - 1_000).toISOString(),
            observedEnd: endedAt,
            state: 'private',
            app,
            windowTitle: null,
            category: 'neutral',
            scoreEligible: false,
            selectionReason: arbitration.reason,
            captureStatus: 'privacy_skipped',
            evidence: { reason: body.reason ?? 'sensitive_window' },
          });
        }
      }
      touchIntelligence(body.kind === 'sensitivity_skip' ? 'native_sensitivity_skip' : 'native_screen_observation');
      return NextResponse.json({ ok: true, stored: 'screen_observations', category: activityCategory, counted: false });
    }

    if (body.kind === 'overlay_feedback') {
      if (!body.feedback) {
        return NextResponse.json({ ok: false, error: 'feedback is required' }, { status: 400 });
      }
      db.prepare(`
        INSERT INTO native_guidance_feedback (outcome_id, session_id, feedback, reason, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.outcomeId ?? null, sessionId, body.feedback, body.reason ?? null, JSON.stringify(body.metadata ?? {}));

      if (body.outcomeId) {
        db.prepare(`
          UPDATE agent_action_outcomes
          SET helpful = ?, actual_outcome = ?, was_corrected = CASE WHEN ? = 'not_helpful' THEN 1 ELSE was_corrected END
          WHERE id = ?
        `).run(
          body.feedback === 'helpful' ? 1 : body.feedback === 'not_helpful' ? 0 : null,
          JSON.stringify({ feedback: body.feedback, reason: body.reason ?? null, source: 'native_copilot' }),
          body.feedback,
          body.outcomeId,
        );
      }

      recordExplicitFeedbackLearning({
        source: 'native_guidance',
        feedback: body.feedback as ExplicitFeedback,
        reason: body.reason ?? null,
        surface: 'native_overlay',
        momentMode: null,
        subject: typeof body.metadata?.question === 'string' ? body.metadata.question : null,
        outcomeId: body.outcomeId ?? null,
        metadata: body.metadata ?? {},
      });

      touchIntelligence('native_guidance_feedback');
      return NextResponse.json({ ok: true, stored: 'native_guidance_feedback' });
    }

    return NextResponse.json({ ok: false, error: `Unsupported native ingest kind: ${body.kind}` }, { status: 400 });
  } catch (err) {
    console.error('[native/ingest] Error:', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
