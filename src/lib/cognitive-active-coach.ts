/**
 * Tier B4.5 — Active coach / auto-rewiring.
 *
 * Gated on map trust: user has confirmed or aspirational-marked at least one
 * core cognitive trait, and has not disputed the drivers we would use.
 *
 * Explicit light experiments (B4) still win when accepted.
 * True deadline_pressure days: protect crisis fuel — no rewiring fight.
 */

import { getSetting, setSetting } from './db';
import {
  computeCognitiveTraits,
  type CognitiveTrait,
  type CognitiveTraitBundle,
  type CognitiveTraitId,
} from './cognitive-traits';
import {
  getPlannerExperimentBias,
  type PlannerExperimentBias,
} from './cognitive-experiments';
import type { PersonalizationSnapshot } from './personalization-context';

const COACH_MODE_KEY = 'active_coach_mode';
const CORE_TRAIT_IDS: CognitiveTraitId[] = [
  'pressure_dependency',
  'voluntary_start_rate',
  'activation_energy',
];

export type ActiveCoachMode = 'auto' | 'off';

export interface MapTrust {
  trusted: boolean;
  reason: string;
  confirmed: CognitiveTraitId[];
  aspirational: CognitiveTraitId[];
  disputed: CognitiveTraitId[];
}

export interface ActiveCoachPolicy {
  mode: ActiveCoachMode;
  enabled: boolean;
  mapTrust: MapTrust;
  /** True on deadline_pressure days — do not fight crisis fuel */
  suppressRewiring: boolean;
  activationBlocks: boolean;
  earlyCommitmentBoost: boolean;
  voluntaryRewardBias: number;
  preferredActivationMinutes: number | null;
  scoreBoostForNonUrgent: number;
  coachGuidance: string;
  reasons: string[];
}

function traitById(bundle: CognitiveTraitBundle, id: CognitiveTraitId): CognitiveTrait | undefined {
  return bundle.traits.find(t => t.id === id);
}

export function getActiveCoachMode(): ActiveCoachMode {
  const raw = (getSetting(COACH_MODE_KEY) || 'auto').trim().toLowerCase();
  return raw === 'off' ? 'off' : 'auto';
}

export function setActiveCoachMode(mode: ActiveCoachMode): void {
  setSetting(COACH_MODE_KEY, mode === 'off' ? 'off' : 'auto');
}

/**
 * Map is trusted once the user has confirmed or marked aspirational at least one
 * core wiring trait. Disputed traits are excluded as drivers.
 */
export function evaluateMapTrust(bundle?: CognitiveTraitBundle): MapTrust {
  const traits = bundle ?? computeCognitiveTraits({ windowDays: 45 });
  const confirmed: CognitiveTraitId[] = [];
  const aspirational: CognitiveTraitId[] = [];
  const disputed: CognitiveTraitId[] = [];

  for (const id of CORE_TRAIT_IDS) {
    const trait = traitById(traits, id);
    if (!trait) continue;
    if (trait.userStance === 'confirmed') confirmed.push(id);
    if (trait.userStance === 'aspirational') aspirational.push(id);
    if (trait.userStance === 'disputed') disputed.push(id);
  }

  if (confirmed.length + aspirational.length === 0) {
    return {
      trusted: false,
      reason: 'Confirm or mark aspirational at least one core trait (pressure dependency, voluntary starts, or activation energy) before auto-rewiring.',
      confirmed,
      aspirational,
      disputed,
    };
  }

  return {
    trusted: true,
    reason: `Trusted via ${[...confirmed.map(id => `${id}:confirmed`), ...aspirational.map(id => `${id}:aspirational`)].join(', ')}.`,
    confirmed,
    aspirational,
    disputed,
  };
}

function isDriverAvailable(trust: MapTrust, id: CognitiveTraitId): boolean {
  return !trust.disputed.includes(id)
    && (trust.confirmed.includes(id) || trust.aspirational.includes(id) || trust.trusted);
}

/**
 * Build the active coach policy for today.
 * Explicit experiment bias is separate — merge via getCombinedPlannerBias().
 */
