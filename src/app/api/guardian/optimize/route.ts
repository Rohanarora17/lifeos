import { NextResponse } from 'next/server';
import {
  getActiveGuardianPolicyBundle,
  listGuardianEvalCases,
  runGuardianOptimizationCycle,
  seedDefaultGuardianEvalCases,
} from '@/lib/guardian-optimizer';

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      activePolicy: getActiveGuardianPolicyBundle(),
      cases: listGuardianEvalCases(),
    });
  } catch (error) {
    console.error('[guardian/optimize] GET failed', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    seedDefaultGuardianEvalCases(body?.suiteName);

    const result = await runGuardianOptimizationCycle({
      suiteName: body?.suiteName,
      wallClockBudgetSeconds: body?.wallClockBudgetSeconds ?? 300,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[guardian/optimize] POST failed', error);
    // Surface active-session guard as 409 so callers can handle it gracefully
    const msg = String(error);
    const status = msg.includes('active guardian session') ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
