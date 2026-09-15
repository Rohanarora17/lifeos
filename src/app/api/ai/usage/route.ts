import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { AI_PRICING_SOURCE, AI_PRICING_VERSION } from '@/lib/ai-usage';
import { unifiedAiCircuitBreaker } from '@/lib/ai-circuit-breaker';

export const dynamic = 'force-dynamic';

type AggregateRow = {
  attempts: number; successful_attempts: number; failed_attempts: number; cancelled_attempts: number;
  fallback_attempts: number; logical_operations: number; first_try_successes: number;
  recovered_operations: number; terminal_failures: number; cancelled_operations: number; input_tokens: number;
  cached_input_tokens: number; output_tokens: number; reasoning_tokens: number;
  total_tokens: number; estimated_cost_usd: number;
};

function operationAggregate(where = '1=1') {
  const row = getDb().prepare(`
    WITH filtered AS (
      SELECT *, COALESCE(logical_request_id, request_id) AS logical_id
      FROM ai_usage_events WHERE ${where}
    ), operations AS (
      SELECT logical_id,
        MAX(CASE WHEN status='success' THEN 1 ELSE 0 END) AS succeeded,
        MAX(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS had_failure,
        MAX(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS had_cancellation,
        MAX(used_fallback) AS had_fallback
      FROM filtered GROUP BY logical_id
    )
    SELECT
      (SELECT COUNT(*) FROM filtered) AS attempts,
      (SELECT COUNT(*) FROM filtered WHERE status='success') AS successful_attempts,
      (SELECT COUNT(*) FROM filtered WHERE status='failed') AS failed_attempts,
      (SELECT COUNT(*) FROM filtered WHERE status='cancelled') AS cancelled_attempts,
      (SELECT COUNT(*) FROM filtered WHERE used_fallback=1) AS fallback_attempts,
      (SELECT COUNT(*) FROM operations) AS logical_operations,
      (SELECT COUNT(*) FROM operations WHERE succeeded=1 AND had_failure=0 AND had_fallback=0) AS first_try_successes,
      (SELECT COUNT(*) FROM operations WHERE succeeded=1 AND (had_failure=1 OR had_fallback=1)) AS recovered_operations,
      (SELECT COUNT(*) FROM operations WHERE succeeded=0 AND had_failure=1) AS terminal_failures,
      (SELECT COUNT(*) FROM operations WHERE succeeded=0 AND had_failure=0 AND had_cancellation=1) AS cancelled_operations,
      COALESCE((SELECT SUM(input_tokens) FROM filtered),0) AS input_tokens,
      COALESCE((SELECT SUM(cached_input_tokens) FROM filtered),0) AS cached_input_tokens,
      COALESCE((SELECT SUM(output_tokens) FROM filtered),0) AS output_tokens,
      COALESCE((SELECT SUM(reasoning_tokens) FROM filtered),0) AS reasoning_tokens,
      COALESCE((SELECT SUM(total_tokens) FROM filtered),0) AS total_tokens,
      COALESCE((SELECT SUM(estimated_cost_usd) FROM filtered),0) AS estimated_cost_usd
  `).get() as AggregateRow;
  return {
    attempts: Number(row.attempts || 0), successfulAttempts: Number(row.successful_attempts || 0),
    failedAttempts: Number(row.failed_attempts || 0), cancelledAttempts: Number(row.cancelled_attempts || 0),
    fallbackAttempts: Number(row.fallback_attempts || 0), logicalOperations: Number(row.logical_operations || 0),
    firstTrySuccesses: Number(row.first_try_successes || 0), recoveredOperations: Number(row.recovered_operations || 0),
    terminalFailures: Number(row.terminal_failures || 0), cancelledOperations: Number(row.cancelled_operations || 0),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0), outputTokens: Number(row.output_tokens || 0),
    reasoningTokens: Number(row.reasoning_tokens || 0), totalTokens: Number(row.total_tokens || 0),
    estimatedCostUsd: Number(Number(row.estimated_cost_usd || 0).toFixed(6)),
  };
}

type BreakdownRow = { key: string; attempts: number; logical_operations: number; failed_attempts: number;
  terminal_failures: number; reasoning_tokens: number; total_tokens: number; estimated_cost_usd: number };

function breakdown(column: 'feature' | 'actual_model' | 'work_class') {
  const rows = getDb().prepare(`
    WITH filtered AS (
      SELECT *, COALESCE(logical_request_id, request_id) AS logical_id
      FROM ai_usage_events WHERE datetime(completed_at) >= datetime('now','-30 days')
    ), operations AS (
      SELECT ${column} AS group_key, logical_id,
        MAX(CASE WHEN status='success' THEN 1 ELSE 0 END) AS succeeded,
        MAX(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS had_failure
      FROM filtered GROUP BY ${column}, logical_id
    ), terminal AS (
      SELECT group_key, SUM(CASE WHEN succeeded=0 AND had_failure=1 THEN 1 ELSE 0 END) AS terminal_failures
      FROM operations GROUP BY group_key
    )
    SELECT COALESCE(f.${column}, 'historical_unknown') AS key,
      COUNT(*) AS attempts, COUNT(DISTINCT f.logical_id) AS logical_operations,
      SUM(CASE WHEN f.status='failed' THEN 1 ELSE 0 END) AS failed_attempts,
      COALESCE(t.terminal_failures,0) AS terminal_failures,
      COALESCE(SUM(f.reasoning_tokens),0) AS reasoning_tokens,
      COALESCE(SUM(f.total_tokens),0) AS total_tokens,
      COALESCE(SUM(f.estimated_cost_usd),0) AS estimated_cost_usd
    FROM filtered f LEFT JOIN terminal t ON t.group_key IS f.${column}
    GROUP BY f.${column} ORDER BY estimated_cost_usd DESC, attempts DESC LIMIT 16
  `).all() as BreakdownRow[];
  return rows.map(row => ({ key: row.key, attempts: Number(row.attempts),
    logicalOperations: Number(row.logical_operations), failedAttempts: Number(row.failed_attempts),
    terminalFailures: Number(row.terminal_failures), reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens), estimatedCostUsd: Number(Number(row.estimated_cost_usd).toFixed(6)) }));
}