export function getActiveCoachPolicy(input?: {
  traits?: CognitiveTraitBundle;
  snapshot?: PersonalizationSnapshot;
}): ActiveCoachPolicy {
  const mode = getActiveCoachMode();
  const traits = input?.traits ?? computeCognitiveTraits({ windowDays: 45 });
  const trust = evaluateMapTrust(traits);
  const reasons: string[] = [];

  const deadlineDay = input?.snapshot?.moment.mode === 'deadline_pressure';
  const suppressRewiring = deadlineDay;

  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      mapTrust: trust,
      suppressRewiring,
      activationBlocks: false,
      earlyCommitmentBoost: false,
      voluntaryRewardBias: 0,
      preferredActivationMinutes: null,
      scoreBoostForNonUrgent: 0,
      coachGuidance: 'Active coach is turned off in settings.',
      reasons: ['active_coach_mode=off'],
    };
  }

  if (!trust.trusted) {
    return {
      mode,
      enabled: false,
      mapTrust: trust,
      suppressRewiring,
      activationBlocks: false,
      earlyCommitmentBoost: false,
      voluntaryRewardBias: 0,
      preferredActivationMinutes: null,
      scoreBoostForNonUrgent: 0,
      coachGuidance: trust.reason,
      reasons: ['map_not_trusted'],
    };
  }

  if (suppressRewiring) {
    return {
      mode,
      enabled: true,
      mapTrust: trust,
      suppressRewiring: true,
      activationBlocks: false,
      earlyCommitmentBoost: false,
      voluntaryRewardBias: 0,
      preferredActivationMinutes: null,
      scoreBoostForNonUrgent: 0,
      coachGuidance: 'Deadline pressure day: active coach protects crisis performance and does not fight deadline fuel. Rewiring resumes on normal days.',
      reasons: ['deadline_pressure_protect'],
    };
  }

  const pdi = traitById(traits, 'pressure_dependency');
  const vol = traitById(traits, 'voluntary_start_rate');
  const act = traitById(traits, 'activation_energy');

  let activationBlocks = false;
  let earlyCommitmentBoost = false;
  let voluntaryRewardBias = 0;
  let preferredActivationMinutes: number | null = null;
  let scoreBoostForNonUrgent = 0;

  // High activation lag → auto activation blocks when driver not disputed
  if (
    isDriverAvailable(trust, 'activation_energy')
    && act?.value != null
    && act.value >= 4
    && act.confidence >= 0.25
    && act.userStance !== 'disputed'
  ) {
    activationBlocks = true;
    preferredActivationMinutes = 15;
    scoreBoostForNonUrgent = Math.max(scoreBoostForNonUrgent, 28);
    reasons.push(`activation_blocks: lag ${act.value.toFixed(1)}d`);
  }

  // High PDI → early commitment boost for non-urgent important work
  if (
    isDriverAvailable(trust, 'pressure_dependency')
    && pdi?.value != null
    && pdi.value >= 0.55
    && pdi.confidence >= 0.25
    && pdi.userStance !== 'disputed'
  ) {
    earlyCommitmentBoost = true;
    scoreBoostForNonUrgent = Math.max(scoreBoostForNonUrgent, 36);
    reasons.push(`early_commitment: PDI ${Math.round(pdi.value * 100)}`);
    // Pair short ignition when voluntary starts are weak
    if (
      vol?.value != null
      && vol.value < 0.4
      && vol.userStance !== 'disputed'
    ) {
      activationBlocks = true;
      preferredActivationMinutes = preferredActivationMinutes ?? 15;
      reasons.push(`pair_activation: voluntary ${Math.round(vol.value * 100)}%`);
    }
  }

  // Reward bias when user aspires to raise voluntary starts or confirmed high PDI rewiring
  if (
    (vol?.userStance === 'aspirational' || trust.aspirational.includes('voluntary_start_rate'))
    || (pdi?.userStance === 'confirmed' && (pdi.value ?? 0) >= 0.55)
  ) {
    if (vol?.userStance !== 'disputed') {
      voluntaryRewardBias = 0.18;
      reasons.push('voluntary_reward_bias: rewiring goal active');
    }
  }

  const enabled = activationBlocks || earlyCommitmentBoost || voluntaryRewardBias > 0;

  const guidanceParts: string[] = [];
  if (activationBlocks) {
    guidanceParts.push(
      `Auto activation blocks (~${preferredActivationMinutes ?? 15}m) for non-urgent important work — ignition over heroics.`,
    );
  }
  if (earlyCommitmentBoost) {
    guidanceParts.push(
      'Auto early-commitment boost for non-urgent high-value tasks so starts happen before crisis.',
    );
  }
  if (voluntaryRewardBias > 0) {
    guidanceParts.push(
      'Non-crisis completions earn a rewiring bonus — reward voluntary starts more than last-minute saves.',
    );
  }
  if (!enabled) {
    guidanceParts.push(
      'Map is trusted but current metrics do not require auto-rewiring today.',
    );
  }

  return {
    mode,
    enabled,
    mapTrust: trust,
    suppressRewiring: false,
    activationBlocks,
    earlyCommitmentBoost,
    voluntaryRewardBias,
    preferredActivationMinutes,
    scoreBoostForNonUrgent,
    coachGuidance: guidanceParts.join(' '),
    reasons: reasons.length ? reasons : ['trusted_idle'],
  };
}

