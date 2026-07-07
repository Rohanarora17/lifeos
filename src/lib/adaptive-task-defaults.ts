import { getAdaptiveSessionMinutes, getAdaptiveSessionMinutesLabel } from './adaptive-command-defaults';
import type { PersonalizationSnapshot } from './personalization-context';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type TaskEnergy = 'low' | 'medium' | 'high';

export interface AdaptiveTaskDefaultsInput {
  title: string;
  taskType?: string | null;
  dueDate?: string | null;
  explicitPriority?: unknown;
  explicitEstimateMinutes?: unknown;
  explicitEnergyRequired?: unknown;
  snapshot: PersonalizationSnapshot;
}

export interface AdaptiveTaskDefaults {
  priority: TaskPriority;
  estimatedMinutes: number;
  energyRequired: TaskEnergy;
  reason: string;
}

function validPriority(value: unknown): TaskPriority | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : null;
}

function validEnergy(value: unknown): TaskEnergy | null {
  return value === 'low' || value === 'medium' || value === 'high'
    ? value
    : null;
}

function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const time = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

function inferEnergy(title: string, taskType: string | null | undefined, snapshot: PersonalizationSnapshot): { energy: TaskEnergy; reason: string } {
  const text = `${title} ${taskType ?? ''}`.toLowerCase();
  if (/(exam|proof|research|paper|debug|implement|math|problem|architecture|deep|hard)/.test(text)) {
    return { energy: 'high', reason: 'topic looks cognitively heavy' };
  }
  if (/(review|revise|read|notes|cleanup|plan|organize|small|email|admin)/.test(text)) {
    return { energy: 'low', reason: 'topic can be handled as a lower-friction task' };
  }
  if (snapshot.moment.mode === 'recovery') {
    return { energy: 'low', reason: 'recovery mode favors smaller energy assumptions until corrected' };
  }
  return { energy: 'medium', reason: 'no strong energy signal yet' };
}

function inferPriority(input: AdaptiveTaskDefaultsInput): { priority: TaskPriority; reason: string } {
  const due = daysUntil(input.dueDate);
  const text = `${input.title} ${input.taskType ?? ''}`.toLowerCase();

  if (due !== null && due < 0) return { priority: 'critical', reason: 'overdue date makes this critical' };
  if (due === 0 || /(exam|deadline|urgent|submit|due today)/.test(text)) return { priority: 'high', reason: 'deadline pressure makes this high priority' };
  if (due !== null && due <= 2) return { priority: 'high', reason: `due in ${due}d` };
  if (input.snapshot.userState.standupGoal && text.includes(input.snapshot.userState.standupGoal.toLowerCase().slice(0, 16))) {
    return { priority: 'high', reason: 'matches today stated goal' };
  }
  if (input.snapshot.moment.mode === 'planning' && !input.dueDate) {
    return { priority: 'low', reason: 'planning mode keeps unscheduled new tasks out of the urgent lane' };
  }
  if (input.snapshot.moment.mode === 'recovery' && !input.dueDate) {
    return { priority: 'low', reason: 'recovery mode avoids treating unscheduled tasks as immediate pressure' };
  }
  return { priority: 'medium', reason: 'no stronger priority signal yet' };
}

export function buildAdaptiveTaskDefaults(input: AdaptiveTaskDefaultsInput): AdaptiveTaskDefaults {
  const explicitPriority = validPriority(input.explicitPriority);
  const explicitEnergy = validEnergy(input.explicitEnergyRequired);
  const rawEstimate = Number(input.explicitEstimateMinutes);
  const hasExplicitEstimate = Number.isFinite(rawEstimate) && rawEstimate > 0;
  const priority = explicitPriority ? { priority: explicitPriority, reason: 'user supplied priority' } : inferPriority(input);
  const energy = explicitEnergy ? { energy: explicitEnergy, reason: 'user supplied energy requirement' } : inferEnergy(input.title, input.taskType, input.snapshot);
  const estimatedMinutes = hasExplicitEstimate
    ? Math.max(5, Math.min(720, Math.round(rawEstimate)))
    : getAdaptiveSessionMinutes();

  return {
    priority: priority.priority,
    estimatedMinutes,
    energyRequired: energy.energy,
    reason: [
      priority.reason,
      energy.reason,
      hasExplicitEstimate ? `${estimatedMinutes}m explicit target` : getAdaptiveSessionMinutesLabel(),
      `${input.snapshot.moment.mode} mode`,
    ].join('; '),
  };
}
