import { NextResponse } from 'next/server';
import { adjudicateOverride } from '@/lib/guardian-runtime';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body.sessionId || !body.url || !body.reason) {
      return NextResponse.json({ error: 'sessionId, url, and reason are required' }, { status: 400 });
    }

    const decision = await adjudicateOverride({
      sessionId: body.sessionId,
      url: body.url,
      title: body.title,
      reason: body.reason,
      requestedMinutes: body.requestedMinutes,
    });

    return NextResponse.json({ success: true, decision });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
