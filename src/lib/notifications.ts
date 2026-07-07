import { getDb, getSetting } from './db';
import { sendTelegram, formatAlert, ALERT_KEYBOARD } from './telegram';
import { getGuardianContext } from './guardian-runtime';
import { getIntelligenceProfile, touchIntelligence } from './intelligence';
import { getAdaptiveBands } from './adaptive-bands';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { buildPersonalizationSnapshot, formatPersonalizationContext } from './personalization-context';
import { recordExplicitFeedbackLearning } from './feedback-learning';

// ============================================================
//  NOTIFICATION ENGINE — Real-time alerts + email via Resend
// ============================================================

export type AlertType =
    | 'cognitive_load'
    | 'focus_drop'
    | 'habit_streak'
    | 'midday_checkin'
    | 'goal_gradient'
    | 'goal_deadline'
    | 'task_reminder'
    | 'task_overdue'
    | 'efficacy_drop'
    | 'weekly_review'
    | 'habit_levelup'
    | 'goal_conflict'
    | 'evening_planner';

export type Severity = 'info' | 'warning' | 'urgent';

export interface Alert {
    id: number;
    type: string;
    message: string;
    severity: Severity;
    read: number;
    emailed: number;
    outcome_id: number | null;
    feedback: 'helpful' | 'not_helpful' | 'dismissed' | null;
    feedback_reason: string | null;
    feedback_at: string | null;
    adaptive_reason: string | null;
    created_at: string;
}

export type AlertFeedback = 'helpful' | 'not_helpful' | 'dismissed';

interface AdaptiveAlertOptions {
    /**
     * A stable key for per-entity alerts. Example: task_due_today_42.
     * Defaults to the alert type.
     */
    key?: string;
    context?: Record<string, unknown>;
    skipAiRewrite?: boolean;
}

interface AlertDecision {
    shouldSend: boolean;
    typeKey: string;
    message: string;
    severity: Severity;
    dedupMinutes: number;
    reason: string;
}

// Dedup window — don't fire the same alert type within this many minutes
const DEDUP_MINUTES: Record<string, number> = {
    cognitive_load: 60,
    focus_drop: 30,
    habit_streak: 120,
    midday_checkin: 120,
    goal_gradient: 240,
    goal_deadline: 720,
    task_reminder: 360,
    task_overdue: 720,
    efficacy_drop: 1440,
    weekly_review: 10080,
    habit_levelup: 1440,
    goal_conflict: 1440,
    evening_planner: 1440,
};

const IST_OFFSET_MS = 19_800_000;

function getIstNow(): Date {
    return new Date(Date.now() + IST_OFFSET_MS);
}

function scoreEmoji(score: number): string {
    if (score >= 85) return 'strong';
    if (score >= 70) return 'steady';
    if (score >= 55) return 'wobbly';
    return 'low';
}

function compactList(items: string[], max = 2): string {
    const clean = items.map(s => s.trim()).filter(Boolean);
    if (clean.length === 0) return '';
    const shown = clean.slice(0, max).join(', ');
    return clean.length > max ? `${shown}, +${clean.length - max} more` : shown;
}

function computeAdaptiveDedupMinutes(type: AlertType, severity: Severity, recentAlertCount: number): number {
    const base = DEDUP_MINUTES[type] || 60;
    const fatigueMultiplier = recentAlertCount >= 5 ? 2 : recentAlertCount >= 3 ? 1.5 : 1;
    const severityMultiplier = severity === 'urgent' ? 0.75 : severity === 'info' ? 1.25 : 1;
    return Math.max(20, Math.round(base * fatigueMultiplier * severityMultiplier));
}

function getRecentAlertCount(hours = 2): number {
    try {
        const db = getDb();
        return (db.prepare(`
            SELECT COUNT(*) as c FROM alerts
            WHERE created_at >= datetime('now', ?)
        `).get(`-${hours} hours`) as { c: number }).c;
    } catch {
        return 0;
    }
}

function getAlertFeedbackStats(type: AlertType): {
    rated: number;
    helpfulRate: number | null;
    notHelpful: number;
    dismissed: number;
} {
    try {
        const rows = getDb().prepare(`
            SELECT helpful, actual_outcome
            FROM agent_action_outcomes
            WHERE action_type = ?
              AND created_at >= datetime('now', '-30 days')
              AND (helpful IS NOT NULL OR actual_outcome LIKE '%"feedback":"dismissed"%')
        `).all(`alert:${type}`) as Array<{ helpful: number | null; actual_outcome: string | null }>;
        const ratedRows = rows.filter(row => row.helpful !== null);
        const helpfulRate = ratedRows.length
            ? ratedRows.reduce((sum, row) => sum + (row.helpful ? 1 : 0), 0) / ratedRows.length
            : null;
        return {
            rated: ratedRows.length,
            helpfulRate,
            notHelpful: ratedRows.filter(row => row.helpful === 0).length,
            dismissed: rows.filter(row => row.actual_outcome?.includes('"feedback":"dismissed"')).length,
        };
    } catch {
        return { rated: 0, helpfulRate: null, notHelpful: 0, dismissed: 0 };
    }
}

