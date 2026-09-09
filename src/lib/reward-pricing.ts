export const MAX_REWARD_COST = 10_000_000;

export const REWARD_CATEGORIES = [
  'restorative',
  'leisure',
  'purchase',
  'escape',
  'social',
  'custom',
] as const;

export type RewardCategory = typeof REWARD_CATEGORIES[number];

export interface RewardPricingContext {
  mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
  energy: 'high' | 'medium' | 'low';
  focusTrend: 'improving' | 'declining' | 'stable';
}

export interface RewardPriceCalculation {
  cost: number;
  category: RewardCategory;
  userCostOverride: boolean;
  multiplier: number;
  reason: string;
  baseCost: number | null;
  balanceFloor: number | null;
  balanceCeil: number | null;
}

const REWARD_CATEGORY_SET = new Set<string>(REWARD_CATEGORIES);
const PURCHASE_KEYWORDS = /(buy|order|coffee|food|book|course|device|shopping|purchase)/;
const EXPENSIVE_PURCHASE_KEYWORDS = /(expensive|device|keyboard|shoe|course)/;
const RESTORATIVE_KEYWORDS = /(sleep|nap|walk|massage|bath|rest|meditat|stretch|tea)/;
const LEISURE_KEYWORDS = /(game|gaming|movie|youtube|netflix|anime|scroll|instagram|twitter|reddit)/;
const ESCAPE_KEYWORDS = /(skip|avoid|bunk|delay|postpone|cheat)/;
const SOCIAL_KEYWORDS = /(friend|call|party|date|meet|hangout)/;
const LONG_LEISURE_KEYWORDS = /(hour|movie|gaming|game|netflix)/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeRewardCategory(value: unknown): RewardCategory {
  return typeof value === 'string' && REWARD_CATEGORY_SET.has(value)
    ? value as RewardCategory
    : 'custom';
}

export function parseRewardCost(value: unknown): { value: number | null; error: string | null } {
  if (value === null || value === undefined || value === '') return { value: null, error: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_REWARD_COST) {
    return { value: null, error: `Cost must be between 1 and ${MAX_REWARD_COST.toLocaleString()} coins` };
  }
  return { value: Math.round(parsed), error: null };
}

export function inferRewardCategory(title: string, explicit?: RewardCategory | string | null): RewardCategory {
  const normalized = normalizeRewardCategory(explicit);
  if (normalized !== 'custom') return normalized;

  const lower = title.toLowerCase();
  if (RESTORATIVE_KEYWORDS.test(lower)) return 'restorative';
  if (LEISURE_KEYWORDS.test(lower)) return 'leisure';
  if (PURCHASE_KEYWORDS.test(lower)) return 'purchase';
  if (ESCAPE_KEYWORDS.test(lower)) return 'escape';
  if (SOCIAL_KEYWORDS.test(lower)) return 'social';
  return 'custom';
}

function baseRewardCost(category: RewardCategory, title: string): number {
  const lower = title.toLowerCase();
  if (category === 'restorative') return 350;
  if (category === 'social') return 700;
  if (category === 'purchase') return EXPENSIVE_PURCHASE_KEYWORDS.test(lower) ? 2200 : 1200;
  if (category === 'escape') return 2400;
  if (category === 'leisure') return LONG_LEISURE_KEYWORDS.test(lower) ? 1200 : 850;
  return 800;
}

export function calculateRewardPrice(input: {
  title: string;
  desiredCost?: number | null;
  category?: RewardCategory | string | null;
  balance?: number;
  context: RewardPricingContext;
}): RewardPriceCalculation {
  const title = input.title.trim() || 'this reward';
  const category = inferRewardCategory(title, input.category);
  const explicit = Number(input.desiredCost);

  if (input.desiredCost !== null && input.desiredCost !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return {
      cost: Math.max(1, Math.round(explicit)),
      category,
      userCostOverride: true,
      multiplier: 1,
      reason: 'user supplied an explicit price; adaptive policy recorded context but did not override it',
      baseCost: null,
      balanceFloor: null,
      balanceCeil: null,
    };
  }

  let multiplier = 1;
  const reasons: string[] = [];
  if (input.context.mode === 'deadline_pressure' && (category === 'leisure' || category === 'escape')) {
    multiplier += 0.35;
    reasons.push('priced higher because deadline pressure makes escape rewards risky');
  }
  if (input.context.mode === 'recovery' && category === 'restorative') {
    multiplier -= 0.2;
    reasons.push('priced lower because restorative rewards support recovery');
  }
  if (input.context.energy === 'low' && category === 'escape') {
    multiplier += 0.15;
    reasons.push('priced higher because low energy can turn escape rewards into avoidance');
  }
  if (input.context.focusTrend === 'declining' && category === 'leisure') {
    multiplier += 0.15;
    reasons.push('priced higher because focus trend is declining');
  }
  if (input.context.mode === 'protect_focus' && (category === 'restorative' || category === 'social')) {
    multiplier -= 0.1;
    reasons.push('priced slightly lower because it can preserve momentum after focus');
  }

  const normalizedMultiplier = clamp(multiplier, 0.7, 1.75);
  const base = baseRewardCost(category, title);
  const balance = Math.max(0, Math.round(input.balance ?? 0));
  const balanceFloor = balance > 0 ? Math.max(100, Math.round(balance * 0.08 / 25) * 25) : 0;
  const balanceCeil = balance > 0 ? Math.max(500, Math.round(balance * 0.6 / 25) * 25) : 5000;
  const cost = Math.max(100, Math.min(
    balanceCeil,
    Math.max(balanceFloor, Math.round((base * normalizedMultiplier) / 25) * 25),
  ));

  return {
    cost,
    category,
    userCostOverride: false,
    multiplier: Number(normalizedMultiplier.toFixed(2)),
    reason: reasons.length
      ? reasons.join('; ')
      : `priced from ${category} baseline for ${input.context.mode} mode`,
    baseCost: base,
    balanceFloor,
    balanceCeil,
  };
}
