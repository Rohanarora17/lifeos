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
 * Parse a structured screen time report from iOS Shortcuts.
 * The iOS Shortcut sends text in this format:
 *
 * SCREEN_TIME_REPORT
 * date: 2026-04-10
 * type: morning
 * Activity :
 * Shortcuts (17m)
 * Instagram (4m)
 * Settings (1m)
 * Snapchat (59s)
 * Telegram (55s)
 * WhatsApp (39s)
 * Messages (37s)
 * Photos (37s)
 *
 * App durations may be in minutes (17m) or seconds (59s).
 * Seconds are converted to decimal minutes.
 * total, pickup, first_pickup, longest_free are not available — derived or null.
 */
export function parseScreenTimeReport(text: string): ParsedScreenTimeReport | null {
  const lines = text.trim().split('\n').map(l => l.trim());

  if (!lines[0].includes('SCREEN_TIME_REPORT')) return null;

  // Find the Activity section divider
  const activityIdx = lines.findIndex(l => l.toLowerCase().startsWith('activity'));

  // Parse key-value pairs from lines before Activity (or all lines if no Activity section)
  const kvLines = activityIdx >= 0 ? lines.slice(0, activityIdx) : lines;
  const getValue = (key: string): string | null => {
    const line = kvLines.find(l => l.toLowerCase().startsWith(key + ':'));
    return line ? line.split(':').slice(1).join(':').trim() : null;
  };

  const dateStr = getValue('date') || new Date().toISOString().slice(0, 10);
  const typeRaw = getValue('type');
  const validTypes = ['morning', 'midday', 'evening'] as const;
  const reportType: 'morning' | 'midday' | 'evening' | 'manual' =
    validTypes.includes(typeRaw as 'morning' | 'midday' | 'evening')
      ? (typeRaw as 'morning' | 'midday' | 'evening')
      : 'manual';

  // Parse app entries after Activity line
  const appRegex = /^(.+?)\s*\((\d+)(m|s)\)\s*$/;
  const otherData: Record<string, number> = {};

  if (activityIdx >= 0) {
    const appLines = lines.slice(activityIdx + 1);
    for (const line of appLines) {
      if (!line) continue;
      const match = line.match(appRegex);
      if (!match) continue;
      // Strip non-printable / non-ASCII control chars (e.g. Unicode LTR mark U+200E)
      const appName = match[1].replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '').trim();
      const num = parseInt(match[2], 10);
      const unit = match[3];
      const minutes = unit === 's' ? Math.round(num / 60 * 10) / 10 : num;
      if (appName) {
        otherData[appName] = minutes;
      }
    }
  }

  // Calculate total by summing all apps
  const totalMinutes = Object.keys(otherData).length > 0
    ? Math.round(Object.values(otherData).reduce((a, b) => a + b, 0))
    : null;

  // Map well-known apps (case-insensitive)
  const findApp = (name: string): number | null => {
    const entry = Object.entries(otherData).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return entry ? entry[1] : null;
  };

  return {
    reportType,
    reportDate: dateStr,
    totalMinutes,
    instagramMinutes: findApp('instagram'),
    youtubeMinutes: findApp('youtube'),
    tiktokMinutes: findApp('tiktok'),
    safariMinutes: findApp('safari'),
    pickupCount: null,
    firstPickupTime: null,
    longestPhoneFreeMinutes: null,
    otherData,
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

  const otherDataJson = JSON.stringify(report.otherData);

  if (existing) {
    db.prepare(`
      UPDATE phone_screen_time SET
        total_minutes = ?, instagram_minutes = ?, youtube_minutes = ?,
        tiktok_minutes = ?, safari_minutes = ?, pickup_count = ?,
        first_pickup_time = ?, longest_phone_free_minutes = ?, raw_text = ?,
        other_data = ?, received_at = datetime('now','localtime')
      WHERE id = ?
    `).run(
      report.totalMinutes, report.instagramMinutes, report.youtubeMinutes,
      report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText,
      otherDataJson, existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO phone_screen_time
        (report_date, report_type, total_minutes, instagram_minutes, youtube_minutes,
         tiktok_minutes, safari_minutes, pickup_count, first_pickup_time,
         longest_phone_free_minutes, raw_text, other_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.reportDate, report.reportType, report.totalMinutes, report.instagramMinutes,
      report.youtubeMinutes, report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText, otherDataJson,
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