function getTodayMicroContext(): {
    hour: number;
    date: string;
    openTasks: number;
    overdueTasks: number;
    uncheckedHabitCount: number;
    todayEvents: string[];
    plannedSessionsToday: Array<{ id: string; taskId: number | null; title: string; start: string; durationMinutes: number; status: string }>;
    plannedSessionsTomorrow: Array<{ id: string; taskId: number | null; title: string; start: string; durationMinutes: number; status: string }>;
    recentDistractionMinutes: number;
} {
    const db = getDb();
    const nowIst = getIstNow();
    const date = nowIst.toISOString().slice(0, 10);
    const hour = nowIst.getHours();

    let openTasks = 0;
    let overdueTasks = 0;
    let uncheckedHabitCount = 0;
    let todayEvents: string[] = [];
    let plannedSessionsToday: Array<{ id: string; taskId: number | null; title: string; start: string; durationMinutes: number; status: string }> = [];
    let plannedSessionsTomorrow: Array<{ id: string; taskId: number | null; title: string; start: string; durationMinutes: number; status: string }> = [];
    let recentDistractionMinutes = 0;

    try {
        openTasks = (db.prepare(
            "SELECT COUNT(*) as c FROM tasks WHERE status IN ('todo', 'doing')"
        ).get() as { c: number }).c;
    } catch { /* optional table */ }

    try {
        overdueTasks = (db.prepare(`
            SELECT COUNT(*) as c FROM tasks
            WHERE status NOT IN ('done','cancelled') AND due_date < date('now')
        `).get() as { c: number }).c;
    } catch { /* optional table */ }

    try {
        uncheckedHabitCount = (db.prepare(`
            SELECT COUNT(*) as c FROM habits h
            WHERE h.archived = 0
            AND h.id NOT IN (
              SELECT habit_id FROM habit_checkins WHERE date = ? AND completed = 1
            )
        `).get(date) as { c: number }).c;
    } catch { /* optional table */ }

    try {
        todayEvents = (db.prepare(`
            SELECT title FROM calendar_events
            WHERE date(start_time, 'localtime') = ?
            ORDER BY start_time ASC LIMIT 3
        `).all(date) as { title: string }[]).map(r => r.title);
    } catch { /* calendar is optional */ }

    try {
        const tomorrow = new Date(nowIst);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const tomorrowDate = tomorrow.toISOString().slice(0, 10);
        const rows = db.prepare(`
            SELECT pfs.id,
                   pfs.task_id as taskId,
                   pfs.title,
                   pfs.planned_start as start,
                   pfs.duration_minutes as durationMinutes,
                   pfs.status,
                   dp.plan_date as planDate
            FROM planned_focus_sessions pfs
            JOIN daily_plans dp ON dp.id = pfs.plan_id
            WHERE dp.plan_date IN (?, ?)
              AND pfs.status IN ('planned','started')
            ORDER BY pfs.planned_start ASC
            LIMIT 12
        `).all(date, tomorrowDate) as Array<{
            id: string;
            taskId: number | null;
            title: string;
            start: string;
            durationMinutes: number;
            status: string;
            planDate: string;
        }>;
        plannedSessionsToday = rows
            .filter(row => row.planDate === date)
            .map(row => ({
                id: row.id,
                taskId: row.taskId,
                title: row.title,
                start: row.start,
                durationMinutes: row.durationMinutes,
                status: row.status,
            }));
        plannedSessionsTomorrow = rows
            .filter(row => row.planDate === tomorrowDate)
            .map(row => ({
                id: row.id,
                taskId: row.taskId,
                title: row.title,
                start: row.start,
                durationMinutes: row.durationMinutes,
                status: row.status,
            }));
    } catch { /* planner tables are optional during migrations */ }

    try {
        const row = db.prepare(`
            SELECT COALESCE(SUM(duration_seconds), 0) as seconds
            FROM activities
            WHERE started_at >= datetime('now', '-2 hours')
              AND category = 'distraction'
        `).get() as { seconds: number };
        recentDistractionMinutes = Math.round((row.seconds || 0) / 60);
    } catch { /* optional table */ }

    return {
        hour,
        date,
        openTasks,
        overdueTasks,
        uncheckedHabitCount,
        todayEvents,
        plannedSessionsToday,
        plannedSessionsTomorrow,
        recentDistractionMinutes,
    };
}

