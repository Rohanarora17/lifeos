import { NextResponse } from 'next/server';
import { tickGuardianSession } from '@/lib/guardian-runtime';
import { normalizeGuardianEventInput } from '@/lib/guardian-events';
import { getDb } from '@/lib/db';
import { classifyActivity } from '@/lib/ai';

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

    // Mirror the tab event into the general activity log so it appears in the Activity Tab.
    // When prevUrl is present, log dwell time against the PREVIOUS URL (where the time was spent).
    // The new URL (event.url) just started — its dwell will be recorded on the next navigation.
    if (event.type === 'tab') {
      const dwellSeconds = typeof event.dwellSeconds === 'number' ? event.dwellSeconds : 0;
      const activityUrl = event.prevUrl || event.url;
      const activityTitle = event.prevTitle || event.title || '';

      if (activityUrl && !activityUrl.startsWith('chrome://') && dwellSeconds > 0) {
        try {
          let domainStr = activityUrl;
          try { domainStr = new URL(activityUrl).hostname.replace(/^www\./, ''); } catch { }
          const classification = await classifyActivity(activityUrl, activityTitle, domainStr, undefined);
          const started_at = new Date(Date.now() - dwellSeconds * 1000).toISOString();

          getDb().prepare(`
            INSERT INTO activities (url, domain, title, category, subcategory, started_at, duration_seconds, ai_classification, device_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            activityUrl,
            domainStr,
            activityTitle,
            classification.category,
            classification.subcategory,
            started_at,
            dwellSeconds,
            JSON.stringify(classification),
            'LifeOS Guardian'
          );
        } catch (err) {
          console.error('[Guardian] Failed to log activity to SQLite:', err);
        }
      }
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
