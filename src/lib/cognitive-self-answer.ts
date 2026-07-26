/**
 * Deterministic "how / why / when does my brain work" answers.
 * Uses Cognitive Self-Map evidence — no LLM required for the core answer.
 * LLM paths (chat/voice) should ground on this block instead of inventing patterns.
 */

import {
  computeCognitiveTraits,
  getCognitiveTraitHistory,
  type CognitiveTraitBundle,
  type CognitiveTraitHistoryPoint,
} from './cognitive-traits';
import {
  getActiveCoachPolicy,
  type ActiveCoachPolicy,
} from './cognitive-active-coach';
import { getCognitiveExperimentState } from './cognitive-experiments';

export type CognitiveQuestionFocus =
  | 'overview'
  | 'when'
  | 'why'
  | 'how'
  | 'pressure'
  | 'trajectory'
  | 'rewiring';

export interface CognitiveSelfAnswer {
  focus: CognitiveQuestionFocus;
  matched: boolean;
  title: string;
  summary: string;
  sections: Array<{ heading: string; body: string }>;
  evidence: string[];
  nextMove: string | null;
  confidence: number;
  plainText: string;
  markdown: string;
}

export interface CognitiveTrajectoryWeek {
  weekStart: string;
  weekEnd: string;
  sampleDays: number;
  avgPressureDependency: number | null;
  avgVoluntaryStartRate: number | null;
  avgActivationEnergyDays: number | null;
  pressureTrend: 'improving' | 'worsening' | 'stable' | 'unknown';
  voluntaryTrend: 'improving' | 'worsening' | 'stable' | 'unknown';
}

export interface CognitiveTrajectory {
  generatedAt: string;
  historyDays: number;
  points: CognitiveTraitHistoryPoint[];
  weeks: CognitiveTrajectoryWeek[];
  headline: string;
  enoughData: boolean;
}

const SELF_QUESTION_RE =
  /\b(why am i|why i am|how does my brain|how my brain|when does my brain|when do i work|when i work|pressure depend|only under deadline|only under pressure|procrastinat|activation energy|voluntary start|how am i wired|map my brain|cognitive map|self.?model|who am i as a worker|rewire?)\b/i;

export function isCognitiveSelfQuestion(query: string): boolean {
  return SELF_QUESTION_RE.test((query || '').trim());
}

