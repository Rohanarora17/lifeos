import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';
import { getDb } from './db';

export type RewardAction =
  | 'habit_checkin'
  | 'habit_uncheck'
  | 'photo_proof'
  | 'task_auto_complete'
  | 'badge_unlock'
  | 'reward_purchase'
  | 'custom_reward';

export interface AdaptiveRewardDecision {
  action: RewardAction;
  coins: number;
  mode: PersonalizationSnapshot['moment']['mode'];
  multiplier: number;
  label: string;
  reason: string;
  ledgerReason: string;
}

export interface RewardPolicySummary {
  mode: PersonalizationSnapshot['moment']['mode'];
  guidance: string;
  energy: PersonalizationSnapshot['userState']['energy'];
  mood: PersonalizationSnapshot['userState']['mood'];
  focusTrend: PersonalizationSnapshot['userState']['focusTrend'];
  alertFatigueLevel: PersonalizationSnapshot['feedback']['alertFatigueLevel'];
  helpfulRate: number | null;
  coinMultiplier: number;
  earningGuidance: string;
  spendingGuidance: string;
}

export type RewardCategory = 'restorative' | 'leisure' | 'purchase' | 'escape' | 'social' | 'custom';

export interface AdaptiveRewardPriceInput {
  title: string;
  desiredCost?: number | null;
  category?: RewardCategory | string | null;
  balance?: number;
  snapshot?: PersonalizationSnapshot;
}

export interface AdaptiveRewardPriceDecision {
  cost: number;
  category: RewardCategory;
  userCostOverride: boolean;
  multiplier: number;
  reason: string;
  pricingJson: string;
}

interface RewardDecisionInput {
  action: RewardAction;
  baseCoins: number;
  subject?: string;
  priority?: string | null;
  snapshot?: PersonalizationSnapshot;
}

export interface AdaptiveTaskRewardBaseInput {
  taskId?: number | null;
  title: string;
  priority?: string | null;
  targetMinutes?: number | null;
  snapshot?: PersonalizationSnapshot;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSnapshot(snapshot?: PersonalizationSnapshot): PersonalizationSnapshot {
  return snapshot ?? buildPersonalizationSnapshot({
    surface: 'rewards',
    maxInsights: 2,
    includeMemoryFacts: 3,
  });
}

function rewardMultiplier(snapshot: PersonalizationSnapshot): number {
  let multiplier = 1;

  if (snapshot.moment.mode === 'recovery') multiplier += 0.25;
  if (snapshot.moment.mode === 'deadline_pressure') multiplier += 0.15;
  if (snapshot.moment.mode === 'protect_focus') multiplier += 0.1;
  if (snapshot.userState.energy === 'low') multiplier += 0.15;
  if (snapshot.userState.focusTrend === 'declining') multiplier += 0.1;
  if (snapshot.feedback.alertFatigueLevel === 'high') multiplier += 0.1;
  if (snapshot.feedback.helpfulRate !== null && snapshot.feedback.helpfulRate < 0.45) multiplier -= 0.1;

  return clamp(multiplier, 0.85, 1.45);
}

function describePolicy(snapshot: PersonalizationSnapshot, multiplier: number): string {
  if (snapshot.moment.mode === 'recovery') {
    return 'low-energy consistency matters today, so small completions get extra credit';
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return 'deadline pressure is active, so rewards favor concrete progress';
  }
  if (snapshot.moment.mode === 'protect_focus') {
    return 'you are in a focus window, so rewards favor actions that preserve momentum';
  }
  if (snapshot.moment.mode === 'planning') {
    return 'today is leaning toward planning and cleanup, so rewards stay steady';
  }
  if (multiplier > 1.05) {
    return 'your recent signals call for more positive reinforcement today';
  }
  return 'balanced day: standard rewards apply';
}

function subjectLabel(subject?: string): string {
  return subject?.trim() || 'this action';
}

function taskComplexityMultiplier(title: string): { multiplier: number; reason: string } {
  const lower = title.toLowerCase();
  if (/(exam|final|assignment|deadline|submit|deliver|client|interview|proof|paper|research|math|zks|zk|protocol)/.test(lower)) {
    return { multiplier: 1.18, reason: 'high-cognitive or deadline-linked task' };
  }
  if (/(review|revise|cleanup|organize|plan|setup|read|watch|skim)/.test(lower)) {
    return { multiplier: 0.92, reason: 'lighter review/setup task' };
  }
  return { multiplier: 1, reason: 'standard task complexity' };
}

function taskFeedbackRewardAdjustment(taskId: number | null | undefined): {
  multiplier: number;
  reason: string | null;
  stats: Record<string, number>;
} {
  if (!taskId) return { multiplier: 1, reason: null, stats: {} };

  try {
    const feedbackRows = getDb().prepare(`
      SELECT feedback, COUNT(*) as count
      FROM task_recommendation_feedback
      WHERE task_id = ?
        AND created_at >= datetime('now', '-45 days')
      GROUP BY feedback
    `).all(taskId) as Array<{ feedback: string; count: number }>;

    if (feedbackRows.length === 0) return { multiplier: 1, reason: null, stats: {} };

    const stats = feedbackRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.feedback] = row.count;
      return acc;
    }, {});
    const positive = (stats.helpful ?? 0) + (stats.started ?? 0) + (stats.completed ?? 0);
    const negative = (stats.not_now ?? 0) + (stats.wrong ?? 0) + (stats.dismissed ?? 0);

    if (positive > negative) {
      return {
        multiplier: clamp(1 + positive * 0.08, 1.04, 1.24),
        reason: 'reward boosted because you previously accepted this task recommendation',
        stats,
      };
    }

    if (negative > positive) {
      const penalty = (stats.wrong ?? 0) > 0 ? 0.78 : (stats.not_now ?? 0) > 0 ? 0.86 : 0.92;
      return {
        multiplier: penalty,
        reason: 'reward softened because this recommendation was previously rejected or deferred',
        stats,
      };
    }

    return {
      multiplier: 1,
      reason: 'mixed recommendation feedback kept reward neutral',
      stats,
    };
  } catch {
    return { multiplier: 1, reason: null, stats: {} };
  }
}

