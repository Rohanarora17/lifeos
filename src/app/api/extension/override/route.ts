import { NextRequest, NextResponse } from 'next/server';
import { sanitizeUrl, sanitizeText } from '@/lib/sanitize';
import { getGuardianContext, adjudicateOverride } from '@/lib/guardian-runtime';

// POST: Delegates override requests to the guardian runtime's adjudicateOverride.
// Requires an active guardian session; scopes the override to the active session's TTL.
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const url = sanitizeUrl(body.url);
        const title = sanitizeText(body.title, 500);
        const reason = sanitizeText(body.reason, 500);

        if (!url) {
            return NextResponse.json({ error: 'Missing URL' }, { status: 400 });
        }

        const { activeSession } = getGuardianContext();
        if (!activeSession) {
            return NextResponse.json({ error: 'No active session' }, { status: 409 });
        }

        const decision = await adjudicateOverride({
            sessionId: activeSession.sessionId,
            url,
            title: title ?? undefined,
            reason: reason ?? 'No reason provided',
            requestedMinutes: body.requestedMinutes,
        });

        return NextResponse.json({ success: true, decision });
    } catch (error) {
        console.error('Override API Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
