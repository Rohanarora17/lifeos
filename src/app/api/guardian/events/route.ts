import { NextResponse } from 'next/server';
import { getActiveGuardianSession, tickGuardianSession } from '@/lib/guardian-runtime';
import { normalizeGuardianEventInput } from '@/lib/guardian-events';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';
import { recordBrowserCollectorHeartbeat } from '@/lib/guardian-client-status';
import {
  arbitrateSessionActivity,
  recordSessionActivityInterval,
  removeOverlappingVisionFallback,
} from '@/lib/session-activity';
import { getPendingPresenceCheck } from '@/lib/guardian-presence';
import { getSessionEvidenceMode } from '@/lib/guardian-evidence-store';

// Logs activity to SQLite asynchronously — never on the response critical path.
// When prevUrl is present, dwell time is logged against the PREVIOUS URL (where the time was spent).
async function logActivityAsync(
  event: ReturnType<typeof normalizeGuardianEventInput>,
  targetTitle?: string,
  goalTitle?: string | null,
  canonicalIntervalId?: string | null,
) {
  if (!event) return;
  const dwellSeconds = typeof event.dwellSeconds === 'number' ? event.dwellSeconds : 0;
  if (dwellSeconds <= 0) return;

  const activityUrl = event.prevUrl || event.url;
  const activityTitle = event.prevTitle || event.title || '';
  if (!activityUrl || activityUrl.startsWith('chrome://')) return;

  try {
    let domainStr = activityUrl;
    try { domainStr = new URL(activityUrl).hostname.replace(/^www\./, ''); } catch { }
    const sessionContext = targetTitle ? { targetTitle, goalTitle: goalTitle ?? null } : undefined;
    const classification = await classifyActivity(activityUrl, activityTitle, domainStr, undefined, sessionContext);
    // Use tabStartedAt (exact epoch ms from extension) when available.
    // Fall back to retrocomputing from current time — accurate within ~100ms on localhost.
    const started_at = event.tabStartedAt
      ? new Date(event.tabStartedAt).toISOString()
      : new Date(Date.now() - dwellSeconds * 1000).toISOString();

    // Embed sessionTarget so the Telegram review callback can write context-specific
    // behavioral memory rules (e.g. "github.com during 'ZK Proofs' = distraction").
    const aiClassificationJson = JSON.stringify({
      ...classification,
      sessionTarget: targetTitle ?? null,
    });

    const endedAt = new Date(Date.parse(started_at) + dwellSeconds * 1_000).toISOString();
    const rawResult = getDb().prepare(`
      INSERT INTO activities (
        url, domain, title, category, subcategory, started_at, ended_at, duration_seconds,
        ai_classification, classification_confidence, device_name, guardian_session_id,
        counted, capture_source, selection_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'chrome', ?)
    `).run(
      activityUrl,
      domainStr,
      activityTitle,
      classification.category,
      classification.subcategory,
      started_at,
      endedAt,
      dwellSeconds,
      aiClassificationJson,
      classification.confidence ?? null,
      'LifeOS Guardian',
      event.sessionId,
      'Chrome was verified as the frontmost app and extension telemetry was fresh.',
    );
    if (canonicalIntervalId) {
      getDb().prepare(`
        UPDATE session_activity_intervals
        SET category = ?, subcategory = ?,
            evidence_json = json_patch(COALESCE(evidence_json, '{}'), ?),
            updated_at = datetime('now')
        WHERE interval_id = ?
      `).run(
        classification.category,
        classification.subcategory,
        JSON.stringify({ rawActivityId: Number(rawResult.lastInsertRowid) }),
        canonicalIntervalId,
      );
    }
  } catch (err) {
    console.error('[Guardian] Failed to log activity to SQLite:', err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const event = normalizeGuardianEventInput(body);

    if (!event) {
      return NextResponse.json({ error: 'Malformed guardian event payload' }, { status: 400 });
    }

    const payload = event.payload ?? {};
    recordBrowserCollectorHeartbeat({
      deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : null,
      sessionId: event.sessionId,
      windowFocused: payload.browserWindowFocused !== false,
      collectorVersion: typeof payload.collectorVersion === 'string' ? payload.collectorVersion : null,
      mediaPlaybackActive: payload.mediaPlaybackActive === true,
      mediaTitle: typeof payload.mediaTitle === 'string' ? payload.mediaTitle : null,
      observedAt: new Date(event.timestamp).toISOString(),
    });

    let canonicalIntervalId: string | null = null;
    if ((event.type === 'tab' || event.type === 'idle') && getSessionEvidenceMode(event.sessionId) !== 'authoritative') {
      const proposed = event.type === 'idle' ? 'idle' : 'chrome';
      const arbitration = arbitrateSessionActivity(event.sessionId, proposed);
      if (!arbitration.accepted) {
        return NextResponse.json({
          success: true,
          suppressed: true,
          counted: false,
          selectedSource: arbitration.selectedSource,
          reason: arbitration.reason,
          decision: { type: 'silence', reason: arbitration.reason },
          commands: [],
          session: getActiveGuardianSession(),
          presenceCheck: getPendingPresenceCheck(event.sessionId),
        });
      }

      event.payload = {
        ...payload,
        captureSource: proposed,
        sourceVerified: true,
        selectionReason: arbitration.reason,
      };

      if (event.type === 'tab' && (event.dwellSeconds ?? 0) > 0) {
        const activityUrl = event.prevUrl || event.url || '';
        let domain = activityUrl;
        try { domain = new URL(activityUrl).hostname.replace(/^www\./, ''); } catch { /* native/internal URL */ }
        const observedStart = event.tabStartedAt
          ? new Date(event.tabStartedAt).toISOString()
          : new Date(event.timestamp - (event.dwellSeconds ?? 0) * 1_000).toISOString();
        const observedEnd = new Date(
          Date.parse(observedStart) + (event.dwellSeconds ?? 0) * 1_000,
        ).toISOString();
        removeOverlappingVisionFallback(event.sessionId, observedStart, observedEnd);
        canonicalIntervalId = recordSessionActivityInterval({
          sessionId: event.sessionId,
          source: 'chrome',
          observedStart,
          observedEnd,
          app: 'Google Chrome',
          url: activityUrl,
          domain,
          title: event.prevTitle || event.title || '',
          category: 'neutral',
          subcategory: 'browser_pending_classification',
          selectionReason: arbitration.reason,
          engagementState: payload.mediaPlaybackActive === true ? 'passive_engaged' : 'interactive',
          engagementConfidence: payload.mediaPlaybackActive === true ? 0.95 : 0.9,
          evidence: {
            classification: 'pending',
            mediaPlaybackActive: payload.mediaPlaybackActive === true,
            mediaTitle: typeof payload.mediaTitle === 'string' ? payload.mediaTitle : null,
          },
        });
      }

      if (event.type === 'idle' && (event.idleSeconds ?? 0) > 0) {
        recordSessionActivityInterval({
          sessionId: event.sessionId,
          source: 'idle',
          observedStart: new Date(event.timestamp - (event.idleSeconds ?? 0) * 1_000).toISOString(),
          observedEnd: new Date(event.timestamp).toISOString(),
          state: payload.state === 'locked' ? 'locked' : 'idle',
          app: 'macOS',
          title: payload.state === 'locked' ? 'Device locked' : 'User idle',
          category: 'neutral',
          scoreEligible: false,
          selectionReason: arbitration.reason,
          captureStatus: 'verified_system_state',
          engagementState: 'inactive',
          engagementConfidence: 1,
        });
      }
    }

    const result = await tickGuardianSession(event.sessionId, event);
    if (!result.session) {
      return NextResponse.json({ error: 'Guardian session is not active' }, { status: 409 });
    }

    // Respond immediately — block commands are time-critical.
    // Activity logging (AI classification) runs fire-and-forget so it never delays the response.
    if (event.type === 'tab') {
      void logActivityAsync(event, result.session.targetTitle, result.session.goalTitle, canonicalIntervalId);
    }

    return NextResponse.json({
      success: true,
      decision: result.decision,
      commands: result.commands,
      session: result.session,
      presenceCheck: getPendingPresenceCheck(event.sessionId),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