function isNonUrgentTask(task: { due_date?: string | null }, planDate?: string): boolean {
  if (!task.due_date) return true;
  if (!planDate) {
    const days = (new Date(`${task.due_date}T12:00:00Z`).getTime() - Date.now()) / 86400000;
    return days > 3;
  }
  const plan = new Date(`${planDate}T12:00:00Z`).getTime();
  const due = new Date(`${task.due_date}T12:00:00Z`).getTime();
  return (due - plan) / 86400000 > 3;
}

/**
 * Combined planner bias: explicit B4 experiment wins; else B4.5 active coach.
 */
export function getCombinedPlannerBias(input?: {
  traits?: CognitiveTraitBundle;
  snapshot?: PersonalizationSnapshot;
  planDate?: string;
}): PlannerExperimentBias & {
  source: 'experiment' | 'active_coach' | 'none';
  applyToNonUrgent: boolean;
  coach?: ActiveCoachPolicy;
} {
  const experiment = getPlannerExperimentBias();
  if (experiment.active) {
    return {
      ...experiment,
      source: 'experiment',
      applyToNonUrgent: false,
    };
  }

  const coach = getActiveCoachPolicy(input);
  if (!coach.enabled || coach.suppressRewiring) {
    return {
      active: false,
      kind: null,
      taskId: null,
      taskTitle: null,
      preferredActivationMinutes: null,
      syntheticDueDate: null,
      guidance: coach.coachGuidance,
      scoreBoost: 0,
      source: 'none',
      applyToNonUrgent: false,
      coach,
    };
  }

  if (!coach.activationBlocks && !coach.earlyCommitmentBoost) {
    return {
      active: false,
      kind: null,
      taskId: null,
      taskTitle: null,
      preferredActivationMinutes: null,
      syntheticDueDate: null,
      guidance: coach.coachGuidance,
      scoreBoost: 0,
      source: 'none',
      applyToNonUrgent: false,
      coach,
    };
  }

  const kind = coach.activationBlocks
    ? 'activation_block' as const
    : 'early_synthetic_deadline' as const;

  return {
    active: true,
    kind,
    taskId: null,
    taskTitle: null,
    preferredActivationMinutes: coach.activationBlocks ? (coach.preferredActivationMinutes ?? 15) : null,
    syntheticDueDate: coach.earlyCommitmentBoost
      ? new Date(Date.now() + 2 * 86400000 + 19800000).toISOString().slice(0, 10)
      : null,
    guidance: `Active coach: ${coach.coachGuidance}`,
    scoreBoost: coach.scoreBoostForNonUrgent,
    source: 'active_coach',
    applyToNonUrgent: true,
    coach,
  };
}

export function taskMatchesCoachBias(
  task: { id: number; due_date?: string | null; priority?: string },
  bias: ReturnType<typeof getCombinedPlannerBias>,
  planDate?: string,
): boolean {
  if (!bias.active) return false;
  if (bias.taskId != null) return bias.taskId === task.id;
  if (!bias.applyToNonUrgent) return false;
  // Prefer non-urgent high/critical work for rewiring
  const priority = (task.priority || 'medium').toLowerCase();
  if (priority === 'low') return false;
  return isNonUrgentTask(task, planDate);
}

export function formatActiveCoachForPrompt(policy?: ActiveCoachPolicy): string {
  const p = policy ?? getActiveCoachPolicy();
  if (p.mode === 'off') return 'Active coach: OFF (user disabled).';
  if (!p.mapTrust.trusted) {
    return `Active coach: waiting for map trust. ${p.mapTrust.reason}`;
  }
  if (p.suppressRewiring) {
    return `Active coach: ON but suppressed today (deadline pressure). ${p.coachGuidance}`;
  }
  if (!p.enabled) {
    return `Active coach: ON, idle. ${p.coachGuidance}`;
  }
  return [
    '=== ACTIVE COACH (auto-rewiring) ===',
    p.coachGuidance,
    `Drivers: ${p.reasons.join('; ')}`,
    'Do not shame crisis productivity. Protect true deadline days. Prefer voluntary starts on normal days.',
  ].join('\n');
}

/** Extra coin multiplier for non-crisis task completions under active coach. */
export function getVoluntaryRewardMultiplier(input?: {
  dueDate?: string | null;
  snapshot?: PersonalizationSnapshot;
  traits?: CognitiveTraitBundle;
}): { multiplier: number; reason: string | null } {
  const policy = getActiveCoachPolicy({
    traits: input?.traits,
    snapshot: input?.snapshot,
  });
  if (!policy.enabled || policy.suppressRewiring || policy.voluntaryRewardBias <= 0) {
    return { multiplier: 1, reason: null };
  }
  if (!isNonUrgentTask({ due_date: input?.dueDate ?? null })) {
    return { multiplier: 1, reason: null };
  }
  return {
    multiplier: 1 + policy.voluntaryRewardBias,
    reason: 'active coach rewiring bonus for non-crisis completion',
  };
}