export async function GET() {
  try {
    const db = getDb();
    const coverage = db.prepare(`SELECT MIN(completed_at) AS started_at, MAX(completed_at) AS latest_at FROM ai_usage_events`).get() as { started_at: string | null; latest_at: string | null };
    const byModel = breakdown('actual_model').map(row => ({ model: row.key, ...row }));
    const byFeature = breakdown('feature').map(row => ({ feature: row.key, ...row }));
    const byWorkClass = breakdown('work_class').map(row => ({ workClass: row.key, ...row }));
    const byError = db.prepare(`SELECT COALESCE(error_code,'UNKNOWN') AS errorCode, COUNT(*) AS attempts FROM ai_usage_events WHERE status='failed' AND datetime(completed_at) >= datetime('now','-30 days') GROUP BY error_code ORDER BY attempts DESC`).all() as Array<{ errorCode: string; attempts: number }>;
    const daily = db.prepare(`SELECT date(completed_at,'localtime') AS date, COUNT(*) AS attempts, COUNT(DISTINCT COALESCE(logical_request_id, request_id)) AS logical_operations, COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd FROM ai_usage_events WHERE datetime(completed_at) >= datetime('now','-30 days') GROUP BY date(completed_at,'localtime') ORDER BY date ASC`).all() as Array<{ date: string; attempts: number; logical_operations: number; estimated_cost_usd: number }>;
    const thirtyDays = operationAggregate("datetime(completed_at) >= datetime('now','-30 days')");
    const daysWithUsage = Math.max(1, daily.length);
    const repeated = db.prepare(`
      SELECT COALESCE(SUM(call_count - 1),0) AS repeated_attempts,
        COALESCE(SUM(repeated_cost),0) AS repeated_cost
      FROM (
        SELECT feature, request_fingerprint, COUNT(*) AS call_count,
          SUM(estimated_cost_usd) - MIN(estimated_cost_usd) AS repeated_cost
        FROM ai_usage_events
        WHERE status='success' AND request_fingerprint IS NOT NULL
          AND datetime(completed_at) >= datetime('now','-30 days')
        GROUP BY feature, request_fingerprint HAVING COUNT(*) > 1
      )
    `).get() as { repeated_attempts: number; repeated_cost: number };
    const unattributed = db.prepare(`
      SELECT COUNT(*) AS attempts FROM ai_usage_events
      WHERE (feature='unknown' OR feature IS NULL OR work_class IS NULL OR quality_tier IS NULL)
        AND datetime(completed_at) >= datetime('now','-30 days')
    `).get() as { attempts: number };
    return NextResponse.json({
      periods: {
        today: operationAggregate("date(completed_at,'localtime') = date('now','localtime')"),
        sevenDays: operationAggregate("datetime(completed_at) >= datetime('now','-7 days')"),
        thirtyDays, allTime: operationAggregate(),
      },
      byModel, byFeature, byWorkClass, circuit: unifiedAiCircuitBreaker.snapshot(),
      byError: byError.map(row => ({ errorCode: row.errorCode, attempts: Number(row.attempts) })),
      daily: daily.map(row => ({ date: row.date, attempts: Number(row.attempts), logicalOperations: Number(row.logical_operations), estimatedCostUsd: Number(Number(row.estimated_cost_usd).toFixed(6)) })),
      projection: { monthlyCostUsd: Number(((thirtyDays.estimatedCostUsd / daysWithUsage) * 30).toFixed(2)), enforcement: 'none' },
      optimizationSignals: {
        unattributedAttempts: Number(unattributed.attempts || 0),
        repeatedSuccessfulAttempts: Number(repeated.repeated_attempts || 0),
        repeatedRequestCostUsd: Number(Number(repeated.repeated_cost || 0).toFixed(6)),
        reasoningSharePercent: Math.round((thirtyDays.reasoningTokens / Math.max(1, thirtyDays.totalTokens)) * 100),
      },
      coverage: { startedAt: coverage.started_at, latestAt: coverage.latest_at },
      pricing: { version: AI_PRICING_VERSION, source: AI_PRICING_SOURCE, currency: 'USD', estimateOnly: true },
      limitations: [
        'Usage begins when migration 047 is deployed; earlier calls are not reconstructed.',
        'Rows before migration 048 retain historical_unknown attribution where it cannot be reconstructed safely.',
        'The Vertex AI invoice is authoritative; taxes, negotiated discounts, and promotional credits are excluded.',
        'Live voice audio token usage is not exposed by this server-side wrapper and is tracked separately.',
      ],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
