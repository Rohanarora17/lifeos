import { getDb } from './db';
import type { PersonalizationSnapshot } from './personalization-context';
import type { UserIntelligenceProfile } from './intelligence';
import type { LearnedFeedbackFact } from './feedback-learning';
import {
  computeCognitiveTraits,
  type CognitiveTraitBundle,
} from './cognitive-traits';

export type SelfModelBeliefKind =
  | 'current_state'
  | 'focus_pattern'
  | 'work_preference'
  | 'feedback_preference'
  | 'constraint'
  | 'knowledge_gap'
  | 'reward_pattern'
  | 'cognitive_trait';

export interface SelfModelBelief {
  id: string;
  kind: SelfModelBeliefKind;
  label: string;
  value: string;
  confidence: number;
  evidence: string[];
  source: 'personalization_snapshot' | 'uil_profile' | 'memory' | 'feedback' | 'calibration' | 'activity' | 'cognitive_traits';
  updatedAt: string | null;
}

export interface SelfModelGap {
  id: string;
  label: string;
  reason: string;
  suggestedQuestion: string;
  priority: 'low' | 'medium' | 'high';
}

export interface SelfModelCoverage {
  semanticFacts: number;
  activeMemoryFacts: number;
  feedbackFacts: number;
  feedbackEvents30d: number;
  checkins14d: number;
  focusSessions30d: number;
  calibrationSessions: number;
  latestUilVersion: number;
}

export interface SelfModel {
  generatedAt: string;
  confidence: number;
  summary: string;
  beliefs: SelfModelBelief[];
  gaps: SelfModelGap[];
  coverage: SelfModelCoverage;
  /** Deterministic Cognitive Self-Map traits (Tier B) */
  cognitiveTraits: CognitiveTraitBundle;
}

