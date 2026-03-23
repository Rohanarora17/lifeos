import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listGuardianEvalCases, runGuardianOptimizationCycle, seedDefaultGuardianEvalCases } from '@/lib/guardian-optimizer';

const execFileAsync = promisify(execFile);

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      cases: listGuardianEvalCases(),
    });
  } catch (error) {
    console.error('[guardian/optimize] failed', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    seedDefaultGuardianEvalCases(body?.suiteName);
    const { stdout, stderr } = await execFileAsync('node', ['scripts/guardian-optimize.mjs', '--json'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GUARDIAN_EVAL_BUDGET_SECONDS: String(body?.wallClockBudgetSeconds || 300),
      },
    });
    if (stderr) {
      console.error('[guardian/optimize] stderr', stderr);
    }
    const result = JSON.parse(stdout);
    if (result?.error) {
      throw new Error(result.error);
    }
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error('[guardian/optimize] failed', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
