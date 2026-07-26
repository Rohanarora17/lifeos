import { NextResponse } from 'next/server';
import { tickGuardianSession, getActiveGuardianSession } from '@/lib/guardian-runtime';
import {
  isSensitiveApp,
  computeImageHash,
  getChangeMagnitude,
  decideVisionAnalysis,
  computeCaptureState,
  analyzeScreenshot,
  updateScreenContext,
  persistVisionSignal,
  generateContextNarrative,
  updateMacbookClientHeartbeat,
  isMacbookClientConnected,
} from '@/lib/screen-vision';
import type { GuardianEvent } from '@/lib/guardian-types';

// ---------------------------------------------------------------------------
// Per-session state for change detection and client tracking
// ---------------------------------------------------------------------------

interface VisionSessionState {
  lastHash: string | null;
  lastApp: string | null;
  lastWindowTitle: string | null;
  lastAnalyzedAt: number;
  narrativeUpdatedAt: number;
}

const sessionVisionState = new Map<string, VisionSessionState>();

// Re-export for consumers that import from the route
export { isMacbookClientConnected };

// ---------------------------------------------------------------------------
// POST /api/guardian/vision
// Receives screenshots from MacBook client daemon (or internal fallback calls)
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;

    // Heartbeat from client (no screenshot, just connectivity check)
    if (body.type === 'heartbeat') {
      updateMacbookClientHeartbeat();
      console.log('[Vision] MacBook client heartbeat received');
      return NextResponse.json({ connected: true });
    }

    updateMacbookClientHeartbeat();
    console.log(`[Vision] Screenshot received — app="${(body as Record<string,string>).appInFocus}" window="${(body as Record<string,string>).windowTitle}" session=${(body as Record<string,string>).sessionId}`);

    const { sessionId, base64Jpeg, appInFocus, windowTitle } = body as {
      sessionId: string;
      base64Jpeg: string;
      appInFocus: string;
      windowTitle: string;
    };

    if (!sessionId || !base64Jpeg || !appInFocus) {
      return NextResponse.json({ error: 'Missing required fields: sessionId, base64Jpeg, appInFocus' }, { status: 400 });
    }

    // Privacy: skip sensitive apps entirely
    if (isSensitiveApp(appInFocus, windowTitle ?? '')) {
      console.log(`[Vision] Skipping sensitive app: ${appInFocus}`);
      return NextResponse.json({ skipped: true, reason: 'sensitive_app' });
    }

    // Verify session is active
    const session = getActiveGuardianSession();
    if (!session || session.sessionId !== sessionId) {
      console.warn(`[Vision] Screenshot rejected — no active session matching ${sessionId}`);
      return NextResponse.json({ skipped: true, reason: 'no_active_session' });
    }

    const elapsedMinutes = Math.round((Date.now() - session.startedAt) / 60_000);
    const currentFocusScore = session.focusScoreHistory.at(-1) ?? 50;

    // Change detection
    const currentHash = await computeImageHash(base64Jpeg);
    const vState = sessionVisionState.get(sessionId) ?? {
      lastHash: null,
      lastApp: null,
      lastWindowTitle: null,
      lastAnalyzedAt: 0,
      narrativeUpdatedAt: 0,
    };
    const pixelChange = getChangeMagnitude(currentHash, vState.lastHash);
    const changeDecision = decideVisionAnalysis({
      pixelChange,
      previousApp: vState.lastApp,
      previousWindowTitle: vState.lastWindowTitle,
      appInFocus,
      windowTitle: windowTitle ?? '',
      lastAnalyzedAt: vState.lastAnalyzedAt,
      now: Date.now(),
    });
    const changeFromPrevious = changeDecision.changeFromPrevious;

    console.log(`[Vision] Change detection: ${changeFromPrevious}/${changeDecision.reason} (prev hash: ${vState.lastHash ? 'exists' : 'none'})`);

    // Skip Gemini analysis if screen and window metadata have not changed meaningfully.
    if (!changeDecision.analyze && vState.lastAnalyzedAt > 0) {
      // Still tick the session with a lightweight screen_vision event to maintain heartbeat
      const lightEvent: GuardianEvent = {
        sessionId,
        type: 'screen_vision',
        timestamp: Date.now(),
        payload: { visionSkipped: true, reason: changeDecision.reason },
      };
      await tickGuardianSession(sessionId, lightEvent);
      return NextResponse.json({ analyzed: false, reason: changeDecision.reason });
    }

    // Full Gemini Vision analysis
    const signal = await analyzeScreenshot({
      base64Jpeg,
      appInFocus,
      windowTitle: windowTitle ?? '',
      sessionGoal: session.goalTitle ?? session.targetTitle,
      sessionTopic: session.intentProfile?.topic ?? session.targetTitle,
      elapsedMinutes,
      currentFocusScore,
      changeFromPrevious,
    });
    if (!signal) {
      console.warn('[Vision] Model assessment rejected by schema validation');
      return NextResponse.json({
        analyzed: false,
        reason: 'invalid_assessment',
      });
    }

    // Update change detection state
    sessionVisionState.set(sessionId, {
      lastHash: currentHash,
      lastApp: appInFocus,
      lastWindowTitle: windowTitle ?? '',
      lastAnalyzedAt: Date.now(),
      narrativeUpdatedAt: vState.narrativeUpdatedAt,
    });

    // Compute next capture state for client to use
    const captureStateResult = computeCaptureState(session, session.screenContext?.captureState ?? 'normal');

    // Update screen context on session (will be applied inside guardian-runtime via the event)
    const updatedContext = updateScreenContext(session.screenContext, signal, captureStateResult.state);

    // Generate context narrative every 5 minutes
    const NARRATIVE_INTERVAL_MS = 5 * 60_000;
    let contextNarrative = updatedContext.contextNarrative;
    if (Date.now() - (updatedContext.narrativeUpdatedAt ?? 0) > NARRATIVE_INTERVAL_MS) {
      contextNarrative = await generateContextNarrative(
        updatedContext.recentObservations,
        session.goalTitle ?? session.targetTitle,
        elapsedMinutes,
      ).catch(() => updatedContext.contextNarrative);
      updatedContext.contextNarrative = contextNarrative;
      updatedContext.narrativeUpdatedAt = Date.now();
    }

    console.log(`[Vision] ✓ Analyzed — alignment=${signal.taskAlignment} depth=${signal.engagementDepth} confidence=${signal.confidence.toFixed(2)} change=${signal.changeFromPrevious}`);

    // Persist to screen_observations
    persistVisionSignal(signal, sessionId);

    // Post as screen_vision GuardianEvent — guardian-runtime will update screenContext + score
    const event: GuardianEvent = {
      sessionId,
      type: 'screen_vision',
      timestamp: signal.capturedAt,
      payload: {
        signal,
        screenContext: updatedContext,
      },
    };

    const result = await tickGuardianSession(sessionId, event);

    return NextResponse.json({
      analyzed: true,
      signal: {
        taskAlignment: signal.taskAlignment,
        engagementDepth: signal.engagementDepth,
        changeFromPrevious: signal.changeFromPrevious,
        confidence: signal.confidence,
      },
      captureState: captureStateResult.state,
      nextIntervalMs: captureStateResult.intervalMs,
      captureReason: captureStateResult.reason,
      momentMode: captureStateResult.momentMode,
      decision: result.decision,
    });
  } catch (error) {
    console.error('[Vision] Error processing screenshot:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/guardian/vision/state — client polls for session state + capture config
// ---------------------------------------------------------------------------

export async function GET() {
  const session = getActiveGuardianSession();
  const clientConnected = isMacbookClientConnected();

  if (!session) {
    return NextResponse.json({
      active: false,
      captureState: 'normal',
      nextIntervalMs: 15_000,
      macbookClient: { connected: clientConnected },
    });
  }

  const captureStateResult = computeCaptureState(session, session.screenContext?.captureState ?? 'normal');
  const vState = sessionVisionState.get(session.sessionId);
  const screenCtx = session.screenContext;

  return NextResponse.json({
    active: true,
    sessionId: session.sessionId,
    goalTitle: session.goalTitle ?? session.targetTitle,
    topic: session.intentProfile?.topic ?? session.targetTitle,
    captureState: captureStateResult.state,
    nextIntervalMs: captureStateResult.intervalMs,
    captureReason: captureStateResult.reason,
    momentMode: captureStateResult.momentMode,
    focusScore: session.focusScoreHistory.at(-1) ?? 50,
    macbookClient: {
      connected: clientConnected,
      lastScreenshot: vState?.lastAnalyzedAt ? new Date(vState.lastAnalyzedAt).toISOString() : null,
      totalCaptures: screenCtx?.recentObservations?.length ?? 0,
    },
    screenContext: screenCtx ? {
      captureState: screenCtx.captureState,
      visionTrend: screenCtx.visionTrend,
      taskAlignmentAvg: screenCtx.taskAlignmentAvg,
      engagementDepth: screenCtx.engagementDepth,
      dominantActivity: screenCtx.dominantActivity,
      latestAlignment: screenCtx.latestObservation?.taskAlignment ?? null,
      latestDepth: screenCtx.latestObservation?.engagementDepth ?? null,
    } : null,
  });
}