function formatPlannedSession(session: { title: string; start: string; durationMinutes: number }): string {
    const time = new Date(session.start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${time} ${session.title} (${session.durationMinutes}m)`;
}

function taskReminderAlreadyPlanned(
    opts: AdaptiveAlertOptions | undefined,
    sessions: Array<{ taskId: number | null; title: string; start: string; durationMinutes: number }>
): { planned: boolean; label: string | null } {
    const taskId = typeof opts?.context?.taskId === 'number' ? opts.context.taskId : null;
    const title = typeof opts?.context?.title === 'string' ? opts.context.title.toLowerCase() : '';
    const match = sessions.find(session => {
        if (taskId !== null && session.taskId === taskId) return true;
        return title.length >= 4 && session.title.toLowerCase().includes(title);
    });
    return match ? { planned: true, label: formatPlannedSession(match) } : { planned: false, label: null };
}

function deterministicAlertDecision(
    type: AlertType,
    message: string,
    severity: Severity,
    opts?: AdaptiveAlertOptions
): AlertDecision {
    const uil = getIntelligenceProfile();
    const bands = getAdaptiveBands();
    const recentAlertCount = getRecentAlertCount(2);
    const feedbackStats = getAlertFeedbackStats(type);
    const today = getTodayMicroContext();
    const { activeSession } = getGuardianContext();
    const typeKey = opts?.key || type;
    let nextMessage = message;
    let nextSeverity = severity;
    let shouldSend = true;
    const reasons: string[] = [];

    const inPeakWindow = uil.peakFocusHours.includes(today.hour);
    const activeFocusScore = activeSession?.focusScoreHistory?.slice(-1)[0] ?? null;
    const focusedNow = activeFocusScore !== null && activeFocusScore >= bands.focusGood;
    const overloadedDay = today.overdueTasks > 0 || today.openTasks >= uil.adaptiveThresholds.cognitiveLoadThreshold;
    const lowEnergy = uil.currentEnergyEstimate === 'low' || uil.moodToday === 'low';
    const taskAlreadyPlanned = taskReminderAlreadyPlanned(opts, today.plannedSessionsToday);

    if (recentAlertCount >= 5 && nextSeverity === 'info') {
        shouldSend = false;
        reasons.push('suppressed info alert because recent alert volume is high');
    }

    if (feedbackStats.rated >= 3 && feedbackStats.helpfulRate !== null && feedbackStats.helpfulRate < 0.35) {
        if (nextSeverity === 'info') {
            shouldSend = false;
            reasons.push(`suppressed because recent ${type} alerts were rarely useful`);
        } else if (nextSeverity === 'warning') {
            nextSeverity = 'info';
            reasons.push(`softened because recent ${type} alerts were rarely useful`);
        }
    }

    if (feedbackStats.dismissed >= 3 && nextSeverity === 'info') {
        shouldSend = false;
        reasons.push(`suppressed because ${type} alerts are often dismissed`);
    }

    if (focusedNow && nextSeverity !== 'urgent' && ['habit_streak', 'midday_checkin', 'goal_gradient'].includes(type)) {
        shouldSend = false;
        reasons.push(`suppressed while guardian focus is ${scoreEmoji(activeFocusScore)}`);
    }

    if (inPeakWindow && nextSeverity === 'info' && !overloadedDay) {
        shouldSend = false;
        reasons.push('suppressed low-urgency alert during a personal peak-focus hour');
    }

    if (type === 'midday_checkin' && uil.standupGoalToday) {
        nextMessage = `Mid-day pulse: you said today is about "${uil.standupGoalToday}". ${uil.currentNarrative || 'Want to protect the next focused block?'}`;
        reasons.push('anchored check-in to today standup goal');
    }

    if (type === 'habit_streak' && lowEnergy) {
        nextMessage = `${message} Keep it tiny today: one minimum viable rep is enough.`;
        reasons.push('low energy/mood changed habit alert to minimum viable action');
    }

    if (type === 'cognitive_load' && today.overdueTasks > 0) {
        nextMessage = `${message} You also have ${today.overdueTasks} overdue task${today.overdueTasks > 1 ? 's' : ''}; clear the smallest one first.`;
        reasons.push('added overdue-task context');
    }

    if (type === 'focus_drop' && uil.standupGoalToday) {
        nextMessage = `${message} The thing to return to is "${uil.standupGoalToday}".`;
        reasons.push('linked focus drop to stated day priority');
    }

    if (today.todayEvents.length > 0 && (type === 'task_reminder' || type === 'goal_deadline')) {
        nextMessage = `${nextMessage} Calendar today: ${compactList(today.todayEvents)}.`;
        reasons.push('added calendar pressure context');
    }

    if (type === 'task_reminder' && lowEnergy && nextSeverity === 'warning') {
        nextSeverity = 'info';
        reasons.push('softened warning because current energy estimate is low');
    }

    if (type === 'task_reminder' && taskAlreadyPlanned.planned && taskAlreadyPlanned.label) {
        if (nextSeverity === 'info') {
            shouldSend = false;
            reasons.push(`suppressed because task is already planned today at ${taskAlreadyPlanned.label}`);
        } else {
            nextMessage = `${nextMessage} It is already on today's focus plan: ${taskAlreadyPlanned.label}.`;
            reasons.push('linked task reminder to planned focus session');
        }
    }

    if (type === 'midday_checkin' && today.plannedSessionsToday.length > 0) {
        nextMessage = `${nextMessage} Next planned block: ${formatPlannedSession(today.plannedSessionsToday[0])}.`;
        reasons.push('added next planned focus block');
    }

    if (type === 'evening_planner') {
        if (today.plannedSessionsTomorrow.length > 0) {
            nextMessage = `Tomorrow already has ${today.plannedSessionsTomorrow.length} planned focus block${today.plannedSessionsTomorrow.length === 1 ? '' : 's'}. Review sleep/wake and adjust if tonight changed. First: ${formatPlannedSession(today.plannedSessionsTomorrow[0])}.`;
            reasons.push('evening reminder anchored to existing next-day plan');
        } else if (lowEnergy) {
            nextMessage = 'Evening planning check: energy looks low, so tomorrow should start lighter. Send sleep time, wake estimate, mood, and the one thing worth protecting.';
            reasons.push('low energy changed evening reminder to recovery planning');
        } else if (overloadedDay) {
            nextMessage = `Evening planning check: ${today.openTasks} open task${today.openTasks === 1 ? '' : 's'} are still in the system. Send sleep/wake plus tomorrow's top time target so I can schedule blocks.`;
            reasons.push('open-task pressure changed evening reminder');
        }
    }

    const dedupMinutes = computeAdaptiveDedupMinutes(type, nextSeverity, recentAlertCount);
    if (recentAlertCount >= 3) reasons.push(`extended dedup from alert fatigue (${recentAlertCount} alerts in 2h)`);
    const feedbackDedupMinutes = feedbackStats.notHelpful >= 2 || feedbackStats.dismissed >= 3
        ? Math.round(dedupMinutes * 1.5)
        : dedupMinutes;
    if (feedbackDedupMinutes !== dedupMinutes) {
        reasons.push('extended dedup from past alert feedback');
    }

    return {
        shouldSend,
        typeKey,
        message: nextMessage,
        severity: nextSeverity,
        dedupMinutes: feedbackDedupMinutes,
        reason: reasons.join('; ') || 'sent with adaptive defaults',
    };
}

export function composeEveningPlanningReminder(): { shouldSend: boolean; message: string; reason: string } {
    const decision = deterministicAlertDecision(
        'evening_planner',
        'Evening planning check: send sleep time, wake estimate, mood, anything that affected today, and what you want to do tomorrow.',
        'info',
        { key: 'evening_planner_reminder', skipAiRewrite: true }
    );
    return {
        shouldSend: decision.shouldSend,
        message: decision.message,
        reason: decision.reason,
    };
}

