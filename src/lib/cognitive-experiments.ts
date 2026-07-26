/**
 * Tier B4 — light rewiring experiments.
 *
 * Map-first: at most one offered/accepted experiment.
 * Never auto-rewires; user must accept. Declining leaves planner unchanged.
 * True deadline days still protect pressure fuel (no fighting crisis).
 */

import { randomUUID } from 'crypto';
import { getDb, getSetting, setSetting } from './db';
import {
  computeCognitiveTraits,
  type CognitiveTraitBundle,
} from './cognitive-traits';

export type ExperimentKind = 'early_synthetic_deadline' | 'activation_block';
export type ExperimentStatus =
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'completed'
  | 'expired'
  | 'cancelled';

export interface CognitiveExperiment {
  id: string;
  kind: ExperimentKind;
  status: ExperimentStatus;
  title: string;
  rationale: string;
  traitSignals: string[];
  suggestedTaskId: number | null;
  suggestedTaskTitle: string | null;
  durationMinutes: number;
  syntheticDueDate: string | null;
  offeredAt: string;
  respondedAt: string | null;
  expiresAt: string;
  softWatchId: string | null;
  notes: string | null;
}

export interface CognitiveExperimentState {
  active: CognitiveExperiment | null;
  offered: CognitiveExperiment | null;
  recent: CognitiveExperiment[];
  canOffer: boolean;
  offerBlockReason: string | null;
}

export interface PlannerExperimentBias {
  active: boolean;
  kind: ExperimentKind | null;
  taskId: number | null;
  taskTitle: string | null;
  preferredActivationMinutes: number | null;
  syntheticDueDate: string | null;
  guidance: string | null;
  scoreBoost: number;
}

const STORE_KEY = 'cognitive_experiments_v1';
const DECLINE_COOLDOWN_DAYS = 5;
const OFFER_TTL_DAYS = 3;
const EXPERIMENT_RUN_DAYS = 7;

function nowIso(): string {
  return new Date().toISOString();
}

function addDaysIso(days: number, from = new Date()): string {
  const d = new Date(from.getTime() + days * 86400000);
  return d.toISOString();
}

function dateOnly(daysFromNow: number): string {
  const d = new Date(Date.now() + 19800000 + daysFromNow * 86400000);
  return d.toISOString().slice(0, 10);
}

