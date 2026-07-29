import { NextRequest, NextResponse } from 'next/server';
import {
  getPendingNativeCategoryAsk,
  resolveNativeCategoryAsk,
  toActivityCategory,
  type ActivityCategory,
} from '@/lib/native-app-classification';

/**
 * GET  — pending on-screen classification ask for LifeOS Copilot
 * POST — resolve ask { category: productive|neutral|distraction }
 *
 * Auth: same as other /api/native/* (device token / API token via proxy).
 */
export async function GET() {
  const pending = getPendingNativeCategoryAsk();
  if (!pending) {
    return NextResponse.json({ ok: true, pending: null });
  }
  return NextResponse.json({
    ok: true,
    pending: {
      app: pending.app,
      sessionId: pending.sessionId,
      sessionTargetTitle: pending.sessionTargetTitle,
      preferenceDomain: pending.preferenceDomain,
      activityCount: pending.activityIds.length,
      askedAt: pending.askedAt,
      expiresAt: pending.expiresAt,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = body.category ?? body.answer ?? body.choice;
    if (!raw || typeof raw !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'category required (productive|neutral|distraction)' },
        { status: 400 },
      );
    }
    const category = toActivityCategory(raw) as ActivityCategory;
    if (!['productive', 'neutral', 'distraction'].includes(category)) {
      return NextResponse.json({ ok: false, error: 'invalid category' }, { status: 400 });
    }

    const source =
      body.source === 'activity_ui' || body.source === 'telegram_text' || body.source === 'telegram_callback'
        ? body.source
        : 'activity_ui'; // on-screen copilot treated as UI

    const result = resolveNativeCategoryAsk(category, source === 'activity_ui' ? 'activity_ui' : source);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.message }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      app: result.app,
      category,
      updated: result.updated,
      message: result.message,
    });
  } catch (err) {
    console.error('[native/classification-ask] POST failed:', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