async function rewriteAlertWithAi(
    type: AlertType,
    decision: AlertDecision,
    opts?: AdaptiveAlertOptions
): Promise<AlertDecision> {
    if (opts?.skipAiRewrite || !decision.shouldSend) return decision;
    if (decision.severity === 'info' && type !== 'midday_checkin') return decision;

    try {
        const ai = getGenAI();
        const { activeSession } = getGuardianContext();
        const activeFocusScore = activeSession?.focusScoreHistory?.slice(-1)[0] ?? null;
        const personalization = buildPersonalizationSnapshot({
            surface: 'notification',
            maxInsights: 2,
            includeThresholds: true,
            includeMemoryFacts: 5,
            activeSession: activeSession ? {
                sessionId: activeSession.sessionId,
                targetTitle: activeSession.targetTitle,
                focusScore: activeFocusScore,
                elapsedMinutes: Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60000)),
            } : null,
        });
        const contextBlock = formatPersonalizationContext(personalization);
        const result = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: `Rewrite this LifeOS notification so it is specific to the user's actual day and not generic.

Rules:
- Return ONLY JSON: {"message":"...","severity":"info|warning|urgent"}
- Max 220 characters.
- Keep the concrete fact that triggered the alert.
- Do not be dramatic.
- Do not invent facts.
- Make the ask fit their current energy and workload.

Alert type: ${type}
Current severity: ${decision.severity}
Current message: ${decision.message}
Decision reason: ${decision.reason}
Extra context: ${JSON.stringify(opts?.context ?? {})}

${contextBlock}`,
            config: { responseMimeType: 'application/json', temperature: 0.2 },
        });
        const parsed = JSON.parse((result.text || '').trim()) as { message?: string; severity?: Severity };
        if (!parsed.message || parsed.message.length > 260) return decision;
        return {
            ...decision,
            message: parsed.message,
            severity: parsed.severity === 'info' || parsed.severity === 'warning' || parsed.severity === 'urgent'
                ? parsed.severity
                : decision.severity,
            reason: `${decision.reason}; ai_personalized`,
        };
    } catch (err) {
        console.warn('[Alert] AI rewrite skipped:', err);
        return decision;
    }
}

/**
 * Send an alert — stores in DB + optionally emails via Resend.
 * Automatically deduplicates within the configured window.
 */
export async function sendAlert(
    type: AlertType,
    message: string,
    severity: Severity = 'info',
    opts?: AdaptiveAlertOptions
): Promise<boolean> {
    const db = getDb();
    const deterministic = deterministicAlertDecision(type, message, severity, opts);
    const decision = await rewriteAlertWithAi(type, deterministic, opts);

    if (!decision.shouldSend) {
        console.log(`[Alert] Suppressed ${decision.typeKey}: ${decision.reason}`);
        touchIntelligence(`alert_suppressed:${type}`);
        return false;
    }

    // Dedup check: has this alert type been sent recently?
    const recent = db.prepare(`
    SELECT id FROM alerts 
    WHERE type = ? AND created_at >= datetime('now', '-${decision.dedupMinutes} minutes')
    LIMIT 1
  `).get(decision.typeKey);

    if (recent) return false; // Already alerted recently

    const outcome = db.prepare(`
        INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, helpful)
        VALUES (?, ?, ?, NULL)
    `).run(
        `alert:${type}`,
        JSON.stringify({
            typeKey: decision.typeKey,
            severity: decision.severity,
            message: decision.message,
            adaptiveReason: decision.reason,
            context: opts?.context ?? null,
        }),
        JSON.stringify({ status: 'sent', channel: decision.severity === 'info' ? 'in_app' : 'telegram_email_candidate' }),
    );

    // Store in DB
    db.prepare(
        'INSERT INTO alerts (type, message, severity, outcome_id, adaptive_reason) VALUES (?, ?, ?, ?, ?)'
    ).run(decision.typeKey, decision.message, decision.severity, outcome.lastInsertRowid, decision.reason);

    console.log(`[Alert] ${decision.severity.toUpperCase()}: ${decision.typeKey} — ${decision.message} (${decision.reason})`);
    touchIntelligence(`alert_sent:${type}`);

    // Notify via Telegram + email for warning/urgent alerts
    if (decision.severity !== 'info') {
        void sendTelegram(formatAlert(type, decision.message, decision.severity), 'HTML', ALERT_KEYBOARD);
        await trySendEmail(type, decision.message, decision.severity, decision.typeKey);
    }

    return true;
}

/**
 * Get unread alerts, most recent first.
 */