export function detectCognitiveQuestionFocus(query: string): CognitiveQuestionFocus {
  const q = (query || '').toLowerCase();
  if (/\b(trajectory|trend|over time|week over week|improving|getting worse|history)\b/.test(q)) {
    return 'trajectory';
  }
  // Check rewiring before bare "how" — "how do I rewire…" is rewiring, not style.
  if (/\b(rewire|rewiring|change this|fix this|stop needing|without pressure|without deadlines?)\b/.test(q)) {
    return 'rewiring';
  }
  if (/\b(when|time of day|chronotype|morning|night|best window)\b/.test(q)) {
    return 'when';
  }
  if (/\b(why|because|reason|avoid|stall|procrastinat)\b/.test(q)) {
    return 'why';
  }
  if (/\b(how|session length|sprint|deep work|style)\b/.test(q)) {
    return 'how';
  }
  if (/\b(pressure|deadline|crisis|last minute)\b/.test(q)) {
    return 'pressure';
  }
  return 'overview';
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function trendFromPair(
  older: number | null,
  newer: number | null,
  direction: 'lower_is_better' | 'higher_is_better',
): CognitiveTrajectoryWeek['pressureTrend'] {
  if (older == null || newer == null) return 'unknown';
  const delta = newer - older;
  const threshold = Math.max(0.03, Math.abs(older) * 0.08);
  if (Math.abs(delta) < threshold) return 'stable';
  if (direction === 'lower_is_better') return delta < 0 ? 'improving' : 'worsening';
  return delta > 0 ? 'improving' : 'worsening';
}

function weekStartOf(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Multi-week trajectory from stored daily trait snapshots.
 * Requires multiple history points (from real days of use or seeded tests).
 */
export function getCognitiveTrajectory(options?: {
  historyLimit?: number;
}): CognitiveTrajectory {
  const points = getCognitiveTraitHistory(options?.historyLimit ?? 90);
  const byWeek = new Map<string, CognitiveTraitHistoryPoint[]>();
  for (const point of points) {
    const ws = weekStartOf(point.date);
    const list = byWeek.get(ws) ?? [];
    list.push(point);
    byWeek.set(ws, list);
  }

  const weekStarts = Array.from(byWeek.keys()).sort();
  const weeks: CognitiveTrajectoryWeek[] = weekStarts.map(ws => {
    const list = byWeek.get(ws) ?? [];
    return {
      weekStart: ws,
      weekEnd: addDays(ws, 6),
      sampleDays: list.length,
      avgPressureDependency: avg(list.map(p => p.pressureDependency)),
      avgVoluntaryStartRate: avg(list.map(p => p.voluntaryStartRate)),
      avgActivationEnergyDays: avg(list.map(p => p.activationEnergyDays)),
      pressureTrend: 'unknown',
      voluntaryTrend: 'unknown',
    };
  });

  for (let i = 0; i < weeks.length; i++) {
    const prev = i > 0 ? weeks[i - 1] : null;
    weeks[i].pressureTrend = trendFromPair(
      prev?.avgPressureDependency ?? null,
      weeks[i].avgPressureDependency,
      'lower_is_better',
    );
    weeks[i].voluntaryTrend = trendFromPair(
      prev?.avgVoluntaryStartRate ?? null,
      weeks[i].avgVoluntaryStartRate,
      'higher_is_better',
    );
  }

  const enoughData = points.length >= 3 && weeks.length >= 1;
  let headline = 'Not enough multi-day snapshots yet — keep linking focus sessions to tasks.';
  if (enoughData && weeks.length >= 2) {
    const last = weeks[weeks.length - 1];
    const parts: string[] = [];
    if (last.pressureTrend === 'improving') parts.push('pressure dependency easing');
    if (last.pressureTrend === 'worsening') parts.push('pressure dependency rising');
    if (last.voluntaryTrend === 'improving') parts.push('voluntary starts rising');
    if (last.voluntaryTrend === 'worsening') parts.push('voluntary starts falling');
    headline = parts.length
      ? `Across ${weeks.length} week(s): ${parts.join('; ')}.`
      : `Across ${weeks.length} week(s): wiring metrics look stable.`;
  } else if (enoughData) {
    headline = `${points.length} daily snapshots recorded — need another week for week-over-week trend.`;
  }

  return {
    generatedAt: new Date().toISOString(),
    historyDays: points.length,
    points,
    weeks,
    headline,
    enoughData,
  };
}

function traitLine(bundle: CognitiveTraitBundle, id: string): string | null {
  const t = bundle.traits.find(tr => tr.id === id);
  if (!t || (t.confidence <= 0 && t.value == null)) return null;
  return `${t.label}: ${t.valueLabel} (conf ${Math.round(t.confidence * 100)}%, stance ${t.userStance}${t.trend && t.trend !== 'unknown' ? `, trend ${t.trend}` : ''})`;
}

function collectEvidence(bundle: CognitiveTraitBundle, limit = 6): string[] {
  const out: string[] = [];
  for (const trait of bundle.traits) {
    for (const ev of trait.evidence) {
      if (ev.label === 'sparse_data') continue;
      out.push(`${trait.label}: ${ev.detail}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function nextMoveFromCoach(coach: ActiveCoachPolicy, bundle: CognitiveTraitBundle): string | null {
  if (!coach.mapTrust.trusted) {
    return 'Confirm or mark aspirational at least one Brain Map trait so active coach can rewire on normal days.';
  }
  if (coach.suppressRewiring) {
    return 'Today is deadline pressure — protect crisis performance; schedule a non-crisis activation block tomorrow.';
  }
  if (coach.activationBlocks) {
    return `Start a ${coach.preferredActivationMinutes ?? 15}-minute activation block on one important non-urgent task before opening optional tabs.`;
  }
  if (coach.earlyCommitmentBoost) {
    return 'Pick one non-urgent high-value task and give it an early synthetic commitment this week.';
  }
  const vol = bundle.traits.find(t => t.id === 'voluntary_start_rate');
  if (vol?.value != null && vol.value < 0.4) {
    return 'Log one voluntary (non-crisis) start this week and mark it so the map can learn.';
  }
  return null;
}

/**
 * Build a grounded answer for self-understanding questions.
 */
export function buildCognitiveSelfAnswer(
  query: string,
  options?: {
    bundle?: CognitiveTraitBundle;
    coach?: ActiveCoachPolicy;
    trajectory?: CognitiveTrajectory;
  },
): CognitiveSelfAnswer {
  const matched = isCognitiveSelfQuestion(query) || (query || '').trim().length === 0;
  const focus = detectCognitiveQuestionFocus(query || 'overview of my brain wiring');
  const bundle = options?.bundle ?? computeCognitiveTraits({ windowDays: 45 });
  const coach = options?.coach ?? getActiveCoachPolicy({ traits: bundle });
  const trajectory = options?.trajectory ?? getCognitiveTrajectory();
  const experiments = getCognitiveExperimentState();
  const evidence = collectEvidence(bundle, 8);
  const confidence = bundle.pressureProfile.confidence;

  const sections: CognitiveSelfAnswer['sections'] = [];
  let title = 'How your brain works (Cognitive Self-Map)';
  let summary = bundle.summary;

  if (focus === 'when') {
    title = 'When your brain works';
    const focusTrait = traitLine(bundle, 'activation_energy');
    sections.push({
      heading: 'Timing signal',
      body: focusTrait
        || 'Not enough create→first-focus lag data yet. Link sessions to tasks after you start them.',
    });
    sections.push({
      heading: 'What this means',
      body: '“When” here is about start latency and crisis windows, not only chronotype. Peak hours still live in UIL/Insights heatmaps; this map measures whether starts cluster near deadlines.',
    });
  } else if (focus === 'why') {
    title = 'Why you stall or surge';
    sections.push({
      heading: 'Drivers',
      body: [
        traitLine(bundle, 'pressure_dependency'),
        traitLine(bundle, 'avoidance_age'),
        traitLine(bundle, 'voluntary_start_rate'),
      ].filter(Boolean).join(' ') || 'Need more deadline-linked sessions to explain why.',
    });
    sections.push({
      heading: 'Interpretation',
      body: (bundle.pressureProfile.pressureDependency ?? 0) >= 0.55
        ? 'High pressure dependency means activation often waits for external heat — not laziness; measured start clustering.'
        : 'Pressure is not the dominant start trigger in the current window.',
    });
  } else if (focus === 'how') {
    title = 'How you work under load';
    sections.push({
      heading: 'Work style signals',
      body: [
        traitLine(bundle, 'crisis_performance_bonus'),
        traitLine(bundle, 'activation_energy'),
        traitLine(bundle, 'voluntary_start_rate'),
      ].filter(Boolean).join(' ') || 'Need more focus-scored linked sessions.',
    });
  } else if (focus === 'pressure') {
    title = 'Pressure dependency profile';
    sections.push({
      heading: 'PDI',
      body: traitLine(bundle, 'pressure_dependency') || 'Insufficient deadline-linked starts.',
    });
    sections.push({
      heading: 'Crisis quality',
      body: traitLine(bundle, 'crisis_performance_bonus') || 'Need both crisis and calm sessions to compare quality.',
    });
  } else if (focus === 'trajectory') {
    title = 'Trajectory over time';
    summary = trajectory.headline;
    sections.push({
      heading: 'Coverage',
      body: `${trajectory.historyDays} daily snapshot(s), ${trajectory.weeks.length} week bucket(s). ${trajectory.enoughData ? 'Enough for a first read.' : 'Still cold-starting.'}`,
    });
    if (trajectory.weeks.length) {
      const recent = trajectory.weeks.slice(-3);
      sections.push({
        heading: 'Recent weeks',
        body: recent.map(w => {
          const pdi = w.avgPressureDependency == null ? 'n/a' : Math.round(w.avgPressureDependency * 100);
          const vol = w.avgVoluntaryStartRate == null ? 'n/a' : `${Math.round(w.avgVoluntaryStartRate * 100)}%`;
          return `${w.weekStart}: PDI ${pdi}, voluntary ${vol} (${w.sampleDays}d, PDI ${w.pressureTrend}, vol ${w.voluntaryTrend})`;
        }).join(' · '),
      });
    }
  } else if (focus === 'rewiring') {
    title = 'Rewiring status';
    sections.push({
      heading: 'Active coach',
      body: coach.coachGuidance,
    });
    sections.push({
      heading: 'Experiments',
      body: experiments.active
        ? `Active light experiment: ${experiments.active.title} (${experiments.active.kind}).`
        : experiments.offered
          ? `Offered experiment waiting: ${experiments.offered.title}.`
          : 'No light experiment active. Accept one on Insights or let active coach auto-rewire after trust.',
    });
  } else {
    sections.push({
      heading: 'Map summary',
      body: bundle.summary,
    });
    sections.push({
      heading: 'Core traits',
      body: [
        traitLine(bundle, 'pressure_dependency'),
        traitLine(bundle, 'voluntary_start_rate'),
        traitLine(bundle, 'activation_energy'),
        traitLine(bundle, 'crisis_performance_bonus'),
      ].filter(Boolean).join('\n') || 'Traits still cold-starting.',
    });
    sections.push({
      heading: 'Trajectory',
      body: trajectory.headline,
    });
    sections.push({
      heading: 'Coach',
      body: coach.coachGuidance,
    });
  }

  const nextMove = nextMoveFromCoach(coach, bundle);
  const plainParts = [
    title,
    summary,
    ...sections.map(s => `${s.heading}: ${s.body}`),
    evidence.length ? `Evidence: ${evidence.slice(0, 4).join(' | ')}` : '',
    nextMove ? `Next move: ${nextMove}` : '',
  ].filter(Boolean);

  const markdown = [
    `### ${title}`,
    summary,
    '',
    ...sections.flatMap(s => [`**${s.heading}**`, s.body, '']),
    evidence.length ? `**Evidence**\n${evidence.slice(0, 5).map(e => `- ${e}`).join('\n')}` : '',
    nextMove ? `\n**Next move:** ${nextMove}` : '',
  ].filter(Boolean).join('\n');

  return {
    focus,
    matched,
    title,
    summary,
    sections,
    evidence: evidence.slice(0, 8),
    nextMove,
    confidence,
    plainText: plainParts.join('\n'),
    markdown,
  };
}

/** Compact block for LLM grounding (chat / voice deep analysis). */
export function formatCognitiveSelfAnswerForPrompt(query: string): string {
  const answer = buildCognitiveSelfAnswer(query);
  return [
    '=== GROUNDED COGNITIVE SELF-ANSWER (do not invent contradicting patterns) ===',
    answer.plainText,
    'If the user asks how/why/when their brain works, lead with this evidence. Never shame crisis productivity.',
  ].join('\n');
}
