import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  getActiveGuardianPolicyBundle,
  listGuardianEvalCases,
  runGuardianOptimizationCycle,
  seedDefaultGuardianEvalCases,
} from '@/lib/guardian-optimizer';

export async function GET() {
  try {
    const db = getDb();

    // Active policy with its artifact record
    const activeArtifact = db.prepare(`
      SELECT id, version, guardian_eval_score, promoted_at, notes
      FROM guardian_artifact_versions
      WHERE artifact_type = 'guardian_policy_bundle' AND is_active = 1
      ORDER BY id DESC LIMIT 1
    `).get() as { id: number; version: string; guardian_eval_score: number; promoted_at: string | null; notes: string | null } | undefined;

    // Last 8 eval runs (most recent first)
    const recentRuns = db.prepare(`
      SELECT er.id, er.artifact_version_id, er.suite_name, er.guardian_eval_score,
             er.hard_failures, er.status, er.summary, er.completed_at,
             av.version as artifact_version
      FROM guardian_eval_runs er
      LEFT JOIN guardian_artifact_versions av ON av.id = er.artifact_version_id
      ORDER BY er.id DESC LIMIT 8
    `).all() as Array<{
      id: number; artifact_version_id: number | null; suite_name: string;
      guardian_eval_score: number; hard_failures: number; status: string;
      summary: string | null; completed_at: string | null; artifact_version: string | null;
    }>;

    // Last 5 promotions
    const promotions = db.prepare(`
      SELECT p.id, p.artifact_version_id, p.reason, p.promoted_at,
             av.version, av.guardian_eval_score
      FROM guardian_promotions p
      JOIN guardian_artifact_versions av ON av.id = p.artifact_version_id
      ORDER BY p.id DESC LIMIT 5
    `).all() as Array<{
      id: number; artifact_version_id: number; reason: string;
      promoted_at: string; version: string; guardian_eval_score: number;
    }>;

    // Last 3 canary results
    const canaryResults = db.prepare(`
      SELECT id, guardian_eval_score, status, notes, created_at
      FROM guardian_canary_results
      ORDER BY id DESC LIMIT 3
    `).all() as Array<{ id: number; guardian_eval_score: number; status: string; notes: string | null; created_at: string }>;

    return NextResponse.json({
      success: true,
      activePolicy: getActiveGuardianPolicyBundle(),
      activeArtifact,
      cases: listGuardianEvalCases(),
      recentRuns,
      promotions,
      canaryResults,
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