export function getUnreadAlerts(limit: number = 20): Alert[] {
    const db = getDb();
    return db.prepare(
        'SELECT * FROM alerts WHERE read = 0 ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Alert[];
}

/**
 * Get all recent alerts (read + unread).
 */
export function getRecentAlerts(limit: number = 50): Alert[] {
    const db = getDb();
    return db.prepare(
        'SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Alert[];
}

/**
 * Mark alerts as read.
 */
export function markAlertsRead(ids?: number[]): void {
    const db = getDb();
    if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE alerts SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
    } else {
        db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run();
    }
}

export function recordAlertFeedback(alertId: number, feedback: AlertFeedback, reason?: string | null): Alert | null {
    const db = getDb();
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as Alert | undefined;
    if (!alert) return null;

    const normalizedReason = reason?.trim() ? reason.trim().slice(0, 500) : null;
    db.prepare(`
        UPDATE alerts
        SET feedback = ?, feedback_reason = ?, feedback_at = datetime('now','localtime'), read = 1
        WHERE id = ?
    `).run(feedback, normalizedReason, alertId);

    if (alert.outcome_id) {
        db.prepare(`
            UPDATE agent_action_outcomes
            SET helpful = ?,
                actual_outcome = ?,
                was_corrected = CASE WHEN ? = 'not_helpful' THEN 1 ELSE was_corrected END,
                correction_text = CASE WHEN ? = 'not_helpful' THEN COALESCE(?, correction_text) ELSE correction_text END
            WHERE id = ?
        `).run(
            feedback === 'helpful' ? 1 : feedback === 'not_helpful' ? 0 : null,
            JSON.stringify({
                status: 'rated',
                feedback,
                reason: normalizedReason,
                source: 'alert_feedback',
            }),
            feedback,
            feedback,
            normalizedReason,
            alert.outcome_id,
        );
    } else {
        db.prepare(`
            INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, was_corrected, correction_text, helpful)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            `alert:${alert.type}`,
            JSON.stringify({ alertId: alert.id, severity: alert.severity, message: alert.message }),
            JSON.stringify({ status: 'rated', feedback, reason: normalizedReason, source: 'alert_feedback' }),
            feedback === 'not_helpful' ? 1 : 0,
            feedback === 'not_helpful' ? normalizedReason : null,
            feedback === 'helpful' ? 1 : feedback === 'not_helpful' ? 0 : null,
        );
    }

    recordExplicitFeedbackLearning({
        source: 'alert',
        feedback,
        reason: normalizedReason,
        surface: 'dashboard_alerts',
        subject: `${alert.type}: ${alert.message}`,
        outcomeId: alert.outcome_id ?? null,
        metadata: {
            alertId: alert.id,
            severity: alert.severity,
            read: alert.read,
        },
    });

    touchIntelligence(`alert_feedback:${feedback}`);
    return db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId) as Alert;
}

/**
 * Clear old alerts (older than 7 days).
 */
export function clearOldAlerts(): void {
    const db = getDb();
    db.prepare("DELETE FROM alerts WHERE created_at < datetime('now', '-7 days')").run();
}

/**
 * Send email via Resend if configured.
 */
async function trySendEmail(type: AlertType, message: string, severity: Severity, typeKey: string = type): Promise<void> {
    try {
        const apiKey = getSetting('resend_api_key');
        const email = getSetting('notification_email');
        const enabled = getSetting('email_alerts_enabled');

        if (!apiKey || !email || enabled === 'false') return;

        const { Resend } = await import('resend');
        const resend = new Resend(apiKey);

        const emoji = severity === 'urgent' ? '🚨' : '⚠️';
        const typeLabel = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        await resend.emails.send({
            from: 'LifeOS <onboarding@resend.dev>',
            to: email,
            subject: `${emoji} LifeOS Alert: ${typeLabel}`,
            html: `
        <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <div style="background: #1a1a2e; color: #e0e0e0; padding: 24px; border-radius: 12px; border-left: 4px solid ${severity === 'urgent' ? '#ff5555' : '#ffa500'};">
            <h2 style="margin: 0 0 12px 0; color: ${severity === 'urgent' ? '#ff5555' : '#ffa500'};">
              ${emoji} ${typeLabel}
            </h2>
            <p style="margin: 0; font-size: 15px; line-height: 1.6;">${message}</p>
            <hr style="border: none; border-top: 1px solid #333; margin: 16px 0;">
            <p style="margin: 0; font-size: 12px; color: #888;">
              Sent by LifeOS at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        </div>
      `,
        });

        // Mark as emailed
        const db = getDb();
        db.prepare(
            "UPDATE alerts SET emailed = 1 WHERE type = ? AND created_at >= datetime('now', '-1 minute')"
        ).run(typeKey);

        console.log(`[Alert] Email sent to ${email}: ${type}`);
    } catch (err) {
        console.error('[Alert] Email failed:', err);
    }
}

// ============================================================
//  WEEKLY EMAIL — Rich HTML digest sent every Sunday
// ============================================================

/**
 * Send a rich HTML weekly review email with focus trend, habit heatmap,
 * session log, and goal progress. Called by the scheduler on Sunday at 21:00.
 */
export async function sendWeeklyEmail(): Promise<void> {
    try {
        const apiKey = getSetting('resend_api_key');
        const email = getSetting('notification_email');
        const enabled = getSetting('email_alerts_enabled');
        if (!apiKey || !email || enabled === 'false') return;

        const db = getDb();
        const now = getIstNow();
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - 6);
        const weekStartStr = weekStart.toISOString().slice(0, 10);
        const todayStr = now.toISOString().slice(0, 10);

        // Focus score trend — last 7 days
        const dailyScores = db.prepare(`
            SELECT date, COALESCE(AVG(score), 0) as avg_score
            FROM daily_scores
            WHERE date >= ? AND date <= ?
            GROUP BY date ORDER BY date ASC
        `).all(weekStartStr, todayStr) as { date: string; avg_score: number }[];

        // Habit completion for the week
        const habitData = db.prepare(`
            SELECT h.name, h.icon,
                COUNT(CASE WHEN hc.completed = 1 THEN 1 END) as completed_days,
                7 as total_days
            FROM habits h
            LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date >= ?
            WHERE h.archived = 0
            GROUP BY h.id ORDER BY completed_days DESC
        `).all(weekStartStr) as { name: string; icon: string; completed_days: number; total_days: number }[];

        // Guardian sessions for the week
        const sessions = db.prepare(`
            SELECT target_title, elapsed_minutes, average_focus_score, completed_at
            FROM guardian_session_summaries
            WHERE completed_at >= datetime(?, 'localtime')
            ORDER BY completed_at DESC LIMIT 10
        `).all(weekStartStr) as { target_title: string; elapsed_minutes: number; average_focus_score: number; completed_at: string }[];

        // Goals progress
        const goals = db.prepare(`
            SELECT g.title,
                COUNT(CASE WHEN t.status = 'done' THEN 1 END) as done,
                COUNT(t.id) as total
            FROM goals g LEFT JOIN tasks t ON t.goal_id = g.id
            WHERE g.active = 1
            GROUP BY g.id ORDER BY done DESC LIMIT 5
        `).all() as { title: string; done: number; total: number }[];

        // Weekly totals
        const weekStats = db.prepare(`
            SELECT
                COALESCE(SUM(CASE WHEN category = 'productive' THEN duration_seconds END), 0) as prod,
                COALESCE(SUM(CASE WHEN category = 'distraction' THEN duration_seconds END), 0) as dist
            FROM activities WHERE date(started_at, 'localtime') >= ?
        `).get(weekStartStr) as { prod: number; dist: number };

        const totalSessions = sessions.length;
        const avgScore = sessions.length
            ? Math.round(sessions.reduce((s, r) => s + r.average_focus_score, 0) / sessions.length)
            : 0;
        const totalFocusMin = sessions.reduce((s, r) => s + r.elapsed_minutes, 0);
        const avgScoreIcon = avgScore >= 85 ? '🔥' : avgScore >= 70 ? '✅' : avgScore >= 55 ? '🟡' : '🔴';

        // Build focus trend bars
        const trendBars = dailyScores.map(d => {
            const score = Math.round(d.avg_score);
            const barWidth = Math.round((score / 100) * 120);
            const color = score >= 85 ? '#4CAF50' : score >= 70 ? '#8BC34A' : score >= 55 ? '#FFC107' : '#F44336';
            const label = new Date(d.date).toLocaleDateString('en-IN', { weekday: 'short' });
            return `
                <tr>
                    <td style="color:#999;font-size:12px;padding:3px 8px 3px 0;white-space:nowrap;">${label}</td>
                    <td style="padding:3px 0;">
                        <div style="background:${color};height:18px;width:${barWidth}px;border-radius:3px;display:inline-block;"></div>
                        <span style="color:#ccc;font-size:12px;margin-left:6px;">${score}</span>
                    </td>
                </tr>`;
        }).join('');

        // Build habit rows
        const habitRows = habitData.slice(0, 8).map(h => {
            const pct = Math.round((h.completed_days / 7) * 100);
            const color = pct >= 85 ? '#4CAF50' : pct >= 50 ? '#FFC107' : '#F44336';
            const dots = Array.from({ length: 7 }, (_, i) => {
                // We can't get per-day data easily here, so just fill based on count
                const filled = i < h.completed_days;
                return `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${filled ? color : '#333'};margin:1px;"></span>`;
            }).join('');
            return `
                <tr>
                    <td style="color:#e0e0e0;font-size:13px;padding:4px 10px 4px 0;">${h.icon} ${h.name}</td>
                    <td style="padding:4px 0;">${dots}</td>
                    <td style="color:#999;font-size:12px;padding:4px 0 4px 8px;">${h.completed_days}/7</td>
                </tr>`;
        }).join('');

        // Build session rows
        const sessionRows = sessions.slice(0, 6).map(s => {
            const score = Math.round(s.average_focus_score);
            const scoreColor = score >= 85 ? '#4CAF50' : score >= 70 ? '#8BC34A' : score >= 55 ? '#FFC107' : '#F44336';
            const dateStr = new Date(s.completed_at).toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });
            return `
                <tr>
                    <td style="color:#e0e0e0;font-size:13px;padding:4px 10px 4px 0;">${s.target_title}</td>
                    <td style="color:#999;font-size:12px;padding:4px 8px;">${s.elapsed_minutes}m</td>
                    <td style="color:${scoreColor};font-size:13px;font-weight:bold;padding:4px 0;">${score}/100</td>
                    <td style="color:#666;font-size:11px;padding:4px 0 4px 8px;">${dateStr}</td>
                </tr>`;
        }).join('');

        // Build goal progress bars
        const goalRows = goals.map(g => {
            const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
            const barWidth = Math.round((pct / 100) * 200);
            const color = pct >= 75 ? '#4CAF50' : pct >= 40 ? '#FFC107' : '#666';
            return `
                <tr>
                    <td style="color:#e0e0e0;font-size:13px;padding:6px 10px 6px 0;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${g.title}">${g.title}</td>
                    <td style="padding:6px 0;">
                        <div style="background:#333;border-radius:4px;height:10px;width:200px;">
                            <div style="background:${color};height:10px;width:${barWidth}px;border-radius:4px;"></div>
                        </div>
                    </td>
                    <td style="color:#999;font-size:12px;padding:6px 0 6px 8px;white-space:nowrap;">${g.done}/${g.total}</td>
                </tr>`;
        }).join('');

        const prodH = Math.floor((weekStats?.prod ?? 0) / 3600);
        const prodM = Math.floor(((weekStats?.prod ?? 0) % 3600) / 60);

        const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,system-ui,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1a1a3e,#1a2a1e);border-radius:16px;padding:28px;margin-bottom:20px;border:1px solid #2a2a4a;">
      <h1 style="margin:0 0 6px 0;font-size:22px;color:#fff;">📊 Weekly Review</h1>
      <p style="margin:0;color:#888;font-size:14px;">${weekStartStr} → ${todayStr}</p>
      <div style="margin-top:20px;display:flex;gap:24px;flex-wrap:wrap;">
        <div>
          <div style="font-size:28px;font-weight:bold;color:#fff;">${avgScoreIcon} ${avgScore}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">avg focus score</div>
        </div>
        <div>
          <div style="font-size:28px;font-weight:bold;color:#7c9fff;">${totalSessions}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">guardian sessions</div>
        </div>
        <div>
          <div style="font-size:28px;font-weight:bold;color:#9fff9f;">${totalFocusMin}m</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">total focus time</div>
        </div>
        <div>
          <div style="font-size:28px;font-weight:bold;color:#ffcf7f;">${prodH}h ${prodM}m</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">productive time</div>
        </div>
      </div>
    </div>

    <!-- Focus Trend -->
    ${trendBars ? `
    <div style="background:#111120;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #22224a;">
      <h2 style="margin:0 0 16px 0;font-size:15px;color:#bbb;font-weight:600;">📈 FOCUS TREND</h2>
      <table style="border-collapse:collapse;width:100%;">${trendBars}</table>
    </div>` : ''}

    <!-- Habit Heatmap -->
    ${habitRows ? `
    <div style="background:#111120;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #22224a;">
      <h2 style="margin:0 0 16px 0;font-size:15px;color:#bbb;font-weight:600;">💪 HABIT COMPLETION</h2>
      <table style="border-collapse:collapse;width:100%;">${habitRows}</table>
    </div>` : ''}

    <!-- Sessions Log -->
    ${sessionRows ? `
    <div style="background:#111120;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #22224a;">
      <h2 style="margin:0 0 16px 0;font-size:15px;color:#bbb;font-weight:600;">🛡️ GUARDIAN SESSIONS</h2>
      <table style="border-collapse:collapse;width:100%;">${sessionRows}</table>
    </div>` : ''}

    <!-- Goal Progress -->
    ${goalRows ? `
    <div style="background:#111120;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #22224a;">
      <h2 style="margin:0 0 16px 0;font-size:15px;color:#bbb;font-weight:600;">🎯 GOAL PROGRESS</h2>
      <table style="border-collapse:collapse;width:100%;">${goalRows}</table>
    </div>` : ''}

    <!-- Footer -->
    <div style="text-align:center;padding:16px;color:#444;font-size:12px;">
      LifeOS Guardian · Weekly Review · ${todayStr}
    </div>
  </div>
