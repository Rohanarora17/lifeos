/**
 * History epoch — the date LifeOS treats as the start of the current life run.
 *
 * Pre-epoch goals, sessions, activities, and stale UIL narratives must not
 * generate "you did nothing for N days" coaching. History is still used, but
 * only from this boundary forward.
 *
 * Resolution order:
 *   1. Explicit setting `history_start_date` (YYYY-MM-DD)
 *   2. Auto: earliest daily_checkin, else earliest daily_plan, else earliest
 *      guardian session on/after a long gap is NOT used — only check-in/plan
 *      as intentional "I am using LifeOS again" signals
 *   3. null → treat as fresh today (no pre-history guilt)
 */

import { getDb, getSetting, setSetting } from './db';

export const HISTORY_START_DATE_KEY = 'history_start_date';

const IST_OFFSET_MS = 19_800_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type HistoryEpochInfo = {
  startDate: string;
  source: 'setting' | 'first_checkin' | 'first_plan' | 'today_fallback';
  dayIndex: number; // 1 = first day of this run
  isFreshStart: boolean; // dayIndex <= 7
};

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && DATE_RE.test(value.trim());
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

function discoverAutoStartDate(): { date: string; source: HistoryEpochInfo['source'] } | null {
  const db = getDb();

  try {
    const checkin = db.prepare(`
      SELECT MIN(checkin_date) as d FROM daily_checkins
      WHERE checkin_date IS NOT NULL AND checkin_date != ''
    `).get() as { d: string | null } | undefined;
    if (isValidDate(checkin?.d ?? null)) {
      return { date: checkin!.d!, source: 'first_checkin' };
    }
  } catch { /* table may not exist in tests */ }

  try {
    const plan = db.prepare(`
      SELECT MIN(plan_date) as d FROM daily_plans
      WHERE plan_date IS NOT NULL AND plan_date != ''
    `).get() as { d: string | null } | undefined;
    if (isValidDate(plan?.d ?? null)) {
      return { date: plan!.d!, source: 'first_plan' };
    }
  } catch { /* */ }

  return null;
}

/**
 * Resolve history start without writing settings.
 */
export function resolveHistoryStartDate(): { date: string; source: HistoryEpochInfo['source'] } {
  const configured = getSetting(HISTORY_START_DATE_KEY)?.trim();
  if (isValidDate(configured)) {
    return { date: configured, source: 'setting' };
  }

  const discovered = discoverAutoStartDate();
  if (discovered) return discovered;

  return { date: todayIst(), source: 'today_fallback' };
}

/**
 * Ensure a durable epoch exists. Call when the user intentionally engages
 * (first check-in, fresh-start command). Does not overwrite an explicit setting.
 */
export function ensureHistoryStartDate(preferredDate?: string): HistoryEpochInfo {
  const configured = getSetting(HISTORY_START_DATE_KEY)?.trim();
  if (isValidDate(configured)) {
    return getHistoryEpochInfo();
  }

  let date = isValidDate(preferredDate) ? preferredDate : null;
  let source: HistoryEpochInfo['source'] = 'setting';

  if (!date) {
    const discovered = discoverAutoStartDate();
    if (discovered) {
      date = discovered.date;
      source = discovered.source;
    } else {
      date = todayIst();
      source = 'today_fallback';
    }
  } else {
    source = 'setting';
  }

  setSetting(HISTORY_START_DATE_KEY, date);
  return getHistoryEpochInfo();
}

/**
 * Explicit fresh start: pin epoch to a date (default today) and return info.
 * Call this when the user says they are starting over.
 */
export function setHistoryStartDate(date: string = todayIst()): HistoryEpochInfo {
  if (!isValidDate(date)) {
    throw new Error(`Invalid history_start_date: ${date}`);
  }
  setSetting(HISTORY_START_DATE_KEY, date);
  return getHistoryEpochInfo();
}

export function getHistoryStartDate(): string {
  return resolveHistoryStartDate().date;
}

export function getHistoryEpochInfo(): HistoryEpochInfo {
  const { date, source } = resolveHistoryStartDate();
  const dayIndex = daysBetween(date, todayIst()) + 1;
  return {
    startDate: date,
    source,
    dayIndex,
    isFreshStart: dayIndex <= 7,
  };
}

/** Inclusive lower bound for a rolling lookback that must not cross the epoch. */
export function lookbackStartDate(maxDays: number, nowDate: string = todayIst()): string {
  const epoch = getHistoryStartDate();
  const raw = new Date(Date.parse(`${nowDate}T00:00:00Z`) - Math.max(0, maxDays) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return raw < epoch ? epoch : raw;
}

/** SQL fragment helper: date column >= history start (caller binds value). */
export function historyStartDateValue(): string {
  return getHistoryStartDate();
}

/** True if a date/datetime string is strictly before the history epoch. */
export function isBeforeHistoryStart(value: string | null | undefined): boolean {
  if (!value) return true;
  const day = value.slice(0, 10);
  if (!isValidDate(day)) return true;
  return day < getHistoryStartDate();
}

/**
 * True if an entity should be treated as in-scope for this life run.
 * Prefer created/updated/touched timestamps; if only pre-epoch timestamps
 * exist, the entity is out of scope unless explicitly re-engaged post-epoch.
 */
export function isInCurrentHistory(input: {
  createdAt?: string | null;
  updatedAt?: string | null;
  lastTouchedAt?: string | null;
}): boolean {
  const epoch = getHistoryStartDate();
  for (const raw of [input.lastTouchedAt, input.updatedAt, input.createdAt]) {
    if (!raw) continue;
    const day = raw.slice(0, 10);
    if (isValidDate(day) && day >= epoch) return true;
  }
  return false;
}

/**
 * Days since an event for coaching. If the event is pre-epoch, return null
 * (do not report "151 days") — caller should skip or say "not started this run".
 */
export function daysSinceInHistory(eventAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!eventAt) return null;
  const day = eventAt.slice(0, 10);
  if (!isValidDate(day)) return null;
  const epoch = getHistoryStartDate();
  if (day < epoch) return null;

  const eventMs = Date.parse(eventAt.includes('T') || eventAt.includes(' ')
    ? eventAt.replace(' ', 'T') + (eventAt.includes('Z') || /[+-]\d{2}:\d{2}$/.test(eventAt) ? '' : 'Z')
    : `${eventAt}T00:00:00Z`);
  if (!Number.isFinite(eventMs)) return null;
  return Math.max(0, Math.floor((now.getTime() - eventMs) / 86_400_000));
}

/** Human-readable block for LLM prompts and Telegram context. */
export function formatHistoryEpochContext(): string {
  const info = getHistoryEpochInfo();
  const lines = [
    `=== HISTORY EPOCH ===`,
    `Coaching history starts: ${info.startDate} (source: ${info.source})`,
    `Day of current run: ${info.dayIndex}`,
  ];
  if (info.isFreshStart) {
    lines.push(
      `FRESH START MODE: Do NOT judge pre-epoch goals, sessions, or "weeks of inactivity".`,
      `Sparse post-epoch data means early days, not long-term avoidance.`,
    );
  } else {
    lines.push(`Use only data on/after ${info.startDate} when talking about streaks, neglect, or "last N days".`);
  }
  return lines.join('\n');
}

/** Unix ms for start of epoch day (UTC midnight of the date string). */
export function historyStartEpochMs(): number {
  return Date.parse(`${getHistoryStartDate()}T00:00:00Z`);
}
