import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getLevel, getStreakCount, getAccountabilityScore } from '@/lib/scoring';

// GET: Dashboard overview data
export async function GET(request: NextRequest) {
    try {
        const db = getDb();
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

        // Today's activity stats
        const activityStats = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 60, 0) as productive_minutes,
        COALESCE(SUM(CASE WHEN category = 'distraction' THEN duration_seconds ELSE 0 END) / 60, 0) as distraction_minutes,
        COALESCE(SUM(CASE WHEN category = 'neutral' THEN duration_seconds ELSE 0 END) / 60, 0) as neutral_minutes,
        COALESCE(SUM(duration_seconds) / 60, 0) as total_minutes,
        COUNT(*) as total_activities
      FROM activities WHERE date(started_at, 'localtime') = ?
    `).get(today) as Record<string, number>;

        // Today's tasks
        const taskStats = db.prepare(`
      SELECT 
        COUNT(CASE WHEN status = 'done' AND date(completed_at) = ? THEN 1 END) as completed_today,
        COUNT(CASE WHEN status IN ('today', 'doing') THEN 1 END) as active_today,
        COUNT(CASE WHEN status = 'doing' THEN 1 END) as in_progress
      FROM tasks
    `).get(today) as Record<string, number>;

        // Today's habits
        const habitStats = db.prepare(`
      SELECT 
        COUNT(DISTINCT hc.habit_id) as completed_today,
        (SELECT COUNT(*) FROM habits WHERE archived = 0) as total_habits
      FROM habit_checkins hc
      JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
      WHERE hc.date = ? AND hc.completed = 1
    `).get(today) as Record<string, number>;

        // Streak
        const allCheckinDates = db.prepare(
            "SELECT DISTINCT date FROM habit_checkins WHERE completed = 1 ORDER BY date DESC"
        ).all() as { date: string }[];
        const streak = getStreakCount(allCheckinDates.map(d => d.date));

        // Total XP (sum of all daily_scores)
        const totalXpRow = db.prepare(
            'SELECT COALESCE(SUM(xp_earned), 0) as total FROM daily_scores'
        ).get() as { total: number };
        const levelInfo = getLevel(totalXpRow.total);

        // Today's top domains
        const topDomains = db.prepare(`
      SELECT domain, SUM(duration_seconds) / 60 as minutes, category
      FROM activities WHERE date(started_at, 'localtime') = ?
      GROUP BY domain ORDER BY minutes DESC LIMIT 5
    `).all(today) as { domain: string; minutes: number; category: string }[];

        // GitHub commits today
        const githubToday = (db.prepare(
            "SELECT COUNT(*) as count FROM github_activity WHERE date(created_at) = ?"
        ).get(today) as { count: number }).count;

        // Accountability score
        const score = getAccountabilityScore({
            productiveMinutes: activityStats.productive_minutes || 0,
            distractionMinutes: activityStats.distraction_minutes || 0,
            tasksCompleted: taskStats.completed_today || 0,
            totalTasks: Math.max((taskStats.active_today || 0) + (taskStats.completed_today || 0), 1),
            habitsCompleted: habitStats.completed_today || 0,
            totalHabits: Math.max(habitStats.total_habits || 1, 1),
        });

        // Latest morning brief
        const morningBrief = db.prepare(
            'SELECT ai_morning_brief FROM daily_scores WHERE date = ?'
        ).get(today) as { ai_morning_brief: string | null } | undefined;

        // Recent activities (last 10)
        const recentActivities = db.prepare(`
      SELECT id, url, domain, title, category, subcategory, started_at, duration_seconds, youtube_video_id
      FROM activities WHERE date(started_at, 'localtime') = ?
      ORDER BY started_at DESC LIMIT 10
    `).all(today);

        // 7-day trend
        const weekTrend = db.prepare(`
      SELECT date, xp_earned, productive_minutes, distraction_minutes, tasks_completed, habits_completed
      FROM daily_scores
      WHERE date >= date('now', '-7 days')
      ORDER BY date ASC
    `).all();

        return NextResponse.json({
            today: {
                date: today,
                score,
                ...activityStats,
                tasks: taskStats,
                habits: habitStats,
                streak,
                level: levelInfo,
                totalXp: totalXpRow.total,
                topDomains,
                githubCommits: githubToday,
                morningBrief: morningBrief?.ai_morning_brief || null,
                recentActivities,
            },
            weekTrend,
        });
    } catch (error) {
        console.error('Dashboard GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
