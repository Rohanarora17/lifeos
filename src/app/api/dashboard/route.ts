import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getLevel, getStreakCount, getAccountabilityScore, getDailyActivityStats } from '@/lib/scoring';
import { getCognitiveLoadAudit, getSelfEfficacyMode, detectGoalConflicts } from '@/lib/intelligence';
import { getUnreadAlerts } from '@/lib/notifications';
import { getKnowledgeMasteryBonus } from '@/lib/graph';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';
import { getAdaptiveSessionMinutes } from '@/lib/adaptive-command-defaults';
import { getAdaptiveBands } from '@/lib/adaptive-bands';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveTaskRecommendations } from '@/lib/adaptive-task-recommendations';
import { buildAdaptiveDashboardPolicy } from '@/lib/adaptive-dashboard-policy';
import { buildAdaptiveAnalyticsPolicy } from '@/lib/adaptive-analytics-policy';
import { getTaskTimeProgress } from '@/lib/task-time-sessions';
import { syncCalendarIfStale } from '@/lib/calendar';

// GET: Dashboard overview data
export async function GET() {
  try {
    const db = getDb();
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    await syncCalendarIfStale();

    const activityStats = getDailyActivityStats(db, today);

    // Today's tasks
    const taskStats = db.prepare(`
      SELECT 
        COUNT(CASE WHEN status = 'done' AND date(completed_at) = ? THEN 1 END) as completed_today,
        COUNT(CASE WHEN status IN ('todo', 'doing') THEN 1 END) as active_today,
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
      FROM activities 
      WHERE date(started_at, 'localtime') = ? AND is_actively_interacting = 1
      GROUP BY domain ORDER BY minutes DESC LIMIT 5
    `).all(today) as { domain: string; minutes: number; category: string }[];

    // GitHub commits today
    const githubToday = (db.prepare(
      "SELECT COUNT(*) as count FROM github_activity WHERE date(created_at) = ?"
    ).get(today) as { count: number }).count;

    const activeSession = getActiveGuardianSession();
    const personalization = buildPersonalizationSnapshot({
      surface: 'dashboard',
      maxInsights: 2,
      includeMemoryFacts: 3,
      activeSession: activeSession ? {
        sessionId: activeSession.sessionId,
        targetTitle: activeSession.targetTitle,
        focusScore: activeSession.focusScoreHistory?.at(-1) ?? null,
        elapsedMinutes: Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60_000)),
      } : null,
    });

    // Accountability score with knowledge graph mastery bonus
    const knowledgeMasteryBonus = getKnowledgeMasteryBonus();
    const score = getAccountabilityScore({
      productiveMinutes: activityStats.productive_minutes || 0,
      distractionMinutes: activityStats.distraction_minutes || 0,
      tasksCompleted: taskStats.completed_today || 0,
      totalTasks: Math.max((taskStats.active_today || 0) + (taskStats.completed_today || 0), 1),
      habitsCompleted: habitStats.completed_today || 0,
      totalHabits: Math.max(habitStats.total_habits || 1, 1),
      knowledgeMasteryBonus,
      adaptiveContext: {
        mode: personalization.moment.mode,
        energy: personalization.userState.energy,
        mood: personalization.userState.mood,
        overdueTasks: personalization.today.overdueTasks,
        recentDistractionMinutes: personalization.today.recentDistractionMinutes,
      },
    });

    // Latest morning brief
    const morningBrief = db.prepare(
      'SELECT ai_morning_brief FROM daily_scores WHERE date = ?'
    ).get(today) as { ai_morning_brief: string | null } | undefined;

    // Recent activities (last 10)
    const recentActivities = db.prepare(`
      SELECT id, url, domain, title, category, subcategory, started_at, duration_seconds, youtube_video_id, device_name
      FROM activities WHERE date(started_at, 'localtime') = ?
      ORDER BY started_at DESC LIMIT 10
    `).all(today);

    // 7-day trend
    const weekTrend = db.prepare(`
      SELECT date, xp_earned, productive_minutes, distraction_minutes, tasks_completed, habits_completed,
             COALESCE(task_score, 0) as task_score, COALESCE(habit_score, 0) as habit_score,
             COALESCE(tasks_assigned, 0) as tasks_assigned, COALESCE(tasks_pending, 0) as tasks_pending
      FROM daily_scores
      WHERE date >= date('now', '-7 days')
      ORDER BY date ASC
    `).all() as Array<{
      date: string;
      xp_earned: number | null;
      productive_minutes: number | null;
      distraction_minutes: number | null;
      tasks_completed: number | null;
      habits_completed: number | null;
      task_score: number;
      habit_score: number;
      tasks_assigned: number;
      tasks_pending: number;
    }>;

    // Phase 12: Intelligence layer
    const cognitiveLoad = getCognitiveLoadAudit();
    const recommendedTasks = getAdaptiveTaskRecommendations(personalization)
      .map(task => ({
        ...task,
        timeProgress: getTaskTimeProgress(task.id),
      }));
    const efficacyMode = getSelfEfficacyMode();
    const goalConflicts = detectGoalConflicts();

    // Top 3 active goals with progress
    const topGoals = db.prepare(`
      SELECT g.id, g.title, g.deadline, g.category,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id) as total_tasks,
        (SELECT COUNT(*) FROM tasks WHERE goal_id = g.id AND status = 'done') as done_tasks
      FROM goals g WHERE g.active = 1
      ORDER BY g.created_at DESC LIMIT 3
    `).all() as {
      id: number;
      title: string;
      deadline: string | null;
      category: string;
      total_tasks: number;
      done_tasks: number;
    }[];

    const goalsWithProgress = topGoals.map(g => ({
      ...g,
      progress: g.total_tasks > 0 ? Math.round((g.done_tasks / g.total_tasks) * 100) : 0,
    }));

    // Unread alerts count
    const unreadAlerts = getUnreadAlerts(100).length;
    const recommendedSessionMinutes = getAdaptiveSessionMinutes();
    const adaptiveBands = getAdaptiveBands();
    const dashboardPolicy = buildAdaptiveDashboardPolicy({
      snapshot: personalization,
      recommendedTasks,
      recommendedSessionMinutes,
      habitStats,
      unreadAlerts,
      productiveMinutes: activityStats.productive_minutes || 0,
      distractionMinutes: activityStats.distraction_minutes || 0,
    });
    const analyticsPolicy = buildAdaptiveAnalyticsPolicy({
      snapshot: personalization,
      weekTrend,
      dailyCapacityMinutes: adaptiveBands.dailyCapacityMinutes,
      recommendedSessionMinutes,
    });

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
      intelligence: {
        cognitiveLoad,
        recommendedTasks,
        efficacyMode,
	        goalConflicts,
	        topGoals: goalsWithProgress,
	        unreadAlerts,
	        dashboardPolicy,
	        analyticsPolicy,
	      },
      personalization: {
        mode: personalization.moment.mode,
        guidance: personalization.moment.guidance,
        recommendedSessionMinutes,
        openTasks: personalization.today.openTasks,
        overdueTasks: personalization.today.overdueTasks,
        doingTasks: personalization.today.doingTasks,
        uncheckedHabits: personalization.today.uncheckedHabits,
        calendarEvents: personalization.today.calendarEvents,
        recentDistractionMinutes: personalization.today.recentDistractionMinutes,
        plannedFocus: personalization.today.plannedFocus,
        standupGoal: personalization.userState.standupGoal,
        narrative: personalization.userState.narrative,
        energy: personalization.userState.energy,
        mood: personalization.userState.mood,
        coachingStyle: personalization.userState.coachingStyle,
        focusTrend: personalization.userState.focusTrend,
        nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
        alertFatigueLevel: personalization.feedback.alertFatigueLevel,
        recentAlerts: personalization.feedback.recentAlerts,
        helpfulRate: personalization.feedback.helpfulRate,
        corrections30d: personalization.feedback.corrections30d,
        activeSessionTarget: personalization.activeSession?.targetTitle ?? null,
      },
    });
  } catch (error) {
    console.error('Dashboard GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