export function getAdaptiveTaskRewardBase(input: AdaptiveTaskRewardBaseInput): {
  baseCoins: number;
  reason: string;
  factors: Record<string, number | string | null>;
} {
  const snapshot = getSnapshot(input.snapshot);
  const title = subjectLabel(input.title);
  const targetMinutes = Math.max(5, Math.round(Number(input.targetMinutes || 0) || 0));
  const priority = input.priority ?? 'medium';
  const priorityWeight =
    priority === 'critical' ? 1.45 :
      priority === 'high' ? 1.18 :
        priority === 'low' ? 0.82 : 1;
  const durationWeight = clamp(targetMinutes / 45, 0.45, 2.1);
  const complexity = taskComplexityMultiplier(title);
  const taskFeedback = taskFeedbackRewardAdjustment(input.taskId);

  let contextWeight = 1;
  if (snapshot.moment.mode === 'deadline_pressure') contextWeight += priority === 'low' ? -0.1 : 0.18;
  if (snapshot.moment.mode === 'recovery') contextWeight += targetMinutes <= 30 ? 0.14 : -0.05;
  if (snapshot.moment.mode === 'protect_focus') contextWeight += 0.08;
  if (snapshot.userState.energy === 'low' && targetMinutes > 60) contextWeight -= 0.08;
  if (snapshot.userState.focusTrend === 'declining') contextWeight += 0.07;
  if (snapshot.today.overdueTasks > 0 && priority !== 'low') contextWeight += 0.12;

  const raw = 28 * priorityWeight * durationWeight * complexity.multiplier * clamp(contextWeight, 0.72, 1.45) * taskFeedback.multiplier;
  const baseCoins = Math.max(5, Math.round(raw / 5) * 5);

  return {
    baseCoins,
    reason: [
      complexity.reason,
      `${snapshot.moment.mode} mode shaped ${targetMinutes}m reward base`,
      taskFeedback.reason,
    ].filter(Boolean).join('; '),
    factors: {
      priority,
      priorityWeight: Number(priorityWeight.toFixed(2)),
      targetMinutes,
      durationWeight: Number(durationWeight.toFixed(2)),
      complexity: Number(complexity.multiplier.toFixed(2)),
      contextWeight: Number(contextWeight.toFixed(2)),
      mode: snapshot.moment.mode,
      energy: snapshot.userState.energy,
      focusTrend: snapshot.userState.focusTrend,
      overdueTasks: snapshot.today.overdueTasks,
      taskFeedbackMultiplier: Number(taskFeedback.multiplier.toFixed(2)),
      taskFeedback: Object.keys(taskFeedback.stats).length ? JSON.stringify(taskFeedback.stats) : null,
    },
  };
}

