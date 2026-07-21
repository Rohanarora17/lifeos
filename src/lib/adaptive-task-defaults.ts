import { getAdaptiveSessionMinutes, getAdaptiveSessionMinutesLabel } from './adaptive-command-defaults';
import { getDb } from './db';
import type { PersonalizationSnapshot } from './personalization-context';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type TaskEnergy = 'low' | 'medium' | 'high';

export interface AdaptiveTaskDefaultsInput {
  title: string;
  taskType?: string | null;
  course?: string | null;
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

function loadSimilarTaskMinutes(input: Pick<AdaptiveTaskDefaultsInput, 'title' | 'taskType' | 'course'>): { minutes: number; reason: string } | null {
  try {
    const keywords = input.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3)
      .slice(0, 3);
    const where: string[] = [];
    const params: unknown[] = [];

    if (input.taskType) {
      where.push('COALESCE(t.task_type, ?) = ?');
      params.push('task', input.taskType);
    }
    if (input.course) {
      where.push('LOWER(COALESCE(t.course, ?)) = LOWER(?)');
      params.push('', input.course);
    }
    for (const keyword of keywords) {
      where.push('LOWER(t.title) LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (where.length === 0) return null;

    const rows = getDb().prepare(`
      SELECT
        t.estimated_minutes as estimated_minutes,
        COALESCE(SUM(l.credited_minutes), 0) as credited_minutes
      FROM tasks t
      LEFT JOIN task_session_logs l ON l.task_id = t.id
      WHERE (${where.join(' OR ')})
        AND (t.estimated_minutes IS NOT NULL OR l.id IS NOT NULL)
      GROUP BY t.id
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT 12
    `).all(...params) as Array<{ estimated_minutes: number | null; credited_minutes: number }>;

    const values = rows
      .map(row => Number(row.estimated_minutes ?? 0) > 0 ? Number(row.estimated_minutes) : Number(row.credited_minutes ?? 0))
      .filter(value => Number.isFinite(value) && value >= 10)
      .sort((a, b) => a - b);
    if (values.length < 2) return null;
    const median = values[Math.floor(values.length / 2)];
    return {
      minutes: Math.round(median),
      reason: `similar tasks usually take about ${Math.round(median)}m`,
    };
  } catch {
    return null;
  }
}

function inferEstimateMinutes(input: AdaptiveTaskDefaultsInput): { minutes: number; reason: string } {
  const learnedSession = getAdaptiveSessionMinutes();
  const similar = loadSimilarTaskMinutes(input);
  const text = `${input.title} ${input.taskType ?? ''} ${input.course ?? ''}`.toLowerCase();
  const due = daysUntil(input.dueDate);
  let minutes = similar?.minutes ?? learnedSession;
  const reasons: string[] = [similar?.reason ?? getAdaptiveSessionMinutesLabel()];

  if (/(exam|assignment|project|paper|research|proof|implementation|build|thesis)/.test(text)) {
    minutes = Math.max(minutes, learnedSession * 2);
    reasons.push('task looks multi-session');
  } else if (/(quiz|review|revise|notes|cleanup|admin|email)/.test(text)) {
    minutes = Math.min(minutes, learnedSession);
    reasons.push('task looks bounded');
  } else if (/(math|problem|practice|academy|leetcode|exercise|drill)/.test(text)) {
    minutes = Math.max(minutes, Math.round(learnedSession * 1.5));
    reasons.push('practice tasks benefit from accumulated reps');
  }

  if (input.snapshot.moment.mode === 'recovery' || input.snapshot.userState.energy === 'low') {
    minutes = Math.min(minutes, Math.max(learnedSession, Math.round(minutes * 0.85)));
    reasons.push('low-capacity day keeps initial target conservative');
  }
  if (input.snapshot.moment.mode === 'deadline_pressure' || due === 0 || due === 1) {
    minutes = Math.max(minutes, learnedSession * 2);
    reasons.push('deadline pressure needs a larger protected target');
  }

  return {
    minutes: Math.max(10, Math.min(720, Math.round(minutes))),
    reason: reasons.join('; '),
  };
}

export function buildAdaptiveTaskDefaults(input: AdaptiveTaskDefaultsInput): AdaptiveTaskDefaults {
  const explicitPriority = validPriority(input.explicitPriority);
  const explicitEnergy = validEnergy(input.explicitEnergyRequired);
  const rawEstimate = Number(input.explicitEstimateMinutes);
  const hasExplicitEstimate = Number.isFinite(rawEstimate) && rawEstimate > 0;
  const priority = explicitPriority ? { priority: explicitPriority, reason: 'user supplied priority' } : inferPriority(input);
  const energy = explicitEnergy ? { energy: explicitEnergy, reason: 'user supplied energy requirement' } : inferEnergy(input.title, input.taskType, input.snapshot);
  const estimate = hasExplicitEstimate
    ? { minutes: Math.max(5, Math.min(720, Math.round(rawEstimate))), reason: `${Math.max(5, Math.min(720, Math.round(rawEstimate)))}m explicit target` }
    : inferEstimateMinutes(input);

  return {
    priority: priority.priority,
    estimatedMinutes: estimate.minutes,
    energyRequired: energy.energy,
    reason: [
      priority.reason,
      energy.reason,
      estimate.reason,
      `${input.snapshot.moment.mode} mode`,
    ].join('; '),
  };
}
