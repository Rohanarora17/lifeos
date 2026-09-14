import { getDb } from './db';

export interface SessionPerformanceProfile {
  sampleSize: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  averageFocusScore: number | null;
  averageCompletionRatio: number | null;
  completedAsPlannedRate: number | null;
  recommendedMinutes: number | null;
  bestStartHours: number[];
  trend: 'improving' | 'declining' | 'stable' | 'unknown';
  explanation: string;
}

interface SessionRow {
  duration_minutes: number;
  elapsed_minutes: number;
  focus_score: number;
  started_at: string | null;
  completed_at: string | null;
}

interface NormalizedSession {
  duration: number;
  elapsed: number;
  focus: number;
  completion: number;
  hour: number | null;
  outcome: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseHour(value: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T')
    : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.getHours() : null;
}

function normalize(row: SessionRow): NormalizedSession | null {
  const duration = Number(row.duration_minutes);
  const elapsed = Number(row.elapsed_minutes);
  const focus = Number(row.focus_score);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(elapsed) || elapsed < 0) return null;
  const safeFocus = Number.isFinite(focus) ? Math.max(0, Math.min(100, focus)) : 0;
  const completion = Math.max(0, Math.min(1, elapsed / duration));
  return {
    duration,
    elapsed,
    focus: safeFocus,
    completion,
    hour: parseHour(row.started_at || row.completed_at),
    outcome: safeFocus * 0.55 + completion * 100 * 0.45,
  };
}

export function getSessionPerformanceProfile(limit = 30): SessionPerformanceProfile {
  let rows: SessionRow[] = [];
  try {
    rows = getDb().prepare(`
      SELECT duration_minutes, elapsed_minutes, final_focus_score AS focus_score, started_at, completed_at
      FROM guardian_session_summaries
      WHERE duration_minutes > 0
        AND COALESCE(completed_at, started_at) >= datetime('now', '-45 days')
      ORDER BY COALESCE(completed_at, started_at) DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, Math.round(limit)))) as SessionRow[];
  } catch {
    rows = [];
  }

  const sessions = rows.map(normalize).filter((row): row is NormalizedSession => row !== null);
  const sampleSize = sessions.length;
  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      confidence: 'insufficient',
      averageFocusScore: null,
      averageCompletionRatio: null,
      completedAsPlannedRate: null,
      recommendedMinutes: null,
      bestStartHours: [],
      trend: 'unknown',
      explanation: 'No completed Guardian sessions are available yet, so LifeOS is still using a declared default.',
    };
  }

  const confidence = sampleSize < 5 ? 'low' : sampleSize < 10 ? 'medium' : 'high';
  const successful = sessions.filter(session => session.completion >= 0.75 && session.focus >= 50);
  const durationSource = successful.length >= 3 ? successful : sampleSize >= 5 ? sessions : [];
  const recommended = median(durationSource.map(session => Math.min(session.duration, session.elapsed || session.duration)));

  const hourGroups = new Map<number, number[]>();
  for (const session of sessions) {
    if (session.hour === null) continue;
    const values = hourGroups.get(session.hour) ?? [];
    values.push(session.outcome);
    hourGroups.set(session.hour, values);
  }
  const overallOutcome = average(sessions.map(session => session.outcome)) ?? 0;
  const bestStartHours = [...hourGroups.entries()]
    .filter(([, outcomes]) => outcomes.length >= 2)
    .map(([hour, outcomes]) => ({ hour, outcome: average(outcomes) ?? 0, count: outcomes.length }))
    .filter(group => group.outcome >= overallOutcome)
    .sort((a, b) => b.outcome - a.outcome || b.count - a.count)
    .slice(0, 3)
    .map(group => group.hour);

  let trend: SessionPerformanceProfile['trend'] = 'unknown';
  if (sampleSize >= 6) {
    const recent = average(sessions.slice(0, 3).map(session => session.outcome)) ?? 0;
    const prior = average(sessions.slice(3, 6).map(session => session.outcome)) ?? 0;
    trend = recent >= prior + 6 ? 'improving' : recent <= prior - 6 ? 'declining' : 'stable';
  }

  const averageFocusScore = average(sessions.map(session => session.focus));
  const averageCompletionRatio = average(sessions.map(session => session.completion));
  const completedAsPlannedRate = sessions.filter(session => session.completion >= 0.8).length / sampleSize;
  const explanationParts = [
    `${sampleSize} session${sampleSize === 1 ? '' : 's'} observed`,
    `${Math.round((averageCompletionRatio ?? 0) * 100)}% average planned-time completion`,
    `${Math.round(averageFocusScore ?? 0)} average focus`,
  ];
  if (bestStartHours.length) explanationParts.push(`strongest repeated start hour${bestStartHours.length === 1 ? '' : 's'}: ${bestStartHours.map(hour => `${String(hour).padStart(2, '0')}:00`).join(', ')}`);

  return {
    sampleSize,
    confidence,
    averageFocusScore: averageFocusScore === null ? null : Math.round(averageFocusScore),
    averageCompletionRatio,
    completedAsPlannedRate,
    recommendedMinutes: recommended === null ? null : Math.max(10, Math.min(180, Math.round(recommended / 5) * 5)),
    bestStartHours,
    trend,
    explanation: explanationParts.join('; '),
  };
}