export interface SelfModelGapQuestion {
  gapId: string;
  label: string;
  reason: string;
  question: string;
  priority: SelfModelGap['priority'];
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function getCount(sql: string, args: unknown[] = []): number {
  try {
    const row = getDb().prepare(sql).get(...args) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function recentFacts(limit = 12) {
  try {
    return getDb().prepare(`
      SELECT id, category, topic, content, confidence, importance, source,
             confirmed_count, last_confirmed, created_at
      FROM mem_facts
      WHERE status = 'active'
      ORDER BY importance DESC, confidence DESC, last_confirmed DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      category: string;
      topic: string;
      content: string;
      confidence: number;
      importance: number;
      source: string;
      confirmed_count: number;
      last_confirmed: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
}

function confidenceFromEvidence(base: number, evidenceCount: number, cap = 0.92): number {
  return clamp(Math.min(cap, base + Math.log1p(evidenceCount) * 0.12));
}

function addBelief(target: SelfModelBelief[], belief: SelfModelBelief): void {
  if (!belief.value.trim()) return;
  target.push({
    ...belief,
    confidence: Number(clamp(belief.confidence).toFixed(2)),
    evidence: belief.evidence.filter(Boolean).slice(0, 4),
  });
}

function buildCoverage(profile: UserIntelligenceProfile): SelfModelCoverage {
  return {
    semanticFacts: getCount(`SELECT COUNT(*) as c FROM mem_facts WHERE status != 'superseded'`),
    activeMemoryFacts: getCount(`SELECT COUNT(*) as c FROM mem_facts WHERE status = 'active'`),
    feedbackFacts: getCount(`SELECT COUNT(*) as c FROM mem_facts WHERE source = 'feedback_learning' AND status != 'superseded'`),
    feedbackEvents30d: getCount(`SELECT COUNT(*) as c FROM agent_action_outcomes WHERE created_at >= datetime('now', '-30 days') AND helpful IS NOT NULL`),
    checkins14d: getCount(`SELECT COUNT(*) as c FROM daily_checkins WHERE checkin_date >= date('now', '-14 days')`),
    focusSessions30d: getCount(`SELECT COUNT(*) as c FROM guardian_session_summaries WHERE COALESCE(completed_at, started_at) >= datetime('now', '-30 days')`),
    calibrationSessions: getCount(`SELECT COUNT(*) as c FROM session_feedback WHERE created_at >= datetime('now', '-45 days')`),
    latestUilVersion: profile.version,
  };
}

function deriveGaps(snapshot: PersonalizationSnapshot, coverage: SelfModelCoverage): SelfModelGap[] {
  const gaps: SelfModelGap[] = [];

  if (coverage.checkins14d < 6) {
    gaps.push({
      id: 'daily_checkins_sparse',
      label: 'Mood and sleep model is thin',
      reason: `Only ${coverage.checkins14d} check-ins in the last 14 days.`,
      suggestedQuestion: 'How did you sleep, what is your energy, and what is the one thing that would make tomorrow good?',
      priority: 'high',
    });
  }

  if (coverage.feedbackEvents30d < 5) {
    gaps.push({
      id: 'feedback_sparse',
      label: 'Preference learning needs more corrections',
      reason: `Only ${coverage.feedbackEvents30d} helpful/not-helpful events in the last 30 days.`,
      suggestedQuestion: 'Was this suggestion useful, badly timed, or just the wrong kind of help?',
      priority: 'high',
    });
  }

  if (coverage.focusSessions30d < 5) {
    gaps.push({
      id: 'focus_sessions_sparse',
      label: 'Session-length model needs more completed focus data',
      reason: `Only ${coverage.focusSessions30d} completed focus sessions in the last 30 days.`,
      suggestedQuestion: 'After this session, did the length feel too short, right, or too long?',
      priority: 'medium',
    });
  }

  if (!snapshot.userState.standupGoal) {
    gaps.push({
      id: 'today_anchor_missing',
      label: 'Today has no declared anchor',
      reason: 'The model is inferring priorities without a fresh stated intention.',
      suggestedQuestion: 'What do you want tomorrow to be about, and what would count as enough?',
      priority: 'medium',
    });
  }

  if (coverage.calibrationSessions < 3) {
    gaps.push({
      id: 'calibration_sparse',
      label: 'Focus-score calibration is early',
      reason: `Only ${coverage.calibrationSessions} recent session reflections are available.`,
      suggestedQuestion: 'Did the system overestimate or underestimate how focused you actually felt?',
      priority: 'medium',
    });
  }

  if (coverage.focusSessions30d >= 3 && coverage.focusSessions30d < 8) {
    gaps.push({
      id: 'pressure_map_thin',
      label: 'Pressure-dependency map needs more deadline-linked sessions',
      reason: 'Cognitive traits improve when focus sessions are linked to tasks with due dates.',
      suggestedQuestion: 'Which important tasks only get real attention when a deadline is close?',
      priority: 'medium',
    });
  }

  return gaps;
}

function addCognitiveTraitBeliefs(target: SelfModelBelief[], bundle: CognitiveTraitBundle): void {
  for (const trait of bundle.traits) {
    if (trait.confidence <= 0 && trait.value == null) continue;
    addBelief(target, {
      id: `cognitive_${trait.id}`,
      kind: 'cognitive_trait',
      label: trait.label,
      value: trait.valueLabel,
      confidence: trait.confidence,
      evidence: trait.evidence.map(ev => ev.detail).slice(0, 4),
      source: 'cognitive_traits',
      updatedAt: trait.updatedAt,
    });
  }
}

export function buildSelfModel(input: {
  snapshot: PersonalizationSnapshot;
  profile: UserIntelligenceProfile;
  feedbackFacts: LearnedFeedbackFact[];
  cognitiveTraits?: CognitiveTraitBundle;
}): SelfModel {
  const { snapshot, profile, feedbackFacts } = input;
  const coverage = buildCoverage(profile);
  const beliefs: SelfModelBelief[] = [];
  const facts = recentFacts(10);
  const cognitiveTraits = input.cognitiveTraits ?? computeCognitiveTraits({ windowDays: 45 });

  addCognitiveTraitBeliefs(beliefs, cognitiveTraits);

  addBelief(beliefs, {
    id: 'moment_mode',
    kind: 'current_state',
    label: 'Current operating mode',
    value: snapshot.moment.mode.replace(/_/g, ' '),
    confidence: confidenceFromEvidence(0.45, coverage.checkins14d + coverage.focusSessions30d),
    evidence: [
      snapshot.moment.guidance,
      `${snapshot.today.openTasks} open tasks, ${snapshot.today.overdueTasks} overdue`,
      `${snapshot.today.recentDistractionMinutes} recent distraction minutes`,
    ],
    source: 'personalization_snapshot',
    updatedAt: snapshot.generatedAt,
  });

  addBelief(beliefs, {
    id: 'energy_mood',
    kind: 'current_state',
    label: 'Current energy and mood',
    value: `${snapshot.userState.energy} energy${snapshot.userState.mood ? `, ${snapshot.userState.mood} mood` : ''}`,
    confidence: confidenceFromEvidence(snapshot.userState.mood ? 0.5 : 0.35, coverage.checkins14d, 0.86),
    evidence: [
      coverage.checkins14d ? `${coverage.checkins14d} recent check-ins` : 'No recent check-in baseline',
      profile.energyPattern,
    ],
    source: 'personalization_snapshot',
    updatedAt: snapshot.generatedAt,
  });

  addBelief(beliefs, {
    id: 'focus_window',
    kind: 'focus_pattern',
    label: 'Best focus timing',
    value: profile.nextBestFocusWindow || (profile.peakFocusHours.length ? `${profile.peakFocusHours.join(', ')}:00` : ''),
    confidence: confidenceFromEvidence(0.35, coverage.focusSessions30d, 0.88),
    evidence: [
      profile.peakFocusHours.length ? `Peak hours: ${profile.peakFocusHours.join(', ')}` : '',
      `Focus trend: ${profile.focusTrend}`,
      `${coverage.focusSessions30d} focus sessions in 30d`,
    ],
    source: 'uil_profile',
    updatedAt: profile.synthesizedAt ? new Date(profile.synthesizedAt).toISOString() : null,
  });

  addBelief(beliefs, {
    id: 'session_length',
    kind: 'focus_pattern',
    label: 'Session length sweet spot',
    value: `${profile.adaptiveThresholds.sessionDurationSweetSpot || profile.optimalSessionMinutes} minutes`,
    confidence: confidenceFromEvidence(0.34, coverage.focusSessions30d + coverage.calibrationSessions, 0.9),
    evidence: [
      `Average session focus: ${Math.round(profile.avgSessionFocusScore || 0)}/100`,
      `${coverage.calibrationSessions} recent calibration reflections`,
    ],
    source: 'uil_profile',
    updatedAt: profile.synthesizedAt ? new Date(profile.synthesizedAt).toISOString() : null,
  });

  addBelief(beliefs, {
    id: 'coaching_style',
    kind: 'work_preference',
    label: 'Preferred coaching style',
    value: profile.preferredCoachingStyle,
    confidence: confidenceFromEvidence(0.42, coverage.feedbackEvents30d + feedbackFacts.length, 0.9),
    evidence: [
      `${coverage.feedbackEvents30d} explicit outcome ratings in 30d`,
      ...feedbackFacts.slice(0, 2).map(fact => fact.content),
    ],
    source: 'feedback',
    updatedAt: feedbackFacts[0]?.last_confirmed ?? null,
  });

  if (profile.knowledgeGaps.length > 0) {
    addBelief(beliefs, {
      id: 'knowledge_gaps',
      kind: 'knowledge_gap',
      label: 'Current learning gaps',
      value: profile.knowledgeGaps.slice(0, 3).join(' | '),
      confidence: confidenceFromEvidence(0.38, profile.recentStudyTopics.length + coverage.focusSessions30d, 0.82),
      evidence: [
        profile.recentStudyTopics.length ? `Recent study: ${profile.recentStudyTopics.slice(0, 3).join(', ')}` : '',
        profile.nextRecommendedTopic ? `Next topic: ${profile.nextRecommendedTopic}` : '',
      ],
      source: 'uil_profile',
      updatedAt: profile.synthesizedAt ? new Date(profile.synthesizedAt).toISOString() : null,
    });
  }

  for (const fact of facts.slice(0, 5)) {
    addBelief(beliefs, {
      id: `memory_${fact.id}`,
      kind: fact.category === 'constraint' ? 'constraint' : fact.category === 'preference' ? 'work_preference' : 'feedback_preference',
      label: fact.topic.replace(/_/g, ' '),
      value: fact.content,
      confidence: Math.max(0.35, Math.min(0.95, Number(fact.confidence))),
      evidence: [
        `memory source: ${fact.source}`,
        `confirmed ${fact.confirmed_count} time${fact.confirmed_count === 1 ? '' : 's'}`,
      ],
      source: fact.source === 'feedback_learning' ? 'feedback' : 'memory',
      updatedAt: fact.last_confirmed,
    });
  }

  const gaps = deriveGaps(snapshot, coverage);
  const traitBoost = Math.min(0.18, cognitiveTraits.pressureProfile.confidence * 0.2);
  const confidence = Number(clamp(
    0.22 +
    Math.min(0.22, coverage.activeMemoryFacts * 0.015) +
    Math.min(0.2, coverage.feedbackEvents30d * 0.025) +
    Math.min(0.2, coverage.focusSessions30d * 0.025) +
    Math.min(0.16, coverage.checkins14d * 0.02) +
    traitBoost,
    0.1,
    0.95,
  ).toFixed(2));

  const daySummary = profile.currentNarrative ||
    `LifeOS is currently reading you as ${snapshot.moment.mode.replace(/_/g, ' ')} with ${snapshot.userState.energy} energy and ${profile.focusTrend} focus.`;
  const summary = cognitiveTraits.pressureProfile.confidence >= 0.25
    ? `${cognitiveTraits.summary} ${daySummary}`
    : daySummary;

  return {
    generatedAt: snapshot.generatedAt,
    confidence,
    summary,
    beliefs: beliefs.sort((a, b) => b.confidence - a.confidence).slice(0, 18),
    gaps,
    coverage,
    cognitiveTraits,
  };
}

export function selectSelfModelQuestion(selfModel: SelfModel, surface: 'morning_checkin' | 'evening_checkin'): SelfModelGapQuestion | null {
  const priorityScore: Record<SelfModelGap['priority'], number> = { high: 3, medium: 2, low: 1 };
  const surfaceWeight = surface === 'morning_checkin'
    ? ['today_anchor_missing', 'daily_checkins_sparse', 'focus_sessions_sparse', 'feedback_sparse', 'calibration_sparse']
    : ['daily_checkins_sparse', 'today_anchor_missing', 'feedback_sparse', 'calibration_sparse', 'focus_sessions_sparse'];

  const ranked = [...selfModel.gaps].sort((a, b) => {
    const priorityDelta = priorityScore[b.priority] - priorityScore[a.priority];
    if (priorityDelta !== 0) return priorityDelta;
    const aSurface = surfaceWeight.indexOf(a.id);
    const bSurface = surfaceWeight.indexOf(b.id);
    return (aSurface === -1 ? 99 : aSurface) - (bSurface === -1 ? 99 : bSurface);
  });

  const gap = ranked[0];
  if (!gap) return null;

  const question = (() => {
    if (surface === 'morning_checkin') {
      if (gap.id === 'today_anchor_missing') {
        return 'What is today about, what would count as enough, and how likely are you to do it from 1-10?';
      }
      if (gap.id === 'daily_checkins_sparse') {
        return 'How did you sleep, what is your energy right now, and what is your one commitment today from 1-10 likelihood?';
      }
      if (gap.id === 'focus_sessions_sparse') {
        return 'What task should I time-box first today, and should the first session be short, medium, or deep?';
      }
      return gap.suggestedQuestion;
    }

    if (gap.id === 'daily_checkins_sparse') {
      return 'How did sleep, mood, energy, and anything that happened today affect your focus?';
    }
    if (gap.id === 'today_anchor_missing') {
      return 'What do you want tomorrow to be about, and what would count as enough?';
    }
    if (gap.id === 'feedback_sparse') {
      return 'Which reminder, suggestion, or scheduling choice today was useful, badly timed, or wrong?';
    }
    if (gap.id === 'calibration_sparse') {
      return 'Did I overestimate or underestimate your actual focus today?';
    }
    return gap.suggestedQuestion;
  })();

  return {
    gapId: gap.id,
    label: gap.label,
    reason: gap.reason,
    question,
    priority: gap.priority,
  };
}