function inferRewardCategory(title: string, explicit?: RewardCategory | string | null): RewardCategory {
  if (explicit && ['restorative', 'leisure', 'purchase', 'escape', 'social', 'custom'].includes(explicit)) {
    return explicit as RewardCategory;
  }
  const lower = title.toLowerCase();
  if (/(sleep|nap|walk|massage|bath|rest|meditat|stretch|tea)/.test(lower)) return 'restorative';
  if (/(game|gaming|movie|youtube|netflix|anime|scroll|instagram|twitter|reddit)/.test(lower)) return 'leisure';
  if (/(buy|order|coffee|food|book|course|device|shopping|purchase)/.test(lower)) return 'purchase';
  if (/(skip|avoid|bunk|delay|postpone|cheat)/.test(lower)) return 'escape';
  if (/(friend|call|party|date|meet|hangout)/.test(lower)) return 'social';
  return 'custom';
}

function baseRewardCost(category: RewardCategory, title: string): number {
  const lower = title.toLowerCase();
  if (category === 'restorative') return 350;
  if (category === 'social') return 700;
  if (category === 'purchase') return /(expensive|device|keyboard|shoe|course)/.test(lower) ? 2200 : 1200;
  if (category === 'escape') return 2400;
  if (category === 'leisure') return /(hour|movie|gaming|game|netflix)/.test(lower) ? 1200 : 850;
  return 800;
}

function rewardPriceMultiplier(category: RewardCategory, snapshot: PersonalizationSnapshot): { multiplier: number; reasons: string[] } {
  let multiplier = 1;
  const reasons: string[] = [];

  if (snapshot.moment.mode === 'deadline_pressure' && (category === 'leisure' || category === 'escape')) {
    multiplier += 0.35;
    reasons.push('priced higher because deadline pressure makes escape rewards risky');
  }
  if (snapshot.moment.mode === 'recovery' && category === 'restorative') {
    multiplier -= 0.2;
    reasons.push('priced lower because restorative rewards support recovery');
  }
  if (snapshot.userState.energy === 'low' && category === 'escape') {
    multiplier += 0.15;
    reasons.push('priced higher because low energy can turn escape rewards into avoidance');
  }
  if (snapshot.userState.focusTrend === 'declining' && category === 'leisure') {
    multiplier += 0.15;
    reasons.push('priced higher because focus trend is declining');
  }
  if (snapshot.moment.mode === 'protect_focus' && (category === 'restorative' || category === 'social')) {
    multiplier -= 0.1;
    reasons.push('priced slightly lower because it can preserve momentum after focus');
  }

  return { multiplier: clamp(multiplier, 0.7, 1.75), reasons };
}

export function priceAdaptiveReward(input: AdaptiveRewardPriceInput): AdaptiveRewardPriceDecision {
  const snapshot = getSnapshot(input.snapshot);
  const title = subjectLabel(input.title);
  const category = inferRewardCategory(title, input.category);
  const explicit = Number(input.desiredCost);

  if (Number.isFinite(explicit) && explicit > 0) {
    return {
      cost: Math.max(1, Math.round(explicit)),
      category,
      userCostOverride: true,
      multiplier: 1,
      reason: 'user supplied an explicit price; adaptive policy recorded context but did not override it',
      pricingJson: JSON.stringify({
        source: 'user_override',
        category,
        mode: snapshot.moment.mode,
        energy: snapshot.userState.energy,
        balance: input.balance ?? null,
      }),
    };
  }

  const base = baseRewardCost(category, title);
  const priced = rewardPriceMultiplier(category, snapshot);
  const balance = Math.max(0, Math.round(input.balance ?? 0));
  const balanceFloor = balance > 0 ? Math.max(100, Math.round(balance * 0.08 / 25) * 25) : 0;
  const balanceCeil = balance > 0 ? Math.max(500, Math.round(balance * 0.6 / 25) * 25) : 5000;
  const cost = Math.max(100, Math.min(balanceCeil, Math.max(balanceFloor, Math.round((base * priced.multiplier) / 25) * 25)));
  const reason = priced.reasons.length
    ? priced.reasons.join('; ')
    : `priced from ${category} baseline for ${snapshot.moment.mode} mode`;

  return {
    cost,
    category,
    userCostOverride: false,
    multiplier: Number(priced.multiplier.toFixed(2)),
    reason,
    pricingJson: JSON.stringify({
      source: 'adaptive_policy',
      base,
      multiplier: Number(priced.multiplier.toFixed(2)),
      category,
      mode: snapshot.moment.mode,
      energy: snapshot.userState.energy,
      mood: snapshot.userState.mood,
      focusTrend: snapshot.userState.focusTrend,
      balance,
      bounds: { balanceFloor, balanceCeil },
    }),
  };
}

