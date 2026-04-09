// src/lib/phone-screen-time.ts
// Parse and store phone screen time reports from iOS Shortcuts via Telegram

import { getDb } from './db';

export interface ParsedScreenTimeReport {
  reportType: 'morning' | 'midday' | 'evening' | 'manual';
  reportDate: string;
  totalMinutes: number | null;
  instagramMinutes: number | null;
  youtubeMinutes: number | null;
  tiktokMinutes: number | null;
  safariMinutes: number | null;
  pickupCount: number | null;
  firstPickupTime: string | null;
  longestPhoneFreeMinutes: number | null;
  otherData: Record<string, number>;
}

/**
 * Parse a structured screen time report.
 * The iOS Shortcut sends text in this format:
 *
 * SCREEN_TIME_REPORT
 * date: 2026-04-09
 * type: evening
 * total: 187
 * instagram: 94
 * youtube: 52
 * tiktok: 0
 * safari: 18
 * pickups: 94
 * first_pickup: 07:14
 * longest_free: 112
 *
 * Fields are flexible — parse what's available, ignore what's missing.
 */
export function parseScreenTimeReport(text: string): ParsedScreenTimeReport | null {
  const lines = text.trim().split('\n').map(l => l.trim());

  if (!lines[0].includes('SCREEN_TIME_REPORT')) return null;

  const getValue = (key: string): string | null => {
    const line = lines.find(l => l.toLowerCase().startsWith(key + ':'));
    return line ? line.split(':').slice(1).join(':').trim() : null;
  };

  const getInt = (key: string): number | null => {
    const val = getValue(key);
    return val !== null ? parseInt(val) : null;
  };

  const dateStr = getValue('date') || new Date().toISOString().slice(0, 10);
  const typeStr = getValue('type') as 'morning' | 'midday' | 'evening' | null;
  const reportType: 'morning' | 'midday' | 'evening' | 'manual' = typeStr || 'manual';

  return {
    reportType,
    reportDate: dateStr,
    totalMinutes: getInt('total'),
    instagramMinutes: getInt('instagram'),
    youtubeMinutes: getInt('youtube'),
    tiktokMinutes: getInt('tiktok'),
    safariMinutes: getInt('safari'),
    pickupCount: getInt('pickups'),
    firstPickupTime: getValue('first_pickup'),
    longestPhoneFreeMinutes: getInt('longest_free'),
    otherData: {},
  };
}

/**
 * Store a parsed screen time report in the DB.
 * If a report for the same date + type already exists, update it.
 */
export function storeScreenTimeReport(report: ParsedScreenTimeReport, rawText: string): void {
  const db = getDb();

  const existing = db.prepare(`
    SELECT id FROM phone_screen_time
    WHERE report_date = ? AND report_type = ?
  `).get(report.reportDate, report.reportType) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE phone_screen_time SET
        total_minutes = ?, instagram_minutes = ?, youtube_minutes = ?,
        tiktok_minutes = ?, safari_minutes = ?, pickup_count = ?,
        first_pickup_time = ?, longest_phone_free_minutes = ?, raw_text = ?,
        received_at = datetime('now','localtime')
      WHERE id = ?
    `).run(
      report.totalMinutes, report.instagramMinutes, report.youtubeMinutes,
      report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO phone_screen_time
        (report_date, report_type, total_minutes, instagram_minutes, youtube_minutes,
         tiktok_minutes, safari_minutes, pickup_count, first_pickup_time,
         longest_phone_free_minutes, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.reportDate, report.reportType, report.totalMinutes, report.instagramMinutes,
      report.youtubeMinutes, report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText,
    );
  }

  console.log(`[PhoneScreenTime] Stored ${report.reportType} report for ${report.reportDate}: total=${report.totalMinutes}m, instagram=${report.instagramMinutes}m`);
}

/**
 * Get today's phone screen time for use in continuity guardian and UIL.
 */
export function getTodayPhoneScreenTime(): {
  totalMinutes: number;
  instagramMinutes: number;
  youtubeMinutes: number;
  pickupCount: number;
} | null {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Use the most recent report for today (prefer evening > midday > morning)
  const row = db.prepare(`
    SELECT total_minutes, instagram_minutes, youtube_minutes, pickup_count
    FROM phone_screen_time
    WHERE report_date = ?
    ORDER BY
      CASE report_type WHEN 'evening' THEN 1 WHEN 'midday' THEN 2 WHEN 'morning' THEN 3 ELSE 4 END
    LIMIT 1
  `).get(today) as { total_minutes: number; instagram_minutes: number; youtube_minutes: number; pickup_count: number } | undefined;

  if (!row) return null;

  return {
    totalMinutes: row.total_minutes || 0,
    instagramMinutes: row.instagram_minutes || 0,
    youtubeMinutes: row.youtube_minutes || 0,
    pickupCount: row.pickup_count || 0,
  };
}

/**
 * Format a phone screen time summary for Telegram.
 */
export function formatPhoneScreenTimeSummary(report: ParsedScreenTimeReport): string {
  const parts: string[] = [
    `<b>📱 Phone Screen Time (${report.reportType})</b>`,
  ];

  if (report.totalMinutes !== null) {
    const hours = Math.floor(report.totalMinutes / 60);
    const mins = report.totalMinutes % 60;
    parts.push(`Total: ${hours}h ${mins}m`);
  }
  if (report.instagramMinutes !== null && report.instagramMinutes > 0) {
    parts.push(`Instagram: ${report.instagramMinutes}m`);
  }
  if (report.youtubeMinutes !== null && report.youtubeMinutes > 0) {
    parts.push(`YouTube: ${report.youtubeMinutes}m`);
  }
  if (report.pickupCount !== null) {
    parts.push(`Pickups: ${report.pickupCount}`);
  }
  if (report.longestPhoneFreeMinutes !== null) {
    parts.push(`Longest phone-free: ${report.longestPhoneFreeMinutes}m`);
  }

  return parts.join('\n');
}
