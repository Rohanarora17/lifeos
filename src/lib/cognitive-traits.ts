/**
 * Deterministic cognitive traits for the Cognitive Self-Map (Tier B).
 *
 * Numbers come from SQLite evidence first. AI narrative must not invent these.
 * Sparse data → low confidence, never a fake personality claim.
 *
 * User stances (confirm / dispute / aspirational) persist in settings and
 * promote into mem_facts for agent/planner context.
 */

import { getDb, getSetting, setSetting } from './db';
import { insertFact, updateFact } from './memory';

export type CognitiveTraitId =
  | 'pressure_dependency'
  | 'voluntary_start_rate'
  | 'activation_energy'
  | 'avoidance_age'
  | 'crisis_performance_bonus';

export type TraitTrend = 'improving' | 'worsening' | 'stable' | 'unknown';
export type TraitStance = 'observed' | 'confirmed' | 'disputed' | 'aspirational';

export interface TraitEvidence {
  label: string;
  detail: string;
  at?: string | null;
}

export interface CognitiveTrait {
  id: CognitiveTraitId;
  label: string;
  /** Human-readable summary of the value */
  valueLabel: string;
  /** Canonical numeric value when applicable (0-1 or days) */
  value: number | null;
  unit: string | null;
  confidence: number;
  trend: TraitTrend;
  evidence: TraitEvidence[];
  userStance: TraitStance;
  sampleSize: number;
  updatedAt: string;
}

export interface CognitiveTraitHistoryPoint {
  date: string;
  pressureDependency: number | null;
  voluntaryStartRate: number | null;
  activationEnergyDays: number | null;
  crisisBonus: number | null;
  avoidanceAgeDays: number | null;
  confidence: number;
}

export interface CognitiveTraitBundle {
  generatedAt: string;
  windowDays: number;
  traits: CognitiveTrait[];
  summary: string;
  hypotheses: CognitiveHypothesis[];
  history: CognitiveTraitHistoryPoint[];
  pressureProfile: {
    pressureDependency: number | null;
    voluntaryStartRate: number | null;
    crisisBonus: number | null;
    activationEnergyDays: number | null;
    avoidanceAgeDays: number | null;
    confidence: number;
  };
}

export interface CognitiveHypothesis {
  id: string;
  traitId: CognitiveTraitId;
  claim: string;
  why: string;
  confidence: number;
  evidence: string[];
  stance: TraitStance;
  actionHint: string;
}

export interface TraitStanceRecord {
  stance: TraitStance;
  note?: string;
  updatedAt: string;
}

export type TraitStanceMap = Partial<Record<CognitiveTraitId, TraitStanceRecord>>;

const STANCES_KEY = 'cognitive_trait_stances';
const HISTORY_KEY = 'cognitive_trait_history_v1';
const VALID_STANCES: TraitStance[] = ['observed', 'confirmed', 'disputed', 'aspirational'];
const VALID_TRAIT_IDS: CognitiveTraitId[] = [
  'pressure_dependency',
  'voluntary_start_rate',
  'activation_energy',
  'avoidance_age',
  'crisis_performance_bonus',
];

function factTopicForTrait(traitId: CognitiveTraitId): string {
  return `cognitive_${traitId}`;
}

