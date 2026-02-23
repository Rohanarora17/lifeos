import { NextRequest, NextResponse } from 'next/server';
import { getDb, getSetting } from '@/lib/db';
import { generateDailySummary, generateMorningBrief } from '@/lib/ai';
import { calculateDailyXp, getStreakCount, getAccountabilityScore, ScoreConfig } from '@/lib/scoring';

// GET: Get daily summary or morning brief
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const date = searchParams.get('date') || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const type = searchParams.get('type') || 'daily'; // 'daily' or 'morning'

        const db = getDb();

        // Check if already generated today
        const existing = db.prepare('SELECT * FROM daily_scores WHERE date = ?').get(date) as Record<string, unknown> | undefined;

        if (type === 'morning') {
            if (existing && (existing as { ai_morning_brief: string | null }).ai_morning_brief) {
                return NextResponse.json({ brief: (existing as { ai_morning_brief: string }).ai_morning_brief, cached: true });
            }

            // Gather morning brief data
            const calendarEvents = db.prepare(
                "SELECT title, start_time, end_time FROM calendar_events WHERE date(start_time) = ? ORDER BY start_time"
            ).all(date) as { title: string; start_time: string; end_time: string }[];

            const pendingTasks = db.prepare(
                "SELECT title, status FROM tasks WHERE status IN ('today', 'doing', 'this_week') ORDER BY position"
            ).all() as { title: string; status: string }[];

            // Yesterday's score
            const yesterday = new Date(date);
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            const yesterdayScore = db.prepare('SELECT * FROM daily_scores WHERE date = ?').get(yesterdayStr) as Record<string, number> | undefined;

            const allCheckinDates = db.prepare(
                "SELECT DISTINCT date FROM habit_checkins WHERE completed = 1 ORDER BY date DESC"
            ).all() as { date: string }[];

            const streak = getStreakCount(allCheckinDates.map(d => d.date));

            const brief = await generateMorningBrief(date, {
                calendarEvents,
                pendingTasks,
                yesterdayScore: (yesterdayScore as unknown as { xp_earned: number })?.xp_earned ? getAccountabilityScore({
                    productiveMinutes: (yesterdayScore as { productive_minutes: number }).productive_minutes || 0,
                    distractionMinutes: (yesterdayScore as { distraction_minutes: number }).distraction_minutes || 0,
                    tasksCompleted: (yesterdayScore as { tasks_completed: number }).tasks_completed || 0,
                    totalTasks: (yesterdayScore as { tasks_completed: number }).tasks_completed || 0,
                    habitsCompleted: (yesterdayScore as { habits_completed: number }).habits_completed || 0,
                    totalHabits: (yesterdayScore as { total_habits: number }).total_habits || 0,
                }) : 0,
                streak,
                yesterdayDistractionMinutes: (yesterdayScore as { distraction_minutes: number })?.distraction_minutes || 0,
            });

            // Save
            db.prepare(`
        INSERT INTO daily_scores (date, ai_morning_brief) VALUES (?, ?)
        ON CONFLICT(date) DO UPDATE SET ai_morning_brief = ?
      `).run(date, brief, brief);

            return NextResponse.json({ brief, cached: false });
        }

        // Daily summary
        if (existing && (existing as { ai_summary: string | null }).ai_summary) {
            return NextResponse.json({ summary: existing, cached: true });
        }

        // Calculate stats
        const activityStats = db.prepare(`
      SELECT 
        SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 60 as productive_minutes,
        SUM(CASE WHEN category = 'distraction' THEN duration_seconds ELSE 0 END) / 60 as distraction_minutes,
        SUM(CASE WHEN category = 'neutral' THEN duration_seconds ELSE 0 END) / 60 as neutral_minutes
      FROM activities WHERE date(started_at, 'localtime') = ?
    `).get(date) as { productive_minutes: number; distraction_minutes: number; neutral_minutes: number };

        const tasksCompleted = (db.prepare(
            "SELECT COUNT(*) as count FROM tasks WHERE status = 'done' AND date(completed_at) = ?"
        ).get(date) as { count: number }).count;

        const totalTasks = (db.prepare(
            "SELECT COUNT(*) as count FROM tasks WHERE status IN ('today', 'doing', 'done') AND (date(created_at) <= ? OR date(completed_at) = ?)"
        ).get(date, date) as { count: number }).count;

        const habitsCompleted = (db.prepare(
            'SELECT COUNT(*) as count FROM habit_checkins WHERE date = ? AND completed = 1'
        ).get(date) as { count: number }).count;

        const totalHabits = (db.prepare(
            'SELECT COUNT(*) as count FROM habits WHERE archived = 0'
        ).get() as { count: number }).count;

        const commits = (db.prepare(
            "SELECT COUNT(*) as count FROM github_activity WHERE date(created_at) = ? AND type = 'commit'"
        ).get(date) as { count: number }).count;

        const topDomains = db.prepare(`
      SELECT domain, SUM(duration_seconds) / 60 as minutes, category
      FROM activities WHERE date(started_at, 'localtime') = ?
      GROUP BY domain ORDER BY minutes DESC LIMIT 10
    `).all(date) as { domain: string; minutes: number; category: string }[];

        const config: ScoreConfig = {
            xpPerTask: parseInt(getSetting('xp_per_task') || '50'),
            xpPerHabit: parseInt(getSetting('xp_per_habit') || '20'),
            xpPerProductiveHour: parseInt(getSetting('xp_per_productive_hour') || '30'),
            xpPerCommit: parseInt(getSetting('xp_per_commit') || '10'),
            levelXpBase: parseInt(getSetting('level_xp_base') || '500'),
        };

        const xp = calculateDailyXp({
            tasksCompleted,
            habitsCompleted,
            productiveMinutes: activityStats.productive_minutes || 0,
            commits,
            config,
        });

        const score = getAccountabilityScore({
            productiveMinutes: activityStats.productive_minutes || 0,
            distractionMinutes: activityStats.distraction_minutes || 0,
            tasksCompleted,
            totalTasks: Math.max(totalTasks, 1),
            habitsCompleted,
            totalHabits: Math.max(totalHabits, 1),
        });

        const summaryText = await generateDailySummary(date, {
            productiveMinutes: activityStats.productive_minutes || 0,
            distractionMinutes: activityStats.distraction_minutes || 0,
            neutralMinutes: activityStats.neutral_minutes || 0,
            tasksCompleted,
            totalTasks,
            habitsCompleted,
            totalHabits,
            topDomains,
            commits,
            score,
            xp,
        });

        // Calculate daily sub-scores
        const taskScore = totalTasks > 0 ? Math.min(100, Math.round((tasksCompleted / totalTasks) * 100)) : 0;
        const habitScore = totalHabits > 0 ? Math.min(100, Math.round((habitsCompleted / totalHabits) * 100)) : 0;

        // Count tasks that were assigned (today/doing status) for the day
        const tasksAssigned = totalTasks;
        const tasksPending = totalTasks - tasksCompleted;

        // Save to daily_scores
        db.prepare(`
      INSERT INTO daily_scores (date, xp_earned, productive_minutes, distraction_minutes, neutral_minutes, tasks_completed, habits_completed, total_habits, ai_summary, task_score, habit_score, tasks_assigned, tasks_pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET 
        xp_earned = ?, productive_minutes = ?, distraction_minutes = ?, neutral_minutes = ?,
        tasks_completed = ?, habits_completed = ?, total_habits = ?, ai_summary = ?,
        task_score = ?, habit_score = ?, tasks_assigned = ?, tasks_pending = ?
    `).run(
            date, xp, activityStats.productive_minutes || 0, activityStats.distraction_minutes || 0, activityStats.neutral_minutes || 0,
            tasksCompleted, habitsCompleted, totalHabits, summaryText, taskScore, habitScore, tasksAssigned, tasksPending,
            xp, activityStats.productive_minutes || 0, activityStats.distraction_minutes || 0, activityStats.neutral_minutes || 0,
            tasksCompleted, habitsCompleted, totalHabits, summaryText, taskScore, habitScore, tasksAssigned, tasksPending
        );

        return NextResponse.json({
            summary: {
                date, xp_earned: xp, productive_minutes: activityStats.productive_minutes || 0,
                distraction_minutes: activityStats.distraction_minutes || 0,
                neutral_minutes: activityStats.neutral_minutes || 0,
                tasks_completed: tasksCompleted, habits_completed: habitsCompleted,
                total_habits: totalHabits, ai_summary: summaryText, score,
                top_domains: topDomains, commits,
            },
            cached: false,
        });
    } catch (error) {
        console.error('Summary GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
