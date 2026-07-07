import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { touchIntelligence } from '@/lib/intelligence';
import { recordExplicitFeedbackLearning } from '@/lib/feedback-learning';

type CoachFeedback = 'helpful' | 'not_helpful' | 'dismissed';

const allowed: CoachFeedback[] = ['helpful', 'not_helpful', 'dismissed'];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      outcomeId?: unknown;
      feedback?: unknown;
      reason?: unknown;
    };
    const outcomeId = Number(body.outcomeId);
    const feedback = typeof body.feedback === 'string' ? body.feedback as CoachFeedback : null;

    if (!Number.isInteger(outcomeId) || outcomeId <= 0) {
      return NextResponse.json({ error: 'outcomeId is required' }, { status: 400 });
    }
    if (!feedback || !allowed.includes(feedback)) {
      return NextResponse.json({ error: 'valid feedback is required' }, { status: 400 });
    }

    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : null;
    const helpful = feedback === 'helpful' ? 1 : feedback === 'not_helpful' ? 0 : null;
    const db = getDb();
    const existing = db.prepare(`
      SELECT inferred_value, actual_outcome FROM agent_action_outcomes
      WHERE id = ? AND action_type = 'coach_response'
    `).get(outcomeId) as { inferred_value: string | null; actual_outcome: string | null } | undefined;

    if (!existing) {
      return NextResponse.json({ error: 'coach outcome not found' }, { status: 404 });
    }

    let actualOutcome: Record<string, unknown> = {};
    try {
      actualOutcome = existing.actual_outcome ? JSON.parse(existing.actual_outcome) as Record<string, unknown> : {};
    } catch {
      actualOutcome = { previousOutcome: existing.actual_outcome };
    }
    actualOutcome.feedback = feedback;
    actualOutcome.feedbackReason = reason;
    actualOutcome.feedbackAt = new Date().toISOString();

    db.prepare(`
      UPDATE agent_action_outcomes
      SET helpful = ?,
          actual_outcome = ?,
          was_corrected = CASE WHEN ? = 'not_helpful' THEN 1 ELSE was_corrected END,
          correction_text = CASE WHEN ? = 'not_helpful' THEN COALESCE(?, correction_text) ELSE correction_text END
      WHERE id = ?
    `).run(
      helpful,
      JSON.stringify(actualOutcome),
      feedback,
      feedback,
      reason,
      outcomeId,
    );

    let inferred: Record<string, unknown> = {};
    try {
      inferred = existing.inferred_value ? JSON.parse(existing.inferred_value) as Record<string, unknown> : {};
    } catch {
      inferred = { raw: existing.inferred_value };
    }
    recordExplicitFeedbackLearning({
      source: 'coach_response',
      feedback,
      reason,
      surface: typeof inferred.surface === 'string' ? inferred.surface : 'web_chat',
      momentMode: typeof inferred.momentMode === 'string' ? inferred.momentMode : null,
      subject: typeof inferred.lastUserMessage === 'string' ? inferred.lastUserMessage : null,
      outcomeId,
    });

    touchIntelligence(`coach_feedback:${feedback}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Coach feedback error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
