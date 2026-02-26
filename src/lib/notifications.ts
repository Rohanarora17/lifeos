import { getDb, getSetting } from './db';

// ============================================================
//  NOTIFICATION ENGINE — Real-time alerts + email via Resend
// ============================================================

export type AlertType =
    | 'cognitive_load'    // Too many open tasks (Zeigarnik)
    | 'focus_drop'        // CUSUM anomaly / distraction spike
    | 'habit_streak'      // Habit at risk of breaking streak
    | 'goal_gradient'     // Goal near completion — push!
    | 'goal_deadline'     // Goal deadline approaching
    | 'task_reminder'     // Task due today/tomorrow
    | 'efficacy_drop'     // Self-efficacy dropping
    | 'weekly_review'     // Weekly retrospective ready
    | 'habit_levelup'     // Habit ready for difficulty increase
    | 'goal_conflict';    // Goal conflict detected

export type Severity = 'info' | 'warning' | 'urgent';

interface Alert {
    id: number;
    type: AlertType;
    message: string;
    severity: Severity;
    read: number;
    emailed: number;
    created_at: string;
}

// Dedup window — don't fire the same alert type within this many minutes
const DEDUP_MINUTES: Record<string, number> = {
    cognitive_load: 60,
    focus_drop: 30,
    habit_streak: 120,
    goal_gradient: 240,
    goal_deadline: 720,
    task_reminder: 360,
    efficacy_drop: 1440,
    weekly_review: 10080,
    habit_levelup: 1440,
    goal_conflict: 1440,
};

/**
 * Send an alert — stores in DB + optionally emails via Resend.
 * Automatically deduplicates within the configured window.
 */
export async function sendAlert(
    type: AlertType,
    message: string,
    severity: Severity = 'info'
): Promise<boolean> {
    const db = getDb();

    // Dedup check: has this alert type been sent recently?
    const dedupMinutes = DEDUP_MINUTES[type] || 60;
    const recent = db.prepare(`
    SELECT id FROM alerts 
    WHERE type = ? AND created_at >= datetime('now', '-${dedupMinutes} minutes')
    LIMIT 1
  `).get(type);

    if (recent) return false; // Already alerted recently

    // Store in DB
    db.prepare(
        'INSERT INTO alerts (type, message, severity) VALUES (?, ?, ?)'
    ).run(type, message, severity);

    console.log(`[Alert] ${severity.toUpperCase()}: ${type} — ${message}`);

    // Try to email if configured and severity warrants it
    if (severity !== 'info') {
        await trySendEmail(type, message, severity);
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
async function trySendEmail(type: AlertType, message: string, severity: Severity): Promise<void> {
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
        ).run(type);

        console.log(`[Alert] Email sent to ${email}: ${type}`);
    } catch (err) {
        console.error('[Alert] Email failed:', err);
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

    try {
        // 1. Cognitive Load (Zeigarnik Effect)
        const openTasks = (db.prepare(
            "SELECT COUNT(*) as c FROM tasks WHERE status IN ('today', 'doing')"
        ).get() as { c: number }).c;

        if (openTasks >= 8) {
            const sent = await sendAlert(
                'cognitive_load',
                `You have ${openTasks} active tasks creating mental load. Consider completing 3 quick ones or deferring some to next week.`,
                'warning'
            );
            if (sent) triggered.push('cognitive_load');
        }

        // 2. Focus Drop — check if distraction ratio spiked today
        const todayStats = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN category = 'productive' THEN duration_seconds END), 0) as prod,
        COALESCE(SUM(CASE WHEN category = 'distraction' THEN duration_seconds END), 0) as dist,
        COALESCE(SUM(duration_seconds), 0) as total
      FROM activities WHERE started_at >= datetime('now', '-2 hours')
    `).get() as { prod: number; dist: number; total: number };

        if (todayStats.total > 600 && todayStats.dist > todayStats.prod) {
            const sent = await sendAlert(
                'focus_drop',
                `Your focus is dropping — distractions (${Math.round(todayStats.dist / 60)}min) exceed productive time (${Math.round(todayStats.prod / 60)}min) in the last 2 hours.`,
                'warning'
            );
            if (sent) triggered.push('focus_drop');
        }

        // 3. Habit Streak at Risk
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const hour = new Date(Date.now() + 19800000).getHours();

        if (hour >= 20) { // After 8 PM
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
                    `${uncheckedHabits.length} habit(s) unchecked today: ${names}${uncheckedHabits.length > 3 ? '...' : ''}. Your streak is at risk!`,
                    'warning'
                );
                if (sent) triggered.push('habit_streak');
            }
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
                if (progress >= 75 && remaining > 0 && remaining <= 3) {
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
      WHERE status IN ('today', 'doing', 'done', 'this_week')
      AND created_at >= datetime('now', '-14 days')
    `).get() as { completed: number; total: number };

        if (efficacy.total >= 5) {
            const rate = Math.round((efficacy.completed / efficacy.total) * 100);
            if (rate < 30) {
                const sent = await sendAlert(
                    'efficacy_drop',
                    `Your task completion rate is ${rate}% over the last 14 days. Try completing a few quick tasks to rebuild momentum. 💪`,
                    'warning'
                );
                if (sent) triggered.push('efficacy_drop');
            }
        }

        // 7. Task Reminders — tasks due today
        const dueTasks = db.prepare(`
      SELECT title FROM tasks 
      WHERE due_date = ? AND status != 'done'
    `).all(today) as { title: string }[];

        if (dueTasks.length > 0 && hour >= 9 && hour <= 10) {
            const names = dueTasks.slice(0, 3).map(t => `"${t.title}"`).join(', ');
            const sent = await sendAlert(
                'task_reminder',
                `${dueTasks.length} task${dueTasks.length > 1 ? 's' : ''} due today: ${names}`,
                'info'
            );
            if (sent) triggered.push('task_reminder');
        }

        // Cleanup old alerts
        clearOldAlerts();

    } catch (err) {
        console.error('[AlertEngine] Error:', err);
    }

    return { triggered };
}
