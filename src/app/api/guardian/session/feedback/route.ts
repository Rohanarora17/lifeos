import { NextResponse } from 'next/server';
import { processSessionFeedback, getCalibrationStatus } from '@/lib/guardian-calibration';
import { getDb } from '@/lib/db';

/**
 * POST /api/guardian/session/feedback
 * Accepts free-text post-session reflection and calibrates per-user weights.
 *
 * Body:
 *   session_id  — required
 *   feedback    — required free-text
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionId = (body.session_id as string | undefined)?.trim();
    const feedback = (body.feedback as string | undefined)?.trim();

    if (!sessionId) return NextResponse.json({ error: 'session_id is required' }, { status: 400 });
    if (!feedback) return NextResponse.json({ error: 'feedback is required' }, { status: 400 });

    // Load session metrics from DB for error computation
    const db = getDb();
    const session = db.prepare(`
      SELECT average_focus_score, final_focus_score, elapsed_minutes, duration_minutes,
             blocked_count, override_count
      FROM guardian_session_summaries
      WHERE session_id = ?
    `).get(sessionId) as {
      average_focus_score: number | null;
      final_focus_score: number | null;
      elapsed_minutes: number | null;
      duration_minutes: number | null;
      blocked_count: number | null;
      override_count: number | null;
    } | undefined;

    const energyRow = db.prepare(`
      SELECT composite_score FROM energy_readings
      WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1
    `).get(sessionId) as { composite_score: number } | undefined;

    const metrics = {
      system_energy_composite: energyRow?.composite_score ?? null,
      system_focus_score: session?.average_focus_score ?? null,
      system_distraction_events: session?.blocked_count ?? null,
      system_tab_switch_count: null,
      system_idle_minutes: null,
      system_intervention_count: session?.blocked_count ?? null,
      system_override_count: session?.override_count ?? null,
      elapsed_minutes: session?.elapsed_minutes ?? null,
      planned_minutes: session?.duration_minutes ?? null,
    };

    const result = processSessionFeedback(sessionId, feedback, metrics);

    // If weights changed, regenerate weekly plan with updated priorities
    if (result.adjustments.length > 0) {
      try {
        const { generateWeeklyPlan, saveWeeklyPlan } = await import('@/lib/weekly-planner');
        saveWeeklyPlan(generateWeeklyPlan());
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      success: true,
      feedbackId: result.feedbackId,
      signals: result.signals,
      adjustments: result.adjustments,
      newAccuracy: result.newAccuracy,
    });
  } catch (err) {
    console.error('[session/feedback] POST error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * GET /api/guardian/session/feedback
 * Returns current calibration status (accuracy + recent adjustments).
 */
export async function GET() {
  try {
    const status = getCalibrationStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
