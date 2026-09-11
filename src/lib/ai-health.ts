import { getDb } from '@/lib/db';

export type AiServiceHealth = {
  status: 'unknown' | 'healthy' | 'failed';
  model: string | null;
  failureCode: string | null;
  message: string | null;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  updatedAt: string | null;
};

type AiHealthRow = {
  status: 'healthy' | 'failed';
  model: string | null;
  failure_code: string | null;
  message: string | null;
  first_failure_at: string | null;
  last_failure_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  updated_at: string;
};

const SERVICE = 'vertex_ai';

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  if (typeof error === 'string') return error.slice(0, 1_000);
  try {
    return JSON.stringify(error).slice(0, 1_000);
  } catch {
    return 'Unknown AI service failure';
  }
}

export function classifyAiFailure(error: unknown) {
  const message = errorMessage(error);
  const normalized = message.toUpperCase();
  const knownCodes = [
    'BILLING_DISABLED',
    'RESOURCE_EXHAUSTED',
    'QUOTA_EXCEEDED',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
    'MODEL_NOT_FOUND',
    'CONFIGURATION_ERROR',
    'UNAVAILABLE',
  ];
  const code = knownCodes.find(candidate => normalized.includes(candidate))
    || ((error as { status?: unknown })?.status ? `HTTP_${String((error as { status?: unknown }).status)}` : 'AI_REQUEST_FAILED');
  return { code, message };
}

export function recordAiServiceFailure(error: unknown, model: string) {
  try {
    const failure = classifyAiFailure(error);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO ai_service_health (
        service, status, model, failure_code, message, first_failure_at,
        last_failure_at, consecutive_failures, updated_at
      ) VALUES (?, 'failed', ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(service) DO UPDATE SET
        status = 'failed',
        model = excluded.model,
        failure_code = excluded.failure_code,
        message = excluded.message,
        first_failure_at = CASE
          WHEN ai_service_health.status = 'failed' THEN ai_service_health.first_failure_at
          ELSE excluded.first_failure_at
        END,
        last_failure_at = excluded.last_failure_at,
        consecutive_failures = ai_service_health.consecutive_failures + 1,
        updated_at = excluded.updated_at
    `).run(SERVICE, model || null, failure.code, failure.message, now, now, now);
  } catch (healthError) {
    console.error('[AI health] Could not persist terminal failure:', healthError);
  }
}

export function recordAiServiceSuccess(model: string) {
  try {
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO ai_service_health (
        service, status, model, last_success_at, consecutive_failures, updated_at
      ) VALUES (?, 'healthy', ?, ?, 0, ?)
      ON CONFLICT(service) DO UPDATE SET
        status = 'healthy',
        model = excluded.model,
        failure_code = NULL,
        message = NULL,
        first_failure_at = NULL,
        last_success_at = excluded.last_success_at,
        consecutive_failures = 0,
        updated_at = excluded.updated_at
    `).run(SERVICE, model || null, now, now);
  } catch (healthError) {
    console.error('[AI health] Could not persist successful request:', healthError);
  }
}

export function getAiServiceHealth(): AiServiceHealth {
  try {
    const row = getDb().prepare(`
      SELECT status, model, failure_code, message, first_failure_at,
             last_failure_at, last_success_at, consecutive_failures, updated_at
      FROM ai_service_health
      WHERE service = ?
    `).get(SERVICE) as AiHealthRow | undefined;
    if (!row) {
      return {
        status: 'unknown', model: null, failureCode: null, message: null,
        firstFailureAt: null, lastFailureAt: null, lastSuccessAt: null,
        consecutiveFailures: 0, updatedAt: null,
      };
    }
    return {
      status: row.status,
      model: row.model,
      failureCode: row.failure_code,
      message: row.message,
      firstFailureAt: row.first_failure_at,
      lastFailureAt: row.last_failure_at,
      lastSuccessAt: row.last_success_at,
      consecutiveFailures: row.consecutive_failures,
      updatedAt: row.updated_at,
    };
  } catch {
    return {
      status: 'unknown', model: null, failureCode: null, message: null,
      firstFailureAt: null, lastFailureAt: null, lastSuccessAt: null,
      consecutiveFailures: 0, updatedAt: null,
    };
  }
}