function todayDateIst(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

export function getCognitiveTraitHistory(limit = 14): CognitiveTraitHistoryPoint[] {
  try {
    const raw = getSetting(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CognitiveTraitHistoryPoint[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

function saveCognitiveTraitHistory(points: CognitiveTraitHistoryPoint[]): void {
  // Keep ~3 months of daily snapshots for multi-week trajectory
  setSetting(HISTORY_KEY, JSON.stringify(points.slice(-90)));
}

/**
 * Improving means healthier wiring for that metric:
 * - PDI / activation / avoidance: lower is better
 * - voluntary starts: higher is better
 * - crisis bonus: not judged as better/worse; stable unless large swing
 */
function trendForSeries(
  values: Array<number | null | undefined>,
  direction: 'lower_is_better' | 'higher_is_better' | 'neutral',
): TraitTrend {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 3) return 'unknown';
  const recent = nums.slice(-3);
  const older = nums.slice(0, Math.max(1, nums.length - 3));
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const delta = recentAvg - olderAvg;
  const threshold = Math.max(0.04, Math.abs(olderAvg) * 0.08);

  if (Math.abs(delta) < threshold) return 'stable';
  if (direction === 'neutral') return 'stable';
  if (direction === 'lower_is_better') return delta < 0 ? 'improving' : 'worsening';
  return delta > 0 ? 'improving' : 'worsening';
}

function applyHistoryTrends(traits: CognitiveTrait[], history: CognitiveTraitHistoryPoint[]): CognitiveTrait[] {
  if (history.length < 2) return traits;
  const trendById: Partial<Record<CognitiveTraitId, TraitTrend>> = {
    pressure_dependency: trendForSeries(history.map(h => h.pressureDependency), 'lower_is_better'),
    voluntary_start_rate: trendForSeries(history.map(h => h.voluntaryStartRate), 'higher_is_better'),
    activation_energy: trendForSeries(history.map(h => h.activationEnergyDays), 'lower_is_better'),
    avoidance_age: trendForSeries(history.map(h => h.avoidanceAgeDays), 'lower_is_better'),
    crisis_performance_bonus: trendForSeries(history.map(h => h.crisisBonus), 'neutral'),
  };

  return traits.map(trait => {
    const trend = trendById[trait.id] ?? 'unknown';
    if (trend === 'unknown' || trend === trait.trend) return { ...trait, trend };
    const evidence = [...trait.evidence];
    if (trend === 'improving') {
      evidence.push({ label: 'trend', detail: 'Multi-day history suggests this wiring metric is improving.' });
    } else if (trend === 'worsening') {
      evidence.push({ label: 'trend', detail: 'Multi-day history suggests this wiring metric is drifting worse.' });
    }
    return { ...trait, trend, evidence: evidence.slice(0, 6) };
  });
}

function recordHistoryPoint(bundle: {
  pressureProfile: CognitiveTraitBundle['pressureProfile'];
}): CognitiveTraitHistoryPoint[] {
  const history = getCognitiveTraitHistory(60);
  const today = todayDateIst();
  const point: CognitiveTraitHistoryPoint = {
    date: today,
    pressureDependency: bundle.pressureProfile.pressureDependency,
    voluntaryStartRate: bundle.pressureProfile.voluntaryStartRate,
    activationEnergyDays: bundle.pressureProfile.activationEnergyDays,
    crisisBonus: bundle.pressureProfile.crisisBonus,
    avoidanceAgeDays: bundle.pressureProfile.avoidanceAgeDays,
    confidence: bundle.pressureProfile.confidence,
  };

  const withoutToday = history.filter(h => h.date !== today);
  const next = [...withoutToday, point];
  saveCognitiveTraitHistory(next);
  return next;
}

const NEAR_DEADLINE_DAYS = 2;
const FAR_DEADLINE_DAYS = 7;
const VOLUNTARY_HORIZON_DAYS = 3;
const MIN_SAMPLES_FOR_CLAIM = 4;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function confidenceFromSamples(n: number, base = 0.28, cap = 0.9): number {
  if (n <= 0) return 0;
  return Number(clamp(base + Math.log1p(n) * 0.18, 0.12, cap).toFixed(2));
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface LinkedSessionRow {
  task_id: number;
  title: string;
  due_date: string | null;
  task_type: string | null;
  created_at: string | null;
  session_id: string;
  credited_minutes: number;
  focus_score: number | null;
  credited_at: string;
  days_until_due: number | null;
  days_since_create: number | null;
  days_overdue_at_credit: number | null;
}

function loadLinkedSessions(windowDays: number): LinkedSessionRow[] {
  try {
    return getDb().prepare(`
      SELECT
        t.id as task_id,
        t.title,
        t.due_date,
        t.task_type,
        t.created_at,
        l.session_id,
        l.credited_minutes,
        l.focus_score,
        l.credited_at,
        CASE
          WHEN t.due_date IS NULL OR t.due_date = '' THEN NULL
          ELSE CAST(julianday(date(t.due_date)) - julianday(date(l.credited_at)) AS REAL)
        END as days_until_due,
        CASE
          WHEN t.created_at IS NULL THEN NULL
          ELSE CAST(julianday(date(l.credited_at)) - julianday(date(t.created_at)) AS REAL)
        END as days_since_create,
        CASE
          WHEN t.due_date IS NULL OR t.due_date = '' THEN NULL
          WHEN julianday(date(l.credited_at)) > julianday(date(t.due_date))
            THEN CAST(julianday(date(l.credited_at)) - julianday(date(t.due_date)) AS REAL)
          ELSE 0
        END as days_overdue_at_credit
      FROM task_session_logs l
      JOIN tasks t ON t.id = l.task_id
      WHERE l.credited_at >= datetime('now', ?)
      ORDER BY l.credited_at ASC
    `).all(`-${windowDays} days`) as LinkedSessionRow[];
  } catch {
    return [];
  }
}

interface FirstProgressRow {
  task_id: number;
  title: string;
  due_date: string | null;
  task_type: string | null;
  first_credit: string;
  days_until_due: number | null;
  days_since_create: number | null;
  days_overdue: number | null;
  first_focus: number | null;
}

function loadFirstProgress(windowDays: number): FirstProgressRow[] {
  try {
    return getDb().prepare(`
      SELECT
        t.id as task_id,
        t.title,
        t.due_date,
        t.task_type,
        MIN(l.credited_at) as first_credit,
        CASE
          WHEN t.due_date IS NULL OR t.due_date = '' THEN NULL
          ELSE CAST(julianday(date(t.due_date)) - julianday(date(MIN(l.credited_at))) AS REAL)
        END as days_until_due,
        CASE
          WHEN t.created_at IS NULL THEN NULL
          ELSE CAST(julianday(date(MIN(l.credited_at))) - julianday(date(t.created_at)) AS REAL)
        END as days_since_create,
        CASE
          WHEN t.due_date IS NULL OR t.due_date = '' THEN NULL
          WHEN julianday(date(MIN(l.credited_at))) > julianday(date(t.due_date))
            THEN CAST(julianday(date(MIN(l.credited_at))) - julianday(date(t.due_date)) AS REAL)
          ELSE 0
        END as days_overdue,
        (
          SELECT l2.focus_score FROM task_session_logs l2
          WHERE l2.task_id = t.id
          ORDER BY l2.credited_at ASC
          LIMIT 1
        ) as first_focus
      FROM tasks t
      JOIN task_session_logs l ON l.task_id = t.id
      WHERE l.credited_at >= datetime('now', ?)
      GROUP BY t.id
      ORDER BY first_credit ASC
    `).all(`-${windowDays} days`) as FirstProgressRow[];
  } catch {
    return [];
  }
}

function bandLabel(daysUntilDue: number | null): 'near' | 'mid' | 'far' | 'none' {
  if (daysUntilDue == null) return 'none';
  if (daysUntilDue <= NEAR_DEADLINE_DAYS) return 'near';
  if (daysUntilDue <= FAR_DEADLINE_DAYS) return 'mid';
  return 'far';
}

function computePressureDependency(firstProgress: FirstProgressRow[], linked: LinkedSessionRow[]): CognitiveTrait {
  const dated = firstProgress.filter(row => row.days_until_due != null);
  const sampleSize = dated.length;

  if (sampleSize === 0) {
    return {
      id: 'pressure_dependency',
      label: 'Pressure Dependency Index',
      valueLabel: 'Not enough deadline-linked work yet',
      value: null,
      unit: '0-1 index',
      confidence: 0,
      trend: 'unknown',
      evidence: [{
        label: 'sparse_data',
        detail: 'Need tasks with due dates and linked focus sessions to estimate pressure dependency.',
      }],
      userStance: 'observed',
      sampleSize: 0,
      updatedAt: nowIso(),
    };
  }

  const nearStarts = dated.filter(row => bandLabel(row.days_until_due) === 'near').length;
  const farStarts = dated.filter(row => bandLabel(row.days_until_due) === 'far').length;
  const midStarts = dated.filter(row => bandLabel(row.days_until_due) === 'mid').length;

  const nearShare = nearStarts / sampleSize;
  const farShare = farStarts / sampleSize;
  // 0 = starts far from deadlines; 1 = almost only starts under near-deadline pressure
  const pdi = clamp((nearShare - farShare + 1) / 2);

  const nearMinutes = linked
    .filter(row => bandLabel(row.days_until_due) === 'near')
    .reduce((sum, row) => sum + Number(row.credited_minutes || 0), 0);
  const totalMinutes = linked
    .filter(row => row.days_until_due != null)
    .reduce((sum, row) => sum + Number(row.credited_minutes || 0), 0);
  const nearMinuteShare = totalMinutes > 0 ? nearMinutes / totalMinutes : nearShare;

  // Blend start-rate PDI with minute concentration near deadlines
  const blended = clamp(pdi * 0.65 + nearMinuteShare * 0.35);

  const examples = dated
    .filter(row => bandLabel(row.days_until_due) === 'near')
    .slice(0, 3)
    .map(row => ({
      label: row.title,
      detail: `First focus ${Math.round(Number(row.days_until_due))}d before due`,
      at: row.first_credit,
    }));

  if (examples.length === 0) {
    examples.push(...dated.slice(0, 2).map(row => ({
      label: row.title,
      detail: `First focus at ${Math.round(Number(row.days_until_due))}d until due`,
      at: row.first_credit,
    })));
  }

  const valueLabel = blended >= 0.7
    ? `High (${Math.round(blended * 100)}/100) — starts cluster near deadlines`
    : blended >= 0.45
      ? `Moderate (${Math.round(blended * 100)}/100) — mixed early and late starts`
      : `Low (${Math.round(blended * 100)}/100) — often starts with lead time`;

  return {
    id: 'pressure_dependency',
    label: 'Pressure Dependency Index',
    valueLabel,
    value: Number(blended.toFixed(3)),
    unit: '0-1 index',
    confidence: confidenceFromSamples(sampleSize, sampleSize >= MIN_SAMPLES_FOR_CLAIM ? 0.4 : 0.22),
    trend: 'unknown',
    evidence: [
      {
        label: 'start_bands',
        detail: `${nearStarts} near (≤${NEAR_DEADLINE_DAYS}d), ${midStarts} mid, ${farStarts} far (≥${FAR_DEADLINE_DAYS}d) of ${sampleSize} deadline-linked first starts`,
      },
      {
        label: 'near_minute_share',
        detail: `${Math.round(nearMinuteShare * 100)}% of deadline-linked focus minutes landed within ${NEAR_DEADLINE_DAYS}d of due`,
      },
      ...examples,
    ],
    userStance: 'observed',
    sampleSize,
    updatedAt: nowIso(),
  };
}

function computeVoluntaryStartRate(linked: LinkedSessionRow[]): CognitiveTrait {
  const sampleSize = linked.length;
  if (sampleSize === 0) {
    return {
      id: 'voluntary_start_rate',
      label: 'Voluntary Start Rate',
      valueLabel: 'Not enough linked focus sessions yet',
      value: null,
      unit: 'rate',
      confidence: 0,
      trend: 'unknown',
      evidence: [{
        label: 'sparse_data',
        detail: 'Need focus sessions credited to tasks to measure voluntary (non-crisis) starts.',
      }],
      userStance: 'observed',
      sampleSize: 0,
      updatedAt: nowIso(),
    };
  }

  const voluntary = linked.filter(row => {
    if (row.days_until_due == null) return true;
    return Number(row.days_until_due) > VOLUNTARY_HORIZON_DAYS;
  });
  const rate = voluntary.length / sampleSize;

  const examples = voluntary.slice(0, 3).map(row => ({
    label: row.title,
    detail: row.days_until_due == null
      ? 'No due date — counted as voluntary'
      : `Started ${Math.round(Number(row.days_until_due))}d before due`,
    at: row.credited_at,
  }));

  const valueLabel = rate >= 0.55
    ? `Strong (${Math.round(rate * 100)}%) — many non-crisis starts`
    : rate >= 0.3
      ? `Developing (${Math.round(rate * 100)}%) — some work starts without near deadline`
      : `Low (${Math.round(rate * 100)}%) — most starts sit inside crisis windows`;

  return {
    id: 'voluntary_start_rate',
    label: 'Voluntary Start Rate',
    valueLabel,
    value: Number(rate.toFixed(3)),
    unit: 'rate',
    confidence: confidenceFromSamples(sampleSize, sampleSize >= MIN_SAMPLES_FOR_CLAIM ? 0.42 : 0.24),
    trend: 'unknown',
    evidence: [
      {
        label: 'definition',
        detail: `Voluntary = session with no due date, or more than ${VOLUNTARY_HORIZON_DAYS} days until due`,
      },
      {
        label: 'counts',
        detail: `${voluntary.length}/${sampleSize} linked sessions counted as voluntary`,
      },
      ...examples,
    ],
    userStance: 'observed',
    sampleSize,
    updatedAt: nowIso(),
  };
}

function computeActivationEnergy(firstProgress: FirstProgressRow[]): CognitiveTrait {
  const lags = firstProgress
    .map(row => row.days_since_create)
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  const sampleSize = lags.length;

  if (sampleSize === 0) {
    return {
      id: 'activation_energy',
      label: 'Activation Energy',
      valueLabel: 'Not enough task→session lag data yet',
      value: null,
      unit: 'days',
      confidence: 0,
      trend: 'unknown',
      evidence: [{
        label: 'sparse_data',
        detail: 'Need task create timestamps and first linked focus credits.',
      }],
      userStance: 'observed',
      sampleSize: 0,
      updatedAt: nowIso(),
    };
  }

  const meanLag = avg(lags) ?? 0;
  const slow = firstProgress
    .filter(row => row.days_since_create != null && Number(row.days_since_create) >= meanLag)
    .slice(0, 3)
    .map(row => ({
      label: row.title,
      detail: `First focus ${Math.round(Number(row.days_since_create))}d after create`,
      at: row.first_credit,
    }));

  const valueLabel = meanLag <= 1
    ? `Low (${meanLag.toFixed(1)}d) — you tend to start soon after creating work`
    : meanLag <= 4
      ? `Medium (${meanLag.toFixed(1)}d) — moderate lag from create to first focus`
      : `High (${meanLag.toFixed(1)}d) — work often sits before first real start`;

  return {
    id: 'activation_energy',
    label: 'Activation Energy',
    valueLabel,
    value: Number(meanLag.toFixed(2)),
    unit: 'days',
    confidence: confidenceFromSamples(sampleSize, 0.3),
    trend: 'unknown',
    evidence: [
      {
        label: 'mean_lag',
        detail: `Average ${meanLag.toFixed(1)} days from task create to first linked focus session (n=${sampleSize})`,
      },
      ...slow,
    ],
    userStance: 'observed',
    sampleSize,
    updatedAt: nowIso(),
  };
}

function computeAvoidanceAge(firstProgress: FirstProgressRow[]): CognitiveTrait {
  const overdueStarts = firstProgress.filter(row => row.days_overdue != null && Number(row.days_overdue) > 0);
  const sampleSize = overdueStarts.length;
  const datedTasks = firstProgress.filter(row => row.due_date).length;

  if (sampleSize === 0) {
    return {
      id: 'avoidance_age',
      label: 'Avoidance Signature (overdue start age)',
      valueLabel: datedTasks === 0
        ? 'No deadline tasks with progress yet'
        : 'No overdue-first-starts observed in window',
      value: sampleSize === 0 && datedTasks > 0 ? 0 : null,
      unit: 'days overdue',
      confidence: datedTasks > 0 ? confidenceFromSamples(datedTasks, 0.25, 0.7) : 0,
      trend: 'unknown',
      evidence: [{
        label: 'observation',
        detail: datedTasks > 0
          ? `${datedTasks} deadline-linked tasks started on time or early in the window.`
          : 'Need deadline tasks that receive focus after going overdue.',
      }],
      userStance: 'observed',
      sampleSize: datedTasks,
      updatedAt: nowIso(),
    };
  }

  const meanOverdue = avg(overdueStarts.map(row => Number(row.days_overdue))) ?? 0;
  const byType = new Map<string, number[]>();
  for (const row of overdueStarts) {
    const key = (row.task_type || 'task').toLowerCase();
    const list = byType.get(key) ?? [];
    list.push(Number(row.days_overdue));
    byType.set(key, list);
  }
  const typeSummary = Array.from(byType.entries())
    .map(([type, values]) => `${type}: ${avg(values)?.toFixed(1)}d avg`)
    .slice(0, 4)
    .join(' · ');

  const examples = overdueStarts
    .sort((a, b) => Number(b.days_overdue) - Number(a.days_overdue))
    .slice(0, 3)
    .map(row => ({
      label: row.title,
      detail: `First focus ${Math.round(Number(row.days_overdue))}d overdue`,
      at: row.first_credit,
    }));

  return {
    id: 'avoidance_age',
    label: 'Avoidance Signature (overdue start age)',
    valueLabel: `When work goes late, first focus averages ${meanOverdue.toFixed(1)}d overdue`,
    value: Number(meanOverdue.toFixed(2)),
    unit: 'days overdue',
    confidence: confidenceFromSamples(sampleSize, 0.32),
    trend: 'unknown',
    evidence: [
      {
        label: 'overdue_starts',
        detail: `${sampleSize} tasks first touched after due date; mean lag ${meanOverdue.toFixed(1)}d`,
      },
      ...(typeSummary ? [{ label: 'by_type', detail: typeSummary }] : []),
      ...examples,
    ],
    userStance: 'observed',
    sampleSize,
    updatedAt: nowIso(),
  };
}

function computeCrisisBonus(linked: LinkedSessionRow[]): CognitiveTrait {
  const withFocus = linked.filter(row => row.focus_score != null && Number.isFinite(Number(row.focus_score)));
  const crisis = withFocus.filter(row => bandLabel(row.days_until_due) === 'near' || (row.days_until_due != null && Number(row.days_until_due) < 0));
  const calm = withFocus.filter(row => bandLabel(row.days_until_due) === 'far' || row.days_until_due == null);

  if (crisis.length < 2 || calm.length < 2) {
    return {
      id: 'crisis_performance_bonus',
      label: 'Crisis Performance Bonus',
      valueLabel: 'Need both crisis and calm sessions to compare quality',
      value: null,
      unit: 'focus pts',
      confidence: confidenceFromSamples(withFocus.length, 0.15, 0.55),
      trend: 'unknown',
      evidence: [{
        label: 'sparse_data',
        detail: `Have ${crisis.length} crisis-window sessions and ${calm.length} calm-window sessions with focus scores.`,
      }],
      userStance: 'observed',
      sampleSize: withFocus.length,
      updatedAt: nowIso(),
    };
  }

  const crisisAvg = avg(crisis.map(row => Number(row.focus_score))) ?? 0;
  const calmAvg = avg(calm.map(row => Number(row.focus_score))) ?? 0;
  const delta = crisisAvg - calmAvg;

  const valueLabel = delta >= 8
    ? `+${delta.toFixed(1)} focus pts under near-deadline pressure — crisis quality is higher`
    : delta <= -8
      ? `${delta.toFixed(1)} focus pts under pressure — calm work is cleaner`
      : `~${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts — pressure does not strongly change quality`;

  return {
    id: 'crisis_performance_bonus',
    label: 'Crisis Performance Bonus',
    valueLabel,
    value: Number(delta.toFixed(2)),
    unit: 'focus pts',
    confidence: confidenceFromSamples(Math.min(crisis.length, calm.length), 0.35),
    trend: 'unknown',
    evidence: [
      {
        label: 'crisis_avg',
        detail: `Near-deadline / overdue sessions avg focus ${crisisAvg.toFixed(1)} (n=${crisis.length})`,
      },
      {
        label: 'calm_avg',
        detail: `Calm / no-near-deadline sessions avg focus ${calmAvg.toFixed(1)} (n=${calm.length})`,
      },
      ...crisis.slice(0, 2).map(row => ({
        label: row.title,
        detail: `Crisis session focus ${Math.round(Number(row.focus_score))}`,
        at: row.credited_at,
      })),
    ],
    userStance: 'observed',
    sampleSize: withFocus.length,
    updatedAt: nowIso(),
  };
}

function buildSummary(traits: CognitiveTrait[]): string {
  const pdi = traits.find(t => t.id === 'pressure_dependency');
  const voluntary = traits.find(t => t.id === 'voluntary_start_rate');
  const activation = traits.find(t => t.id === 'activation_energy');
  const crisis = traits.find(t => t.id === 'crisis_performance_bonus');

  const parts: string[] = [];

  if (pdi?.value != null && pdi.confidence >= 0.3) {
    if (pdi.value >= 0.7) {
      parts.push('Your starts concentrate under deadline pressure — crisis is currently a major activation fuel.');
    } else if (pdi.value >= 0.45) {
      parts.push('You mix early work with late pressure bursts; pressure still matters but is not the only start trigger.');
    } else {
      parts.push('You often start with lead time rather than only under deadline heat.');
    }
  }

  if (voluntary?.value != null && voluntary.confidence >= 0.3) {
    parts.push(`Voluntary (non-crisis) start rate is ${Math.round(voluntary.value * 100)}%.`);
  }

  if (activation?.value != null && activation.confidence >= 0.3) {
    parts.push(`Average create→first-focus lag is ${activation.value.toFixed(1)} days.`);
  }

  if (crisis?.value != null && crisis.confidence >= 0.3) {
    if (crisis.value >= 8) {
      parts.push('Focus quality rises in the crisis window — late intensity is real, not only volume.');
    } else if (crisis.value <= -8) {
      parts.push('Calm windows produce cleaner focus than crisis windows.');
    }
  }

  if (parts.length === 0) {
    return 'Cognitive traits are still cold-starting. Link focus sessions to deadline tasks and the pressure map will fill in.';
  }

  parts.push('This is wiring, not a moral judgment — measure it, then rewire with light experiments.');
  return parts.join(' ');
}

export function getTraitStances(): TraitStanceMap {
  try {
    const raw = getSetting(STANCES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TraitStanceMap;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveTraitStances(map: TraitStanceMap): void {
  setSetting(STANCES_KEY, JSON.stringify(map));
}

function findCognitiveFact(traitId: CognitiveTraitId) {
  try {
    return getDb().prepare(`
      SELECT id, content, confidence, status, confirmed_count
      FROM mem_facts
      WHERE topic = ?
        AND source = 'cognitive_self_map'
        AND status != 'superseded'
      ORDER BY last_confirmed DESC, id DESC
      LIMIT 1
    `).get(factTopicForTrait(traitId)) as
      | { id: number; content: string; confidence: number; status: string; confirmed_count: number }
      | undefined;
  } catch {
    return undefined;
  }
}

function applyStances(traits: CognitiveTrait[], stances: TraitStanceMap): CognitiveTrait[] {
  return traits.map(trait => {
    const record = stances[trait.id];
    if (!record) return trait;

    let confidence = trait.confidence;
    const evidence = [...trait.evidence];

    if (record.stance === 'confirmed') {
      confidence = Number(clamp(Math.max(confidence, 0.72) + 0.08, 0.12, 0.97).toFixed(2));
      evidence.unshift({
        label: 'user_confirmed',
        detail: record.note
          ? `You confirmed this: ${record.note}`
          : 'You confirmed this as accurate for how you work.',
        at: record.updatedAt,
      });
    } else if (record.stance === 'disputed') {
      confidence = Number(clamp(confidence * 0.35, 0.05, 0.4).toFixed(2));
      evidence.unshift({
        label: 'user_disputed',
        detail: record.note
          ? `You disputed this: ${record.note}`
          : 'You disputed this claim — treat it as weak until more evidence lands.',
        at: record.updatedAt,
      });
    } else if (record.stance === 'aspirational') {
      evidence.unshift({
        label: 'user_aspiration',
        detail: record.note
          ? `Aspiration: ${record.note}`
          : 'You marked this as something you want to change.',
        at: record.updatedAt,
      });
    }

    return {
      ...trait,
      userStance: record.stance,
      confidence,
      evidence: evidence.slice(0, 6),
      updatedAt: record.updatedAt || trait.updatedAt,
    };
  });
}

function buildHypotheses(traits: CognitiveTrait[]): CognitiveHypothesis[] {
  const hyps: CognitiveHypothesis[] = [];

  for (const trait of traits) {
    if (trait.confidence <= 0 && trait.value == null) continue;
    if (trait.userStance === 'confirmed' || trait.userStance === 'disputed') continue;

    if (trait.id === 'pressure_dependency' && trait.value != null && trait.value >= 0.55) {
      hyps.push({
        id: 'hyp_pressure_dependency_high',
        traitId: trait.id,
        claim: 'You mostly activate serious work when a deadline is close.',
        why: trait.valueLabel,
        confidence: trait.confidence,
        evidence: trait.evidence.map(e => e.detail).slice(0, 3),
        stance: trait.userStance,
        actionHint: 'Confirm if this matches you, or dispute if the data is wrong. Aspiration = “I want fewer crisis-only starts.”',
      });
    }

    if (trait.id === 'voluntary_start_rate' && trait.value != null && trait.value < 0.4) {
      hyps.push({
        id: 'hyp_low_voluntary_starts',
        traitId: trait.id,
        claim: 'Non-crisis (voluntary) deep starts are still rare for you.',
        why: trait.valueLabel,
        confidence: trait.confidence,
        evidence: trait.evidence.map(e => e.detail).slice(0, 3),
        stance: trait.userStance,
        actionHint: 'This is the main rewiring metric. Mark aspirational if you want LifeOS to help raise it.',
      });
    }

    if (trait.id === 'activation_energy' && trait.value != null && trait.value >= 4) {
      hyps.push({
        id: 'hyp_high_activation_energy',
        traitId: trait.id,
        claim: 'Work often sits for days between create and first real focus.',
        why: trait.valueLabel,
        confidence: trait.confidence,
        evidence: trait.evidence.map(e => e.detail).slice(0, 3),
        stance: trait.userStance,
        actionHint: 'Short activation blocks and synthetic early deadlines help here once you trust the map.',
      });
    }

    if (trait.id === 'crisis_performance_bonus' && trait.value != null && trait.value >= 8) {
      hyps.push({
        id: 'hyp_crisis_quality_bonus',
        traitId: trait.id,
        claim: 'Near-deadline pressure does not just force starts — focus quality also rises.',
        why: trait.valueLabel,
        confidence: trait.confidence,
        evidence: trait.evidence.map(e => e.detail).slice(0, 3),
        stance: trait.userStance,
        actionHint: 'Treat crisis performance as a skill with a cost, not a failure. Build calm alternatives beside it.',
      });
    }
  }

  return hyps.slice(0, 4);
}

/**
 * Compute the deterministic Cognitive Operating Model traits for the user.
 */
export function computeCognitiveTraits(options?: { windowDays?: number }): CognitiveTraitBundle {
  const windowDays = options?.windowDays ?? 45;
  const linked = loadLinkedSessions(windowDays);
  const firstProgress = loadFirstProgress(windowDays);

  const rawTraits = [
    computePressureDependency(firstProgress, linked),
    computeVoluntaryStartRate(linked),
    computeActivationEnergy(firstProgress),
    computeAvoidanceAge(firstProgress),
    computeCrisisBonus(linked),
  ];

  const stances = getTraitStances();
  let traits = applyStances(rawTraits, stances);

  const confidences = traits.map(t => t.confidence).filter(c => c > 0);
  const overallConfidence = confidences.length
    ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2))
    : 0;

  const byId = Object.fromEntries(traits.map(t => [t.id, t])) as Record<CognitiveTraitId, CognitiveTrait>;
  const pressureProfile = {
    pressureDependency: byId.pressure_dependency.value,
    voluntaryStartRate: byId.voluntary_start_rate.value,
    crisisBonus: byId.crisis_performance_bonus.value,
    activationEnergyDays: byId.activation_energy.value,
    avoidanceAgeDays: byId.avoidance_age.value,
    confidence: overallConfidence,
  };

  // Persist at most one point per day so trends are stable
  const history = recordHistoryPoint({ pressureProfile });
  traits = applyHistoryTrends(traits, history);

  return {
    generatedAt: nowIso(),
    windowDays,
    traits,
    summary: buildSummary(traits),
    hypotheses: buildHypotheses(traits),
    history: history.slice(-42),
    pressureProfile,
  };
}

/**
 * Pick a direct weekly question about the unresolved cognitive wiring pattern.
 */
export function selectWeeklyCognitiveQuestion(bundle?: CognitiveTraitBundle): string | null {
  const traits = bundle ?? computeCognitiveTraits({ windowDays: 45 });
  const pdi = traits.traits.find(t => t.id === 'pressure_dependency');
  const voluntary = traits.traits.find(t => t.id === 'voluntary_start_rate');
  const activation = traits.traits.find(t => t.id === 'activation_energy');
  const aspirational = traits.traits.find(t => t.userStance === 'aspirational');

  if (aspirational) {
    return `You marked "${aspirational.label}" as something you want to change. What is one non-crisis start you will protect next week, and when will it happen?`;
  }
  if (pdi?.value != null && pdi.value >= 0.6 && pdi.userStance !== 'disputed') {
    return 'Which important task this week only got real attention because a deadline forced it — and what would make an earlier start possible without manufacturing crisis?';
  }
  if (voluntary?.value != null && voluntary.value < 0.35) {
    return 'When did you last start deep work with no near deadline, and what blocked that kind of start more often this week?';
  }
  if (activation?.value != null && activation.value >= 5) {
    return `Work is sitting ~${activation.value.toFixed(1)} days before first focus. Which open task will you start with a 15-minute activation block tomorrow?`;
  }
  if (pdi?.trend === 'worsening' || voluntary?.trend === 'worsening') {
    return 'Your pressure-dependency wiring looks worse than recent weeks. What specifically drifted — scheduling, avoidance, or true external deadlines?';
  }
  return null;
}

function buildStanceFactContent(
  trait: CognitiveTrait,
  stance: TraitStance,
  note?: string,
): { category: 'identity' | 'pattern' | 'goal'; content: string; importance: number; confidence: number } {
  const base = `${trait.label}: ${trait.valueLabel}`;
  if (stance === 'confirmed') {
    return {
      category: 'identity',
      content: `User-confirmed cognitive trait — ${base}.${note ? ` Note: ${note}` : ''} Use this when explaining how/why/when their brain works. Do not moralize crisis productivity.`,
      importance: 0.9,
      confidence: Math.max(0.8, trait.confidence),
    };
  }
  if (stance === 'disputed') {
    return {
      category: 'pattern',
      content: `User disputed cognitive claim — ${base}.${note ? ` Note: ${note}` : ''} Do not assert this as settled identity; prefer newer evidence.`,
      importance: 0.7,
      confidence: 0.55,
    };
  }
  if (stance === 'aspirational') {
    return {
      category: 'goal',
      content: `User aspiration on cognitive trait — currently ${base}. Desired change: ${note || 'reduce pressure-only activation and raise voluntary starts'}. Prefer coaching and planning that supports rewiring without fighting true deadline days.`,
      importance: 0.85,
      confidence: 0.75,
    };
  }
  return {
    category: 'pattern',
    content: `Observed cognitive trait — ${base}`,
    importance: 0.5,
    confidence: trait.confidence,
  };
}

/**
 * Record user stance on a cognitive trait and promote/demote memory facts.
 */
export function setCognitiveTraitStance(input: {
  traitId: string;
  stance: string;
  note?: string;
}): {
  ok: true;
  traitId: CognitiveTraitId;
  stance: TraitStance;
  trait: CognitiveTrait;
  factId: number | null;
  bundle: CognitiveTraitBundle;
} {
  if (!VALID_TRAIT_IDS.includes(input.traitId as CognitiveTraitId)) {
    throw new Error(`Unknown traitId: ${input.traitId}`);
  }
  if (!VALID_STANCES.includes(input.stance as TraitStance)) {
    throw new Error(`Unknown stance: ${input.stance}`);
  }

  const traitId = input.traitId as CognitiveTraitId;
  const stance = input.stance as TraitStance;
  const note = input.note?.trim() || undefined;
  const updatedAt = nowIso();

  const map = getTraitStances();
  if (stance === 'observed') {
    delete map[traitId];
  } else {
    map[traitId] = { stance, note, updatedAt };
  }
  saveTraitStances(map);

  const bundle = computeCognitiveTraits({ windowDays: 45 });
  const trait = bundle.traits.find(t => t.id === traitId);
  if (!trait) {
    throw new Error(`Trait not available: ${traitId}`);
  }

  let factId: number | null = null;
  if (stance !== 'observed') {
    const fact = buildStanceFactContent(trait, stance, note);
    const existing = findCognitiveFact(traitId);
    if (existing) {
      updateFact(existing.id, {
        content: fact.content,
        confidence: fact.confidence,
        importance: fact.importance,
        status: 'active',
      });
      // Keep category on existing row; content carries stance semantics
      getDb().prepare(`
        UPDATE mem_facts
        SET category = ?, source = 'cognitive_self_map', topic = ?
        WHERE id = ?
      `).run(fact.category, factTopicForTrait(traitId), existing.id);
      factId = existing.id;
    } else {
      factId = insertFact({
        category: fact.category,
        topic: factTopicForTrait(traitId),
        content: fact.content,
        confidence: fact.confidence,
        importance: fact.importance,
        source: 'cognitive_self_map',
        status: 'active',
      });
    }
  }

  return {
    ok: true,
    traitId,
    stance,
    trait,
    factId,
    bundle: computeCognitiveTraits({ windowDays: 45 }),
  };
}

export function formatCognitiveTraitsForPrompt(bundle: CognitiveTraitBundle, maxTraits = 5): string {
  if (!bundle.traits.length) return '';
  const lines = [
    `=== COGNITIVE SELF-MAP (${bundle.windowDays}d window, confidence ${bundle.pressureProfile.confidence}) ===`,
    bundle.summary,
  ];

  const confirmed = bundle.traits.filter(t => t.userStance === 'confirmed');
  const disputed = bundle.traits.filter(t => t.userStance === 'disputed');
  const aspirational = bundle.traits.filter(t => t.userStance === 'aspirational');

  if (confirmed.length) {
    lines.push('User-confirmed wiring (treat as high-trust identity signal):');
    for (const trait of confirmed) {
      lines.push(`- CONFIRMED ${trait.label}: ${trait.valueLabel}`);
    }
  }
  if (disputed.length) {
    lines.push('User-disputed claims (do not assert as settled):');
    for (const trait of disputed) {
      lines.push(`- DISPUTED ${trait.label}: ${trait.valueLabel}`);
    }
  }
  if (aspirational.length) {
    lines.push('Aspirations (optimize toward these without fighting true deadline days):');
    for (const trait of aspirational) {
      lines.push(`- ASPIRE ${trait.label}: ${trait.valueLabel}`);
    }
  }

  for (const trait of bundle.traits.slice(0, maxTraits)) {
    if (trait.confidence <= 0 && trait.userStance === 'observed') continue;
    lines.push(
      `- ${trait.label}: ${trait.valueLabel} [conf ${trait.confidence}, n=${trait.sampleSize}, stance=${trait.userStance}]`,
    );
    for (const ev of trait.evidence.slice(0, 2)) {
      lines.push(`  · ${ev.detail}`);
    }
  }

  if (bundle.hypotheses.length) {
    lines.push('Open hypotheses (ask user to confirm/dispute when relevant):');
    for (const hyp of bundle.hypotheses.slice(0, 3)) {
      lines.push(`- ${hyp.claim} (conf ${hyp.confidence})`);
    }
  }

  return lines.join('\n');
}
