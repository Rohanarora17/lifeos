import { getDb } from './db';

export const GUARDIAN_VOICE_TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_WINDOW_MS = 60_000;
const MAX_TOKENS_PER_SESSION_WINDOW = 3;

type VoiceLimitConfig = {
  maxConcurrentSessions: number;
  maxDailyMinutes: number;
};

export type GuardianVoiceLeaseDecision =
  | { allowed: true; expiresAt: number }
  | { allowed: false; reason: 'token_rate_limit' | 'concurrent_session_limit' | 'daily_voice_limit'; retryAfterSeconds: number };

function boundedEnvNumber(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function getGuardianVoiceLimitConfig(): VoiceLimitConfig {
  return {
    maxConcurrentSessions: boundedEnvNumber('LIFEOS_MAX_CONCURRENT_LIVE_SESSIONS', 1, 1, 10),
    maxDailyMinutes: boundedEnvNumber('LIFEOS_MAX_DAILY_LIVE_MINUTES', 120, 10, 1_440),
  };
}

export function acquireGuardianVoiceLease(sessionId: string): GuardianVoiceLeaseDecision {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + GUARDIAN_VOICE_TOKEN_TTL_MS;
  const config = getGuardianVoiceLimitConfig();

  const acquire = db.transaction((): GuardianVoiceLeaseDecision => {
    db.prepare('DELETE FROM guardian_voice_leases WHERE expires_at <= ? OR released_at IS NOT NULL').run(now);

    const existing = db.prepare(`
      SELECT expires_at, window_started_at, issue_count
      FROM guardian_voice_leases
      WHERE session_id = ? AND expires_at > ? AND released_at IS NULL
    `).get(sessionId, now) as { expires_at: number; window_started_at: number; issue_count: number } | undefined;

    if (existing) {
      const windowExpired = now - existing.window_started_at >= TOKEN_WINDOW_MS;
      const issueCount = windowExpired ? 1 : existing.issue_count + 1;
      if (!windowExpired && issueCount > MAX_TOKENS_PER_SESSION_WINDOW) {
        return {
          allowed: false,
          reason: 'token_rate_limit',
          retryAfterSeconds: Math.ceil((existing.window_started_at + TOKEN_WINDOW_MS - now) / 1000),
        };
      }

      db.prepare(`
        UPDATE guardian_voice_leases
        SET issued_at = ?, expires_at = ?, window_started_at = ?, issue_count = ?
        WHERE session_id = ?
      `).run(now, expiresAt, windowExpired ? now : existing.window_started_at, issueCount, sessionId);
      return { allowed: true, expiresAt };
    }

    const activeLeaseCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM guardian_voice_leases
      WHERE expires_at > ? AND released_at IS NULL
    `).get(now) as { count: number }).count;
    if (activeLeaseCount >= config.maxConcurrentSessions) {
      return { allowed: false, reason: 'concurrent_session_limit', retryAfterSeconds: Math.ceil(GUARDIAN_VOICE_TOKEN_TTL_MS / 1000) };
    }

    const usageDate = (db.prepare("SELECT date('now', 'localtime') as usageDate").get() as { usageDate: string }).usageDate;
    const usage = db.prepare(`
      SELECT authorized_minutes FROM guardian_voice_daily_usage WHERE usage_date = ?
    `).get(usageDate) as { authorized_minutes: number } | undefined;
    const leaseMinutes = Math.ceil(GUARDIAN_VOICE_TOKEN_TTL_MS / 60_000);
    const authorizedMinutes = usage?.authorized_minutes || 0;
    if (authorizedMinutes + leaseMinutes > config.maxDailyMinutes) {
      return { allowed: false, reason: 'daily_voice_limit', retryAfterSeconds: 60 * 60 };
    }

    db.prepare(`
      INSERT INTO guardian_voice_daily_usage (usage_date, authorized_minutes)
      VALUES (?, ?)
      ON CONFLICT(usage_date) DO UPDATE SET
        authorized_minutes = excluded.authorized_minutes,
        updated_at = datetime('now', 'localtime')
    `).run(usageDate, authorizedMinutes + leaseMinutes);
    db.prepare(`
      INSERT INTO guardian_voice_leases (session_id, issued_at, expires_at, window_started_at, issue_count)
      VALUES (?, ?, ?, ?, 1)
    `).run(sessionId, now, expiresAt, now);

    return { allowed: true, expiresAt };
  });

  return acquire();
}

export function releaseGuardianVoiceLease(sessionId: string) {
  getDb().prepare(`
    UPDATE guardian_voice_leases
    SET released_at = ?
    WHERE session_id = ? AND released_at IS NULL
  `).run(Date.now(), sessionId);
}
