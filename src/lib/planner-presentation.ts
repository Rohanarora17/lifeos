import type { PlanningDayContext } from './next-day-planner';

export function getPlannerLabels(relation: PlanningDayContext['relation']) {
  if (relation === 'today') {
    return {
      title: 'Adaptive Day Planner',
      intentionLabel: 'Context for the rest of today',
      blocksLabel: 'Remaining Today Blocks',
      generateLabel: 'Replan Today',
    };
  }
  if (relation === 'tomorrow') {
    return {
      title: 'Next-Day Planner',
      intentionLabel: 'Tomorrow intention and constraints',
      blocksLabel: 'Tomorrow Blocks',
      generateLabel: 'Regenerate Tomorrow',
    };
  }
  return {
    title: 'Adaptive Day Planner',
    intentionLabel: 'Plan intention and constraints',
    blocksLabel: relation === 'past' ? 'Recorded Plan Blocks' : 'Planned Blocks',
    generateLabel: relation === 'past' ? 'Review Plan' : 'Regenerate Plan',
  };
}

export function formatPlannerSessionStart(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date).replace('Sept', 'Sep');
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${day} · ${time}`;
}

export function plannerApiErrorMessage(result: { success?: boolean; error?: string }): string | null {
  if (result.success !== false) return null;
  return result.error?.trim() || 'LifeOS could not safely rebuild this plan. Your current plan was kept.';
}
