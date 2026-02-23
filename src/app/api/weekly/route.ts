import { NextResponse } from 'next/server';
import { getDb, getSetting } from '@/lib/db';
import { sendAlert } from '@/lib/notifications';

// POST — Generate weekly retrospective report
export async function POST() {
    try {
        const db = getDb();

        // This week vs last week
        const thisWeek = db.prepare(`
      SELECT 
        COALESCE(SUM(xp_earned), 0) as xp,
        COALESCE(SUM(productive_minutes), 0) as prod_min,
        COALESCE(SUM(distraction_minutes), 0) as dist_min,
        COALESCE(SUM(tasks_completed), 0) as tasks_done,
        COALESCE(SUM(habits_completed), 0) as habits_done,
        COALESCE(AVG(task_score), 0) as avg_task_score,
        COALESCE(AVG(habit_score), 0) as avg_habit_score,
        COUNT(*) as days_tracked
      FROM daily_scores WHERE date >= date('now', '-7 days')
    `).get() as any;

        const lastWeek = db.prepare(`
      SELECT 
        COALESCE(SUM(xp_earned), 0) as xp,
        COALESCE(SUM(productive_minutes), 0) as prod_min,
        COALESCE(SUM(distraction_minutes), 0) as dist_min,
        COALESCE(SUM(tasks_completed), 0) as tasks_done,
        COALESCE(SUM(habits_completed), 0) as habits_done,
        COALESCE(AVG(task_score), 0) as avg_task_score,
        COALESCE(AVG(habit_score), 0) as avg_habit_score,
        COUNT(*) as days_tracked
      FROM daily_scores WHERE date >= date('now', '-14 days') AND date < date('now', '-7 days')
    `).get() as any;

        const delta = (curr: number, prev: number) => {
            if (prev === 0) return curr > 0 ? '+100%' : '0%';
            const pct = Math.round(((curr - prev) / prev) * 100);
            return pct >= 0 ? `+${pct}%` : `${pct}%`;
        };

        // Goal progress this week
        const goalProgress = db.prepare(`
      SELECT g.title,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id AND status = 'done' AND completed_at >= datetime('now', '-7 days')) as week_done,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id) as total,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id AND status = 'done') as all_done
      FROM goals g WHERE g.active = 1
    `).all() as any[];

        const report = {
            period: `${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)} to ${new Date().toISOString().slice(0, 10)}`,
            thisWeek,
            lastWeek,
            deltas: {
                xp: delta(thisWeek.xp, lastWeek.xp),
                productive: delta(thisWeek.prod_min, lastWeek.prod_min),
                tasks: delta(thisWeek.tasks_done, lastWeek.tasks_done),
                habits: delta(thisWeek.habits_done, lastWeek.habits_done),
                taskScore: delta(thisWeek.avg_task_score, lastWeek.avg_task_score),
                habitScore: delta(thisWeek.avg_habit_score, lastWeek.avg_habit_score),
            },
            goalProgress: goalProgress.map(g => ({
                title: g.title,
                weekTasksDone: g.week_done,
                totalProgress: g.total > 0 ? Math.round((g.all_done / g.total) * 100) : 0,
            })),
        };

        // Build summary text
        const lines = [
            `📊 Weekly Review: ${report.period}`,
            `XP: ${thisWeek.xp} (${report.deltas.xp})`,
            `Tasks: ${thisWeek.tasks_done} completed (${report.deltas.tasks})`,
            `Habits: avg ${Math.round(thisWeek.avg_habit_score)}% (${report.deltas.habitScore})`,
            `Focus: ${thisWeek.prod_min}min productive (${report.deltas.productive})`,
        ];

        for (const g of report.goalProgress) {
            lines.push(`🎯 ${g.title}: ${g.totalProgress}% (+${g.weekTasksDone} tasks this week)`);
        }

        const summary = lines.join('\n');

        // Send as alert
        await sendAlert('weekly_review', summary, 'info');

        // Try to email the weekly review
        const apiKey = getSetting('resend_api_key');
        const email = getSetting('notification_email');
        if (apiKey && email) {
            try {
                const { Resend } = await import('resend');
                const resend = new Resend(apiKey);

                const goalRows = report.goalProgress.map(g =>
                    `<tr><td style="padding:8px;border-bottom:1px solid #333;">${g.title}</td><td style="padding:8px;border-bottom:1px solid #333;">${g.totalProgress}%</td><td style="padding:8px;border-bottom:1px solid #333;">+${g.weekTasksDone}</td></tr>`
                ).join('');

                await resend.emails.send({
                    from: 'LifeOS <onboarding@resend.dev>',
                    to: email,
                    subject: `📊 LifeOS Weekly Review — ${report.period}`,
                    html: `
            <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <div style="background:#1a1a2e;color:#e0e0e0;padding:24px;border-radius:12px;">
                <h1 style="margin:0 0 16px;color:#667eea;">📊 Weekly Review</h1>
                <p style="color:#888;margin:0 0 20px;">${report.period}</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                  <tr><td style="padding:8px;color:#888;">XP Earned</td><td style="padding:8px;font-weight:bold;">${thisWeek.xp} <span style="color:${thisWeek.xp >= lastWeek.xp ? '#4caf50' : '#ff5555'}">${report.deltas.xp}</span></td></tr>
                  <tr><td style="padding:8px;color:#888;">Tasks Done</td><td style="padding:8px;font-weight:bold;">${thisWeek.tasks_done} <span style="color:${thisWeek.tasks_done >= lastWeek.tasks_done ? '#4caf50' : '#ff5555'}">${report.deltas.tasks}</span></td></tr>
                  <tr><td style="padding:8px;color:#888;">Avg Task Score</td><td style="padding:8px;font-weight:bold;">${Math.round(thisWeek.avg_task_score)}% <span style="color:${thisWeek.avg_task_score >= lastWeek.avg_task_score ? '#4caf50' : '#ff5555'}">${report.deltas.taskScore}</span></td></tr>
                  <tr><td style="padding:8px;color:#888;">Avg Habit Score</td><td style="padding:8px;font-weight:bold;">${Math.round(thisWeek.avg_habit_score)}% <span style="color:${thisWeek.avg_habit_score >= lastWeek.avg_habit_score ? '#4caf50' : '#ff5555'}">${report.deltas.habitScore}</span></td></tr>
                  <tr><td style="padding:8px;color:#888;">Productive Time</td><td style="padding:8px;font-weight:bold;">${thisWeek.prod_min}min <span style="color:${thisWeek.prod_min >= lastWeek.prod_min ? '#4caf50' : '#ff5555'}">${report.deltas.productive}</span></td></tr>
                </table>
                ${goalRows ? `<h3 style="color:#667eea;margin:16px 0 8px;">🎯 Goal Progress</h3><table style="width:100%;border-collapse:collapse;"><tr style="color:#888;"><th style="padding:8px;text-align:left;">Goal</th><th style="padding:8px;">Progress</th><th style="padding:8px;">This Week</th></tr>${goalRows}</table>` : ''}
              </div>
            </div>
          `,
                });
            } catch (emailErr) {
                console.error('[Weekly] Email failed:', emailErr);
            }
        }

        return NextResponse.json({ report, summary });
    } catch (error) {
        console.error('Weekly report error:', error);
        return NextResponse.json({ error: 'Failed to generate weekly report' }, { status: 500 });
    }
}

// GET — Fetch latest weekly report data
export async function GET() {
    try {
        const db = getDb();

        const thisWeek = db.prepare(`
      SELECT 
        COALESCE(SUM(xp_earned), 0) as xp,
        COALESCE(SUM(productive_minutes), 0) as prod_min,
        COALESCE(SUM(distraction_minutes), 0) as dist_min,
        COALESCE(SUM(tasks_completed), 0) as tasks_done,
        COALESCE(AVG(task_score), 0) as avg_task_score,
        COALESCE(AVG(habit_score), 0) as avg_habit_score
      FROM daily_scores WHERE date >= date('now', '-7 days')
    `).get() as any;

        const lastWeek = db.prepare(`
      SELECT 
        COALESCE(SUM(xp_earned), 0) as xp,
        COALESCE(SUM(productive_minutes), 0) as prod_min,
        COALESCE(SUM(tasks_completed), 0) as tasks_done,
        COALESCE(AVG(task_score), 0) as avg_task_score,
        COALESCE(AVG(habit_score), 0) as avg_habit_score
      FROM daily_scores WHERE date >= date('now', '-14 days') AND date < date('now', '-7 days')
    `).get() as any;

        return NextResponse.json({ thisWeek, lastWeek });
    } catch (error) {
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}
