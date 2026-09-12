import { randomUUID } from 'crypto';
import { getDb } from './db';

export const AI_PRICING_VERSION = 'vertex-standard-2026-09-13';
export const AI_PRICING_SOURCE = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens?: number;
};

type UsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

type Price = { input: number; cachedInput: number; output: number; longInput?: number; longOutput?: number };

// Standard pay-as-you-go USD per one million tokens, global endpoint.
const PRICES: Record<string, Price> = {
  'gemini-3.1-pro-preview': { input: 2.00, cachedInput: 0.20, output: 12.00, longInput: 4.00, longOutput: 18.00 },
  'gemini-3.1-flash-lite': { input: 0.25, cachedInput: 0.025, output: 1.50 },
  'gemini-2.5-pro': { input: 1.25, cachedInput: 0.125, output: 10.00, longInput: 2.50, longOutput: 15.00 },
  'gemini-2.5-flash': { input: 0.30, cachedInput: 0.03, output: 2.50 },
  'gemini-2.5-flash-lite': { input: 0.10, cachedInput: 0.01, output: 0.40 },
};

function finiteInt(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function normalizeUsageMetadata(metadata?: UsageMetadata | null): TokenUsage {
  return {
    inputTokens: finiteInt(metadata?.promptTokenCount),
    cachedInputTokens: finiteInt(metadata?.cachedContentTokenCount),
    outputTokens: finiteInt(metadata?.candidatesTokenCount),
    reasoningTokens: finiteInt(metadata?.thoughtsTokenCount),
    totalTokens: finiteInt(metadata?.totalTokenCount),
  };
}

export function estimateAiCostUsd(model: string, usage: TokenUsage) {
  const price = PRICES[model];
  if (!price) return 0;
  const longContext = usage.inputTokens > 200_000;
  const inputRate = longContext ? (price.longInput ?? price.input) : price.input;
  const outputRate = longContext ? (price.longOutput ?? price.output) : price.output;
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const output = usage.outputTokens + usage.reasoningTokens;
  return Number((((uncached * inputRate) + (cached * price.cachedInput) + (output * outputRate)) / 1_000_000).toFixed(9));
}

function errorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown AI request failure');
  const upper = message.toUpperCase();
  const code = ['INVALID_MODEL_OUTPUT', 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'UNAVAILABLE']
    .find(value => upper.includes(value)) || 'AI_REQUEST_FAILED';
  return { code, message: message.slice(0, 1_000) };
}

export function inferAiFeatureFromStack(stack = new Error().stack || '') {
  const line = stack.split('\n').find(item =>
    item.includes('/src/') && !item.includes('/src/lib/ai.ts') && !item.includes('/src/lib/ai-usage.ts'));
  const match = line?.match(/\/src\/(.+?):\d+:\d+/);
  return match?.[1]?.replace(/\.(?:ts|tsx)$/, '') || 'unknown';
}

export function recordAiUsageAttempt(input: {
  requestId?: string;
  requestedModel: string;
  actualModel: string;
  operation: 'generate' | 'stream';
  feature: string;
  status: 'success' | 'failed' | 'cancelled';
  attempt: number;
  usedFallback: boolean;
  latencyMs: number;
  usageMetadata?: UsageMetadata | null;
  error?: unknown;
  startedAt?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const usage = normalizeUsageMetadata(input.usageMetadata);
    // Cancelled streams may already contain billable generated tokens. Failed
    // calls have no reliable usage metadata and remain unpriced.
    const cost = input.status === 'failed' ? 0 : estimateAiCostUsd(input.actualModel, usage);
    const error = input.error ? errorDetails(input.error) : { code: null, message: null };
    const completedAt = new Date().toISOString();
    getDb().prepare(`
      INSERT OR IGNORE INTO ai_usage_events (
        request_id, provider, project_id, location, requested_model, actual_model,
        operation, feature, status, attempt, used_fallback, input_tokens,
        cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
        estimated_cost_usd, pricing_version, latency_ms, error_code, error_message,
        metadata_json, started_at, completed_at
      ) VALUES (?, 'vertex_ai', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId || randomUUID(),
      process.env.GOOGLE_CLOUD_PROJECT || null,
      process.env.GOOGLE_CLOUD_LOCATION || 'global',
      input.requestedModel,
      input.actualModel,
      input.operation,
      input.feature || 'unknown',
      input.status,
      input.attempt,
      input.usedFallback ? 1 : 0,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.reasoningTokens,
      usage.totalTokens || (usage.inputTokens + usage.outputTokens + usage.reasoningTokens),
      cost,
      AI_PRICING_VERSION,
      Math.max(0, Math.round(input.latencyMs)),
      error.code,
      error.message,
      JSON.stringify(input.metadata || {}),
      input.startedAt || completedAt,
      completedAt,
    );
  } catch (ledgerError) {
    console.error('[AI usage] Could not persist request usage:', ledgerError);
  }
}
