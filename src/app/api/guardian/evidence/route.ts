import { NextRequest, NextResponse } from 'next/server';
import { consumeRateLimit } from '@/lib/rate-limit';
import { ingestGuardianEvidence } from '@/lib/guardian-evidence-store';
import { getPendingPresenceCheck, observeFinalizedUncertainEvidence } from '@/lib/guardian-presence';
import { getActiveGuardianSession, consumeGuardianCommands, pauseGuardianSession } from '@/lib/guardian-runtime';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH_SIZE = 100;

function clientKey(request: NextRequest) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export async function POST(request: NextRequest) {
  const rate = consumeRateLimit(`guardian-evidence:${clientKey(request)}`, {
    limit: 360,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const events = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { events?: unknown[] }).events)
      ? (payload as { events: unknown[] }).events
      : [payload];
  if (events.length === 0 || events.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: 'invalid_batch_size', maxBatchSize: MAX_BATCH_SIZE }, { status: 400 });
  }

  const result = ingestGuardianEvidence(events);
  for (const sessionId of result.canonicalizedSessions) {
    const presence = observeFinalizedUncertainEvidence(sessionId);
    if (presence.timedOut) pauseGuardianSession(sessionId, 'presence_unconfirmed');
  }
  const active = getActiveGuardianSession();
  const status = result.rejected.length === events.length ? 422 : 202;
  return NextResponse.json({
    ...result,
    session: active,
    commands: active ? consumeGuardianCommands(active.sessionId) : [],
    presenceCheck: active ? getPendingPresenceCheck(active.sessionId) : null,
    serverTime: new Date().toISOString(),
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