export function getAdaptiveRewardDecision(input: RewardDecisionInput): AdaptiveRewardDecision {
  const snapshot = getSnapshot(input.snapshot);
  const multiplier = rewardMultiplier(snapshot);
  const subject = subjectLabel(input.subject);
  const priority = input.priority ?? 'medium';

  if (input.action === 'habit_uncheck') {
    const penaltyMultiplier = snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low'
      ? 0.5
      : snapshot.feedback.alertFatigueLevel === 'high'
        ? 0.75
        : 1;
    const coins = -Math.round(Math.abs(input.baseCoins) * penaltyMultiplier);
    const reason = penaltyMultiplier < 1
      ? 'penalty softened because today needs recovery, not punishment'
      : 'standard reversal for undoing a completed habit';
    return {
      action: input.action,
      coins,
      mode: snapshot.moment.mode,
      multiplier: penaltyMultiplier,
      label: coins === 0 ? 'No penalty' : `${coins} coins`,
      reason,
      ledgerReason: `Unchecked Habit: ${subject} (${reason})`,
    };
  }

  let actionMultiplier = multiplier;
  if (input.action === 'photo_proof') actionMultiplier += 0.1;
  if (input.action === 'badge_unlock') actionMultiplier += 0.05;
  if (input.action === 'task_auto_complete') {
    if (priority === 'critical') actionMultiplier += 0.2;
    if (priority === 'high') actionMultiplier += 0.1;
    if (priority === 'low' && snapshot.moment.mode === 'deadline_pressure') actionMultiplier -= 0.15;
  }

  const cappedMultiplier = clamp(actionMultiplier, 0.85, input.action === 'task_auto_complete' ? 1.6 : 1.5);
  const coins = Math.max(1, Math.round(input.baseCoins * cappedMultiplier / 5) * 5);
  const reason = describePolicy(snapshot, cappedMultiplier);

  return {
    action: input.action,
    coins,
    mode: snapshot.moment.mode,
    multiplier: Number(cappedMultiplier.toFixed(2)),
    label: `+${coins} coins`,
    reason,
    ledgerReason: `${rewardLedgerPrefix(input.action)}: ${subject} (${reason})`,
  };
}

export function getAdaptiveRewardPolicy(snapshot?: PersonalizationSnapshot): RewardPolicySummary {
  const resolved = getSnapshot(snapshot);
  const multiplier = Number(rewardMultiplier(resolved).toFixed(2));

  return {
    mode: resolved.moment.mode,
    guidance: resolved.moment.guidance,
    energy: resolved.userState.energy,
    mood: resolved.userState.mood,
    focusTrend: resolved.userState.focusTrend,
    alertFatigueLevel: resolved.feedback.alertFatigueLevel,
    helpfulRate: resolved.feedback.helpfulRate,
    coinMultiplier: multiplier,
    earningGuidance: describePolicy(resolved, multiplier),
    spendingGuidance: resolved.moment.mode === 'deadline_pressure'
      ? 'Use rewards after the pressure is reduced, not as an escape from it.'
      : resolved.moment.mode === 'recovery'
        ? 'Choose restorative rewards that make tomorrow easier.'
        : 'Spend coins on rewards that feel earned and do not derail the next focus block.',
  };
}

function rewardLedgerPrefix(action: RewardAction): string {
  switch (action) {
    case 'habit_checkin':
      return 'Completed Habit';
    case 'photo_proof':
      return 'Photo Verified';
    case 'task_auto_complete':
      return 'Auto-completed Task';
    case 'badge_unlock':
      return 'Unlocked Badge';
    case 'reward_purchase':
      return 'Bought';
    case 'custom_reward':
      return 'Created Reward';
    case 'habit_uncheck':
      return 'Unchecked Habit';
  }
}
