import { getDb } from './db';
import { deleteCalendarEvent } from './google-calendar';

export type PlanningInvalidationReason =
  | 'stale_source_date'
  | 'constraint_misclassified'
  | 'missing_task'
  | 'invalid_provenance'
  | 'malformed_timing'
  | 'focus_overlap'
  | 'expired_unstarted';

export interface PlanningReconciliationOutcome {
  planDate: string;
  repairedSessionIds: string[];
  repairedConstraintIds: string[];
  reasonCodes: PlanningInvalidationReason[];
  calendarDeletionFailures: string[];
  regenerated: boolean;
}

interface ReconcileOptions {
  regenerate?: boolean;
}

function istDate(now = new Date()): string {
  return new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
}

interface PlanRow {
  id: number;
  plan_date: string;
  source_checkin_id: number | null;
  generation_source: string;
  tomorrow_intention: string | null;
  evening_notes: string | null;
  applies_to_plan_date: string | null;
  checkin_text: string | null;
}

interface SessionRow {
  id: string;
  task_id: number | null;
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  soft_watch_id: string | null;
  calendar_event_id: string | null;
  calendar_status: string;
  status: string;
  task_exists: number;
  task_status: string | null;
  origin: string;
}

interface ConstraintRow {
  id: string;
  start_time: string;
  end_time: string;
  source_text: string;
  source_checkin_id: number | null;
}

function validRange(startValue: string, endValue: string): { start: Date; end: Date } | null {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  return { start, end };
}

function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && a.end > b.start;
}

function uniqueReasons(reasons: PlanningInvalidationReason[]): PlanningInvalidationReason[] {
  return Array.from(new Set(reasons));
}

