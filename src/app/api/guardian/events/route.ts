import { NextResponse } from 'next/server';
import { tickGuardianSession } from '@/lib/guardian-runtime';
import { normalizeGuardianEventInput } from '@/lib/guardian-events';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';

// Logs activity to SQLite asynchronously — never on the response critical path.
// When prevUrl is present, dwell time is logged against the PREVIOUS URL (where the time was spent).
async function logActivityAsync(
  event: ReturnType<typeof normalizeGuardianEventInput>,
  targetTitle?: string,
  goalTitle?: string | null
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

    getDb().prepare(`
      INSERT INTO activities (url, domain, title, category, subcategory, started_at, duration_seconds, ai_classification, classification_confidence, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activityUrl,
      domainStr,
      activityTitle,
      classification.category,
      classification.subcategory,
      started_at,
      dwellSeconds,
      aiClassificationJson,
      classification.confidence ?? null,
      'LifeOS Guardian'
    );
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

    const result = await tickGuardianSession(event.sessionId, event);
    if (!result.session) {
      return NextResponse.json({ error: 'Guardian session is not active' }, { status: 409 });
    }

    // Respond immediately — block commands are time-critical.
    // Activity logging (AI classification) runs fire-and-forget so it never delays the response.
    if (event.type === 'tab') {
      void logActivityAsync(event, result.session.targetTitle, result.session.goalTitle);
    }

    return NextResponse.json({
      success: true,
      decision: result.decision,
      commands: result.commands,
      session: result.session,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
