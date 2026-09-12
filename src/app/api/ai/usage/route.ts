import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { AI_PRICING_SOURCE, AI_PRICING_VERSION } from '@/lib/ai-usage';

export const dynamic = 'force-dynamic';

type AggregateRow = {
  requests: number;
  successful_requests: number;
  failed_requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
};

type ModelBreakdownRow = {
  model: string;
  requests: number;
  total_tokens: number;
  estimated_cost_usd: number;
};

type FeatureBreakdownRow = {
  feature: string;
  requests: number;
  failed_requests: number;
  total_tokens: number;
  estimated_cost_usd: number;
};

function aggregate(where = '1=1') {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successful_requests,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_requests,
      COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
      COALESCE(SUM(total_tokens),0) AS total_tokens,
      COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd
    FROM ai_usage_events WHERE ${where}
  `).get() as AggregateRow;
  return {
    requests: Number(row.requests || 0),
    successfulRequests: Number(row.successful_requests || 0),
    failedRequests: Number(row.failed_requests || 0),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    reasoningTokens: Number(row.reasoning_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    estimatedCostUsd: Number(Number(row.estimated_cost_usd || 0).toFixed(6)),
  };
}

export async function GET() {
  try {
    const db = getDb();
    const coverage = db.prepare(`
      SELECT MIN(completed_at) AS started_at, MAX(completed_at) AS latest_at
      FROM ai_usage_events
    `).get() as { started_at: string | null; latest_at: string | null };
    const byModel = db.prepare(`
      SELECT actual_model AS model, COUNT(*) AS requests,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd
      FROM ai_usage_events
      WHERE datetime(completed_at) >= datetime('now','-30 days')
      GROUP BY actual_model ORDER BY estimated_cost_usd DESC, requests DESC
    `).all() as ModelBreakdownRow[];
    const modelBreakdown = byModel.map(row => ({
      model: row.model,
      requests: Number(row.requests),
      totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(Number(row.estimated_cost_usd).toFixed(6)),
    }));
    const byFeature = db.prepare(`
      SELECT feature, COUNT(*) AS requests,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_requests,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd),0) AS estimated_cost_usd
      FROM ai_usage_events
      WHERE datetime(completed_at) >= datetime('now','-30 days')
      GROUP BY feature ORDER BY estimated_cost_usd DESC, requests DESC LIMIT 12
    `).all() as FeatureBreakdownRow[];
    const featureBreakdown = byFeature.map(row => ({
      feature: row.feature,
      requests: Number(row.requests),
      failedRequests: Number(row.failed_requests),
      totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(Number(row.estimated_cost_usd).toFixed(6)),
    }));

    return NextResponse.json({
      periods: {
        today: aggregate("date(completed_at,'localtime') = date('now','localtime')"),
        sevenDays: aggregate("datetime(completed_at) >= datetime('now','-7 days')"),
        thirtyDays: aggregate("datetime(completed_at) >= datetime('now','-30 days')"),
        allTime: aggregate(),
      },
      byModel: modelBreakdown,
      byFeature: featureBreakdown,
      coverage: { startedAt: coverage.started_at, latestAt: coverage.latest_at },
      pricing: {
        version: AI_PRICING_VERSION,
        source: AI_PRICING_SOURCE,
        currency: 'USD',
        estimateOnly: true,
      },
      limitations: [
        'Usage begins when migration 047 is deployed; earlier calls are not reconstructed.',
        'The Vertex AI invoice is authoritative; taxes, negotiated discounts, and promotional credits are excluded.',
        'Live voice audio token usage is not exposed by this server-side wrapper and is tracked separately.',
      ],
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
