import { getDb, getSetting } from './db';
import { sendTelegram, formatAlert, ALERT_KEYBOARD } from './telegram';
import { getGuardianContext } from './guardian-runtime';
import { getIntelligenceProfile, touchIntelligence } from './intelligence';

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
    | 'goal_conflict';

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
    midday_checkin: 120,
    goal_gradient: 240,
    goal_deadline: 720,
    task_reminder: 360,
    task_overdue: 720,
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

    // Notify via Telegram + email for warning/urgent alerts
    if (severity !== 'info') {
        void sendTelegram(formatAlert(type, message, severity), 'HTML', ALERT_KEYBOARD);
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
        const now = new Date(Date.now() + 19800000); // IST
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
        const scoreEmoji = avgScore >= 85 ? '🔥' : avgScore >= 70 ? '✅' : avgScore >= 55 ? '🟡' : '🔴';

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
          <div style="font-size:28px;font-weight:bold;color:#fff;">${scoreEmoji} ${avgScore}</div>
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
                `You have ${openTasks} active tasks creating mental load. Consider completing 3 quick ones or deferring some to next week.`,
                'warning'
            );
            if (sent) triggered.push('cognitive_load');
        }

        // 2. Focus Drop — only fires during an active guardian session.
        // Browsing data is only meaningful when the guardian is watching.
        const { activeSession } = getGuardianContext();
        if (activeSession) {
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
                    `${uncheckedHabits.length} habit(s) unchecked today: ${names}${uncheckedHabits.length > 3 ? '...' : ''}. Your streak is at risk!`,
                    'warning'
                );
                if (sent) triggered.push('habit_streak');
            }
        }

        // 3.5 Mid-day check-in pulse
        if (hour === 13) {
            const sent = await sendAlert(
                'midday_checkin',
                `Mid-day pulse check! How is your focus so far today? Take 5 minutes to review your active tasks.`,
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
                    `Your task completion rate is ${rate}% over the last 14 days. Try completing a few quick tasks to rebuild momentum.`,
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
                const dedupWindow = tier.severity === 'urgent' ? (daysLeft < 0 ? 720 : 360) : 1440;
                const alreadySent = db.prepare(
                    `SELECT id FROM alerts WHERE type = ? AND created_at >= datetime('now', '-${dedupWindow} minutes') LIMIT 1`
                ).get(tier.key);
                if (!alreadySent) {
                    const alertType = daysLeft < 0 ? 'task_overdue' : 'task_reminder';
                    db.prepare('INSERT INTO alerts (type, message, severity) VALUES (?, ?, ?)')
                        .run(tier.key, tier.msg, tier.severity);
                    console.log(`[Alert] ${tier.severity.toUpperCase()}: ${tier.key} — ${tier.msg}`);
                    if (tier.severity !== 'info') {
                        void sendTelegram(formatAlert(alertType as AlertType, tier.msg, tier.severity), 'HTML', ALERT_KEYBOARD);
                    }
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