</body>
</html>`;

        const { Resend } = await import('resend');
        const resend = new Resend(apiKey);
        await resend.emails.send({
            from: 'LifeOS <onboarding@resend.dev>',
            to: email,
            subject: `📊 LifeOS Weekly Review — ${weekStartStr} to ${todayStr}`,
            html,
        });
        console.log('[Notifications] Weekly email sent to', email);
    } catch (err) {
        console.error('[Notifications] Weekly email failed:', err);
    }
}

// ============================================================
//  ALERT TRIGGER ENGINE — Runs every 5 minutes
// ============================================================

/**
 * Run all alert checks. Called by scheduler every 5 minutes.
 */
export async function runAlertEngine(): Promise<{ triggered: string[] }> {
    const triggered: string[] = [];
    const db = getDb();

    // Use UIL adaptive thresholds — calibrated to this user's personal baseline
    const uil = getIntelligenceProfile();
    const thresholds = uil.adaptiveThresholds;

    try {
        // 1. Cognitive Load (Zeigarnik Effect) — threshold from UIL, not hardcoded
        const openTasks = (db.prepare(
            "SELECT COUNT(*) as c FROM tasks WHERE status IN ('todo', 'doing')"
        ).get() as { c: number }).c;

        if (openTasks >= thresholds.cognitiveLoadThreshold) {
            const sent = await sendAlert(
                'cognitive_load',
                `You have ${openTasks} active tasks creating mental load. ${thresholds.cognitiveLoadAdvice || 'Consider completing a few quick ones to build momentum.'}`,
                'warning'
            );
            if (sent) triggered.push('cognitive_load');
        }

        // 2. Focus Drop — only fires during an active guardian session.
        // Browsing data is only meaningful when the guardian is watching.
        // Skip if the guardian's live focus score is > 60 — it's already intervening appropriately.
        const { activeSession } = getGuardianContext();
        if (activeSession) {
            const latestScore = activeSession.focusScoreHistory?.slice(-1)[0] ?? 0;
            const bands = getAdaptiveBands();
            if (latestScore <= bands.focusPoor) {
                const todayStats = db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN category = 'productive' THEN duration_seconds END), 0) as prod,
            COALESCE(SUM(CASE WHEN category = 'distraction' THEN duration_seconds END), 0) as dist,
            COALESCE(SUM(duration_seconds), 0) as total
          FROM activities WHERE started_at >= datetime('now', '-2 hours')
        `).get() as { prod: number; dist: number; total: number };

                if (todayStats.total > bands.dailyCapacityMinutes * 10 && todayStats.dist > todayStats.prod) {
                    const sent = await sendAlert(
                        'focus_drop',
                        `Your focus is dropping. ${thresholds.focusDropAdvice || 'Take a 5-minute breather to reset.'}`,
                        'warning'
                    );
                    if (sent) triggered.push('focus_drop');
                }
            }
        }

        // 3. Habit Streak at Risk (runs at 10am, 3pm, 8pm)
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const hour = new Date(Date.now() + 19800000).getHours();

        if (hour === 10 || hour === 15 || hour >= 20) {
            const uncheckedHabits = db.prepare(`
        SELECT h.name, h.icon FROM habits h
        WHERE h.archived = 0
        AND h.id NOT IN (
          SELECT habit_id FROM habit_checkins WHERE date = ? AND completed = 1
        )
      `).all(today) as { name: string; icon: string }[];

            if (uncheckedHabits.length > 0) {
                const names = uncheckedHabits.slice(0, 3).map(h => `${h.icon} ${h.name}`).join(', ');
                const sent = await sendAlert(
                    'habit_streak',
                    `${uncheckedHabits.length} habit(s) unchecked today: ${names}${uncheckedHabits.length > 3 ? '...' : ''}. ${thresholds.habitRiskAdvice || 'Your streak is at risk, take 2 minutes now.'}`,
                    'warning'
                );
                if (sent) triggered.push('habit_streak');
            }
        }

        // 3.5 Mid-day check-in pulse
        if (hour === 13) {
            const context = uil.currentNarrative || 'How is your focus so far today?';
            const sent = await sendAlert(
                'midday_checkin',
                `Mid-day pulse! ${context}`,
                'info'
            );
            if (sent) triggered.push('midday_checkin');
        }

        // 4. Goal Gradient — goals near completion
        const nearGoals = db.prepare(`
      SELECT g.id, g.title,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id AND status = 'done') as done,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id) as total
      FROM goals g WHERE g.active = 1
    `).all() as { id: number; title: string; done: number; total: number }[];

        for (const g of nearGoals) {
            if (g.total >= 3 && g.done > 0) {
                const progress = Math.round((g.done / g.total) * 100);
                const remaining = g.total - g.done;
                const localBands = getAdaptiveBands();
                if (progress >= localBands.goalOnTrackVelocity * 100 && remaining > 0 && remaining <= 3) {
                    const sent = await sendAlert(
                        'goal_gradient',
                        `🏁 You're ${remaining} task${remaining > 1 ? 's' : ''} away from completing "${g.title}"! Push through!`,
                        'info'
                    );
                    if (sent) triggered.push('goal_gradient');
                }
            }
        }

        // 5. Goal Deadline approaching
        const urgentGoals = db.prepare(`
      SELECT title, deadline FROM goals 
      WHERE active = 1 AND deadline IS NOT NULL 
      AND deadline <= date('now', '+3 days') AND deadline >= date('now')
    `).all() as { title: string; deadline: string }[];

        for (const g of urgentGoals) {
            const daysLeft = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86400000);
            const sent = await sendAlert(
                'goal_deadline',
                `Goal "${g.title}" is due in ${daysLeft <= 0 ? 'TODAY' : `${daysLeft} day${daysLeft > 1 ? 's' : ''}`}!`,
                daysLeft <= 1 ? 'urgent' : 'warning'
            );
            if (sent) triggered.push('goal_deadline');
        }

        // 6. Self-Efficacy Drop
        const efficacy = db.prepare(`
      SELECT 
        COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
        COUNT(*) as total
      FROM tasks 
      WHERE status IN ('todo', 'doing', 'done')
      AND created_at >= datetime('now', '-14 days')
    `).get() as { completed: number; total: number };

        if (efficacy.total >= 5) {
            const rate = Math.round((efficacy.completed / efficacy.total) * 100);
            const localBands = getAdaptiveBands();
            if (rate < localBands.focusPoor) {
                const sent = await sendAlert(
                    'efficacy_drop',
                    `Your task completion rate is ${rate}% over the last 14 days. ${thresholds.efficacyAdvice || 'Focus on completing small tasks to rebuild confidence.'}`,
                    'warning'
                );
                if (sent) triggered.push('efficacy_drop');
            }
        }

        // 7. Multi-tier deadline alerts — per task, per tier
        type Severity = 'info' | 'warning' | 'urgent';
        const tasksDue = db.prepare(`
            SELECT id, title, due_date, due_time, task_type, course
            FROM tasks
            WHERE due_date IS NOT NULL AND status NOT IN ('done','cancelled')
        `).all() as { id: number; title: string; due_date: string; due_time: string | null; task_type: string; course: string | null }[];

        const ist = Date.now() + 19800000;
        const today2 = new Date(ist).toISOString().slice(0, 10);

        for (const t of tasksDue) {
            const todayDate = new Date(today2 + 'T00:00:00');
            const dueDate = new Date(t.due_date + 'T00:00:00');
            const daysLeft = Math.round((dueDate.getTime() - todayDate.getTime()) / 86400000);
            const courseLabel = t.course ? `[${t.course}] ` : '';
            const timeLabel = t.due_time ? ` ${t.due_time}` : '';

            interface AlertTier { key: string; condition: boolean; severity: Severity; msg: string; }
            const tiers: AlertTier[] = [
                {
                    key: `task_overdue_${t.id}`, condition: daysLeft < 0, severity: 'urgent',
                    msg: `Overdue: ${courseLabel}${t.title} (was due ${Math.abs(daysLeft)}d ago)`
                },
                {
                    key: `task_due_today_${t.id}`, condition: daysLeft === 0, severity: 'urgent',
                    msg: `Due TODAY: ${courseLabel}${t.title}${timeLabel}`
                },
                {
                    key: `task_1d_${t.id}`, condition: daysLeft === 1, severity: 'warning',
                    msg: `Due tomorrow: ${courseLabel}${t.title}${timeLabel}`
                },
                {
                    key: `task_3d_${t.id}`, condition: daysLeft === 3, severity: 'warning',
                    msg: `${courseLabel}${t.title} due in 3 days${timeLabel}`
                },
                {
                    key: `task_7d_${t.id}`, condition: daysLeft === 7 && (t.task_type === 'assignment' || t.task_type === 'exam'), severity: 'info',
                    msg: `${courseLabel}${t.title} due in 7 days${timeLabel}`
                },
                {
                    key: `task_14d_${t.id}`, condition: daysLeft === 14 && t.task_type === 'exam', severity: 'info',
                    msg: `Exam in 14 days: ${courseLabel}${t.title}${timeLabel}`
                },
            ];

            for (const tier of tiers) {
                if (!tier.condition) continue;
                const alertType: AlertType = daysLeft < 0 ? 'task_overdue' : 'task_reminder';
                const sent = await sendAlert(alertType, tier.msg, tier.severity, {
                    key: tier.key,
                    context: {
                        taskId: t.id,
                        title: t.title,
                        dueDate: t.due_date,
                        dueTime: t.due_time,
                        taskType: t.task_type,
                        course: t.course,
                        daysLeft,
                    },
                });
                if (sent) {
                    triggered.push(tier.key);
                }
                break; // Only fire the highest matching tier per task
            }
        }

        // Cleanup old alerts
        clearOldAlerts();

    } catch (err) {
        console.error('[AlertEngine] Error:', err);
    }

    return { triggered };
}
