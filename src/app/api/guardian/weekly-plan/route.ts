import { NextResponse } from 'next/server';
import { generateWeeklyPlan, saveWeeklyPlan, loadActiveWeeklyPlan } from '@/lib/weekly-planner';

/**
 * GET /api/guardian/weekly-plan
 * Returns the active plan for this week, generating + persisting one if absent.
 */
export async function GET() {
  try {
    let plan = loadActiveWeeklyPlan();

    if (!plan) {
      plan = generateWeeklyPlan();
      saveWeeklyPlan(plan);
    }

    return NextResponse.json({ plan });
  } catch (err) {
    console.error('[weekly-plan] GET error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/guardian/weekly-plan
 * Force-regenerates the weekly plan, superseding the previous one.
 * Body: {} (no required fields; optional: { weekStart: "YYYY-MM-DD" })
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const fromDate = body.weekStart ? new Date(body.weekStart + 'T00:00:00Z') : undefined;

    const plan = generateWeeklyPlan(fromDate);
    const id = saveWeeklyPlan(plan);

    return NextResponse.json({ plan, id });
  } catch (err) {
    console.error('[weekly-plan] POST error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