export async function reconcilePlanningState(
  planDate: string,
  now = new Date(),
  options: ReconcileOptions = {},
): Promise<PlanningReconciliationOutcome> {
  const db = getDb();
  const repairedSessionIds: string[] = [];
  const repairedConstraintIds: string[] = [];
  const reasons: PlanningInvalidationReason[] = [];
  let invalidatedPlan = false;

  const plan = db.prepare(`
    SELECT dp.*, dc.applies_to_plan_date,
           trim(COALESCE(dc.tomorrow_intention, '') || char(10) || COALESCE(dc.day_events, '') || char(10) || COALESCE(dc.raw_transcript, '')) AS checkin_text
    FROM daily_plans dp
    LEFT JOIN daily_checkins dc ON dc.id = dp.source_checkin_id
    WHERE dp.plan_date = ? AND dp.status != 'archived'
    LIMIT 1
  `).get(planDate) as PlanRow | undefined;

  if (plan) {
    const staleSource = Boolean(
      (plan.source_checkin_id && plan.applies_to_plan_date !== plan.plan_date)
      || (
        plan.generation_source === 'legacy'
        && !plan.source_checkin_id
        && Boolean(plan.tomorrow_intention || plan.evening_notes)
      )
    );
    invalidatedPlan = staleSource;

    const constraints = db.prepare(`
      SELECT id, start_time, end_time, source_text, source_checkin_id
      FROM plan_constraints
      WHERE plan_id = ? AND status = 'active'
      ORDER BY start_time
    `).all(plan.id) as ConstraintRow[];

    const validConstraints: Array<ConstraintRow & { range: { start: Date; end: Date } }> = [];
    for (const constraint of constraints) {
      const range = validRange(constraint.start_time, constraint.end_time);
      const grounded = !plan.source_checkin_id
        ? false
        : constraint.source_checkin_id === plan.source_checkin_id
          && Boolean(constraint.source_text.trim())
          && Boolean(plan.checkin_text?.includes(constraint.source_text.trim()));
      if (staleSource || !range || !grounded) {
        repairedConstraintIds.push(constraint.id);
        reasons.push(staleSource ? 'stale_source_date' : !range ? 'malformed_timing' : 'invalid_provenance');
      } else {
        validConstraints.push({ ...constraint, range });
      }
    }

    const sessions = db.prepare(`
      SELECT pfs.*,
             CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS task_exists,
             t.status AS task_status
      FROM planned_focus_sessions pfs
      LEFT JOIN tasks t ON t.id = pfs.task_id
      WHERE pfs.plan_id = ? AND pfs.status = 'planned'
      ORDER BY pfs.planned_start
    `).all(plan.id) as SessionRow[];

    const repairs: Array<{ row: SessionRow; status: 'cancelled' | 'skipped'; reason: PlanningInvalidationReason }> = [];
    const acceptedRanges: Array<{ start: Date; end: Date }> = [];
    for (const row of sessions) {
      const range = validRange(row.planned_start, row.planned_end);
      let reason: PlanningInvalidationReason | null = null;
      let status: 'cancelled' | 'skipped' = 'cancelled';
      if (staleSource) reason = 'stale_source_date';
      else if (!row.task_id || !row.task_exists || !['todo', 'doing'].includes(row.task_status || '')) reason = 'missing_task';
      else if (!['legacy', 'ai_existing_task', 'ai_proposed_task', 'deterministic_task', 'manual'].includes(row.origin)) reason = 'invalid_provenance';
      else if (!range || Math.abs((range.end.getTime() - range.start.getTime()) / 60_000 - row.duration_minutes) > 1) reason = 'malformed_timing';
      else if (validConstraints.some(constraint => overlaps(range, constraint.range))) reason = 'constraint_misclassified';
      else if (acceptedRanges.some(existing => overlaps(range, existing))) reason = 'focus_overlap';
      else if (range.end <= now) {
        reason = 'expired_unstarted';
        status = 'skipped';
      }
      if (!reason && range) acceptedRanges.push(range);
      if (reason) repairs.push({ row, status, reason });
    }

    db.transaction(() => {
      for (const constraintId of repairedConstraintIds) {
        db.prepare(`
          UPDATE plan_constraints
          SET status = 'cancelled', updated_at = datetime('now','localtime')
          WHERE id = ? AND status = 'active'
        `).run(constraintId);
      }

      for (const repair of repairs) {
        const changed = db.prepare(`
          UPDATE planned_focus_sessions
          SET status = ?, invalidated_reason = ?, invalidated_at = ?,
              updated_at = datetime('now','localtime')
          WHERE id = ? AND status = 'planned'
        `).run(repair.status, repair.reason, now.toISOString(), repair.row.id);
        if (!changed.changes) continue;
        repairedSessionIds.push(repair.row.id);
        reasons.push(repair.reason);
        if (repair.row.soft_watch_id) {
          db.prepare(`
            UPDATE soft_watch_commitments
            SET status = 'dismissed'
            WHERE id = ? AND status IN ('pending','active')
          `).run(repair.row.soft_watch_id);
        }
        db.prepare(`
          UPDATE coaching_commitments
          SET state = 'cancelled', updated_at = ?
          WHERE state IN ('scheduled','due','missed','rescheduled')
            AND (
              (source_type = 'planned_focus' AND source_id = ?)
              OR (source_type = 'soft_watch' AND source_id = ?)
            )
        `).run(now.toISOString(), repair.row.id, repair.row.soft_watch_id ?? '');
      }
    })();
  }

  const pendingCalendarDeletes = db.prepare(`
    SELECT pfs.id, pfs.calendar_event_id
    FROM planned_focus_sessions pfs
    JOIN daily_plans dp ON dp.id = pfs.plan_id
    WHERE dp.plan_date = ?
      AND pfs.status IN ('cancelled','skipped')
      AND pfs.calendar_event_id IS NOT NULL
      AND pfs.calendar_status != 'deleted'
  `).all(planDate) as Array<{ id: string; calendar_event_id: string }>;
  const calendarDeletionFailures: string[] = [];
  for (const pending of pendingCalendarDeletes) {
    const deleted = await deleteCalendarEvent(pending.calendar_event_id);
    db.prepare(`
      UPDATE planned_focus_sessions
      SET calendar_status = ?, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(deleted ? 'deleted' : 'failed', pending.id);
    if (!deleted) calendarDeletionFailures.push(pending.id);
  }

  let regenerated = false;
  if (invalidatedPlan && options.regenerate !== false) {
    const today = istDate(now);
    if (planDate >= today) {
      const { generateNextDayPlan } = await import('./next-day-planner');
      await generateNextDayPlan({ planDate, regenerate: true, syncCalendar: false });
      regenerated = true;
    }
  }

  return {
    planDate,
    repairedSessionIds,
    repairedConstraintIds,
    reasonCodes: uniqueReasons(reasons),
    calendarDeletionFailures,
    regenerated,
  };
}

export async function reconcileActivePlanningState(
  now = new Date(),
  options: ReconcileOptions = {},
): Promise<PlanningReconciliationOutcome[]> {
  const today = istDate(now);
  const dates = getDb().prepare(`
    SELECT plan_date
    FROM daily_plans
    WHERE status != 'archived' AND plan_date >= ?
    ORDER BY plan_date
  `).all(today) as Array<{ plan_date: string }>;
  const outcomes: PlanningReconciliationOutcome[] = [];
  for (const row of dates) {
    outcomes.push(await reconcilePlanningState(row.plan_date, now, options));
  }
  return outcomes;
}