function loadAll(): CognitiveExperiment[] {
  try {
    const raw = getSetting(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CognitiveExperiment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(rows: CognitiveExperiment[]): void {
  // Keep last 40 for history
  setSetting(STORE_KEY, JSON.stringify(rows.slice(-40)));
}

function expireStale(rows: CognitiveExperiment[]): CognitiveExperiment[] {
  const now = Date.now();
  let changed = false;
  const next = rows.map(row => {
    if ((row.status === 'offered' || row.status === 'accepted') && new Date(row.expiresAt).getTime() < now) {
      changed = true;
      return { ...row, status: 'expired' as const, respondedAt: row.respondedAt ?? nowIso() };
    }
    return row;
  });
  if (changed) saveAll(next);
  return next;
}

function findCandidateTask(preferNonUrgent = true): { id: number; title: string; due_date: string | null; priority: string } | null {
  try {
    const rows = getDb().prepare(`
      SELECT id, title, due_date, COALESCE(priority, 'medium') as priority
      FROM tasks
      WHERE status IN ('todo', 'doing')
        AND blocked_since IS NULL
      ORDER BY
        CASE WHEN status = 'doing' THEN 0 ELSE 1 END,
        CASE COALESCE(priority, 'medium')
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3
        END,
        id DESC
      LIMIT 40
    `).all() as Array<{ id: number; title: string; due_date: string | null; priority: string }>;

    if (rows.length === 0) return null;

    if (preferNonUrgent) {
      const nonUrgent = rows.find(row => {
        if (!row.due_date) return true;
        const days = (new Date(`${row.due_date}T12:00:00Z`).getTime() - Date.now()) / 86400000;
        return days > 3;
      });
      if (nonUrgent) return nonUrgent;
    }

    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function recentlyDeclined(kind: ExperimentKind, rows: CognitiveExperiment[]): boolean {
  const cutoff = Date.now() - DECLINE_COOLDOWN_DAYS * 86400000;
  return rows.some(row =>
    row.kind === kind
    && row.status === 'declined'
    && row.respondedAt
    && new Date(row.respondedAt).getTime() >= cutoff,
  );
}

function buildOfferFromTraits(
  traits: CognitiveTraitBundle,
  rows: CognitiveExperiment[],
): CognitiveExperiment | null {
  const pdi = traits.traits.find(t => t.id === 'pressure_dependency');
  const voluntary = traits.traits.find(t => t.id === 'voluntary_start_rate');
  const activation = traits.traits.find(t => t.id === 'activation_energy');
  const task = findCandidateTask(true);

  // Prefer activation block when start lag is high
  if (
    activation?.value != null
    && activation.value >= 4
    && activation.confidence >= 0.25
    && !recentlyDeclined('activation_block', rows)
  ) {
    return {
      id: `exp_${randomUUID().slice(0, 8)}`,
      kind: 'activation_block',
      status: 'offered',
      title: '15-minute activation block',
      rationale: task
        ? `Your create→first-focus lag averages ${activation.value.toFixed(1)} days. Try a tiny start block on "${task.title}" — goal is only to begin, not finish.`
        : `Your create→first-focus lag averages ${activation.value.toFixed(1)} days. Try a 15-minute "just start" block on any important non-urgent task.`,
      traitSignals: [
        activation.valueLabel,
        voluntary?.valueLabel ?? 'voluntary starts still learning',
      ],
      suggestedTaskId: task?.id ?? null,
      suggestedTaskTitle: task?.title ?? null,
      durationMinutes: 15,
      syntheticDueDate: null,
      offeredAt: nowIso(),
      respondedAt: null,
      expiresAt: addDaysIso(OFFER_TTL_DAYS),
      softWatchId: null,
      notes: null,
    };
  }

  // Early synthetic deadline when pressure dependency is high
  if (
    pdi?.value != null
    && pdi.value >= 0.55
    && pdi.confidence >= 0.25
    && !recentlyDeclined('early_synthetic_deadline', rows)
  ) {
    const syntheticDue = dateOnly(2);
    return {
      id: `exp_${randomUUID().slice(0, 8)}`,
      kind: 'early_synthetic_deadline',
      status: 'offered',
      title: 'Early synthetic deadline',
      rationale: task
        ? `Starts cluster under real deadline heat (PDI ${Math.round(pdi.value * 100)}). Borrow that fuel early: treat "${task.title}" as due ${syntheticDue} and soft-watch a commitment before crisis.`
        : `Starts cluster under real deadline heat (PDI ${Math.round(pdi.value * 100)}). Pick one important non-urgent task and give it a synthetic due date in 2 days.`,
      traitSignals: [
        pdi.valueLabel,
        voluntary?.valueLabel ?? 'voluntary starts still learning',
      ],
      suggestedTaskId: task?.id ?? null,
      suggestedTaskTitle: task?.title ?? null,
      durationMinutes: 45,
      syntheticDueDate: syntheticDue,
      offeredAt: nowIso(),
      respondedAt: null,
      expiresAt: addDaysIso(OFFER_TTL_DAYS),
      softWatchId: null,
      notes: null,
    };
  }

  return null;
}

export function getCognitiveExperimentState(): CognitiveExperimentState {
  const rows = expireStale(loadAll());
  const offered = rows.find(r => r.status === 'offered') ?? null;
  const active = rows.find(r => r.status === 'accepted') ?? null;
  const recent = [...rows].reverse().slice(0, 8);

  let canOffer = !offered && !active;
  let offerBlockReason: string | null = null;
  if (offered) offerBlockReason = 'An experiment is already offered — accept or decline it first.';
  if (active) offerBlockReason = 'An experiment is already active — complete or cancel it before offering another.';

  return { active, offered, recent, canOffer, offerBlockReason };
}

/**
 * Propose at most one light experiment from current cognitive traits.
 * Idempotent while an offer/active experiment exists.
 */
export function proposeCognitiveExperiment(options?: {
  force?: boolean;
  traits?: CognitiveTraitBundle;
}): { experiment: CognitiveExperiment | null; state: CognitiveExperimentState; created: boolean } {
  const state = getCognitiveExperimentState();
  if (!options?.force && !state.canOffer) {
    return {
      experiment: state.offered ?? state.active,
      state,
      created: false,
    };
  }

  const traits = options?.traits ?? computeCognitiveTraits({ windowDays: 45 });
  const rows = expireStale(loadAll());
  const offer = buildOfferFromTraits(traits, rows);
  if (!offer) {
    return {
      experiment: null,
      state: getCognitiveExperimentState(),
      created: false,
    };
  }

  // Force replaces existing offered only (never clobber accepted)
  const withoutOffered = rows.filter(r => r.status !== 'offered');
  if (state.active && options?.force) {
    return {
      experiment: state.active,
      state: getCognitiveExperimentState(),
      created: false,
    };
  }

  saveAll([...withoutOffered, offer]);
  return {
    experiment: offer,
    state: getCognitiveExperimentState(),
    created: true,
  };
}

function insertSoftWatchForExperiment(exp: CognitiveExperiment): string | null {
  if (!exp.suggestedTaskTitle && !exp.suggestedTaskId) return null;
  try {
    const id = `cogexp_${exp.id}`;
    const startAt = Date.now() + 60 * 60 * 1000; // ~1h from now as a gentle default
    const title = exp.suggestedTaskTitle
      ? (exp.kind === 'activation_block'
        ? `Activate: ${exp.suggestedTaskTitle}`
        : exp.suggestedTaskTitle)
      : exp.title;

    getDb().prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, goal_id, task_id, intended_start_at, planned_minutes,
        source, reminder_sent_at, check_in_sent_at, status, locked_in_session_id, calendar_event_id, created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, 'dashboard', NULL, NULL, 'pending', NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = 'pending',
        intended_start_at = excluded.intended_start_at,
        planned_minutes = excluded.planned_minutes,
        target_title = excluded.target_title,
        task_id = excluded.task_id
    `).run(
      id,
      title,
      exp.suggestedTaskId,
      startAt,
      exp.durationMinutes,
      Date.now(),
    );
    return id;
  } catch {
    return null;
  }
}

export function respondToCognitiveExperiment(input: {
  experimentId: string;
  response: 'accepted' | 'declined' | 'completed' | 'cancelled';
  note?: string;
}): { experiment: CognitiveExperiment; state: CognitiveExperimentState } {
  const rows = expireStale(loadAll());
  const idx = rows.findIndex(r => r.id === input.experimentId);
  if (idx < 0) throw new Error(`Unknown experiment: ${input.experimentId}`);

  const current = rows[idx];
  if (input.response === 'accepted' && current.status !== 'offered') {
    throw new Error('Only offered experiments can be accepted.');
  }
  if (input.response === 'declined' && current.status !== 'offered') {
    throw new Error('Only offered experiments can be declined.');
  }
  if ((input.response === 'completed' || input.response === 'cancelled') && current.status !== 'accepted') {
    throw new Error('Only accepted experiments can be completed or cancelled.');
  }

  let next: CognitiveExperiment = {
    ...current,
    status: input.response,
    respondedAt: nowIso(),
    notes: input.note?.trim() || current.notes,
  };

  if (input.response === 'accepted') {
    next = {
      ...next,
      expiresAt: addDaysIso(EXPERIMENT_RUN_DAYS),
      softWatchId: insertSoftWatchForExperiment(next),
    };
  }

  if (input.response === 'declined' || input.response === 'cancelled') {
    if (current.softWatchId) {
      try {
        getDb().prepare(`
          UPDATE soft_watch_commitments
          SET status = 'dismissed'
          WHERE id = ? AND status = 'pending'
        `).run(current.softWatchId);
      } catch { /* optional */ }
    }
  }

  rows[idx] = next;
  saveAll(rows);
  return { experiment: next, state: getCognitiveExperimentState() };
}

/**
 * Bias consumed by next-day planner when an experiment is accepted.
 * Declined / none → inactive zero-bias.
 */
export function getPlannerExperimentBias(): PlannerExperimentBias {
  const { active } = getCognitiveExperimentState();
  if (!active) {
    return {
      active: false,
      kind: null,
      taskId: null,
      taskTitle: null,
      preferredActivationMinutes: null,
      syntheticDueDate: null,
      guidance: null,
      scoreBoost: 0,
    };
  }

  if (active.kind === 'activation_block') {
    return {
      active: true,
      kind: active.kind,
      taskId: active.suggestedTaskId,
      taskTitle: active.suggestedTaskTitle,
      preferredActivationMinutes: active.durationMinutes || 15,
      syntheticDueDate: null,
      guidance: `Light experiment active: start with a ${active.durationMinutes || 15}m activation block${active.suggestedTaskTitle ? ` on "${active.suggestedTaskTitle}"` : ''}. Goal is ignition, not completion.`,
      scoreBoost: 40,
    };
  }

  return {
    active: true,
    kind: active.kind,
    taskId: active.suggestedTaskId,
    taskTitle: active.suggestedTaskTitle,
    preferredActivationMinutes: null,
    syntheticDueDate: active.syntheticDueDate,
    guidance: `Light experiment active: early synthetic deadline${active.syntheticDueDate ? ` (${active.syntheticDueDate})` : ''}${active.suggestedTaskTitle ? ` for "${active.suggestedTaskTitle}"` : ''}. Schedule commitment before real crisis.`,
    scoreBoost: 48,
  };
}

export function formatExperimentForPrompt(state?: CognitiveExperimentState): string {
  const s = state ?? getCognitiveExperimentState();
  if (s.active) {
    return `Active rewiring experiment (${s.active.kind}): ${s.active.title}. ${s.active.rationale} Status: accepted until ${s.active.expiresAt}.`;
  }
  if (s.offered) {
    return `Offered rewiring experiment (${s.offered.kind}): ${s.offered.title}. ${s.offered.rationale} Awaiting user accept/decline.`;
  }
  return 'No active rewiring experiment.';
}

/**
 * Ensure an offer exists when traits support one (for Brain Map GET).
 * Does not force-replace declined cooldowns.
 */
export function ensureCognitiveExperimentOffer(traits?: CognitiveTraitBundle): CognitiveExperimentState {
  const state = getCognitiveExperimentState();
  if (!state.canOffer) return state;
  proposeCognitiveExperiment({ traits });
  return getCognitiveExperimentState();
}
