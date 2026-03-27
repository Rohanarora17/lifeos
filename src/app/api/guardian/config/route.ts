import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * GET /api/guardian/config
 *
 * Returns domain configuration lists used by the browser extension.
 * Replaces hardcoded arrays in extension/background.js — these come from the DB
 * so they can be updated without reloading the extension.
 *
 * privacyDomains     — never tracked, even during active sessions (financial, health, auth)
 * contextSensitiveDomains — require session-aware AI re-classification (YouTube, Reddit, etc.)
 */
export async function GET() {
  try {
    const db = getDb();

    const privacyDomains = (db.prepare(
      'SELECT domain FROM privacy_blocked_domains WHERE is_active = 1'
    ).all() as { domain: string }[]).map(r => r.domain);

    const contextSensitiveDomains = (db.prepare(
      'SELECT domain FROM context_sensitive_domains WHERE is_active = 1'
    ).all() as { domain: string }[]).map(r => r.domain);

    return NextResponse.json({ privacyDomains, contextSensitiveDomains });
  } catch (error) {
    // Tables may not exist if migration hasn't run yet — return safe defaults
    return NextResponse.json({ privacyDomains: [], contextSensitiveDomains: [] });
  }
}
