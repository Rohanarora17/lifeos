import { NextRequest, NextResponse } from 'next/server';
import { getDb, getSetting } from '@/lib/db';
import { generateDailySummary, generateMorningBrief } from '@/lib/ai';
import { calculateDailyXp, getStreakCount, getAccountabilityScore, getDailyActivityStats, ScoreConfig } from '@/lib/scoring';

function normalizeSignal(value: unknown): 'high' | 'medium' | 'low' | null {
    const signal = String(value ?? '').toLowerCase();
    if (signal.includes('high') || signal.includes('good') || signal.includes('great')) return 'high';
    if (signal.includes('low') || signal.includes('bad') || signal.includes('tired') || signal.includes('rough')) return 'low';
    if (signal.includes('medium') || signal.includes('okay') || signal.includes('normal')) return 'medium';
    return null;
}

function getSummaryAdaptiveContext(db: ReturnType<typeof getDb>, date: string) {
    const plan = db.prepare(`
        SELECT mood, energy
        FROM daily_plans
        WHERE plan_date = ?
        LIMIT 1
    `).get(date) as { mood: string | null; energy: string | null } | undefined;
    const overdueTasks = (db.prepare(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE status NOT IN ('done','cancelled')
          AND due_date < ?
    `).get(date) as { count: number }).count;
    const mood = normalizeSignal(plan?.mood);
    const energy = normalizeSignal(plan?.energy) ?? 'medium';

    return {
        mode: overdueTasks > 0 ? 'deadline_pressure' as const : (mood === 'low' || energy === 'low' ? 'recovery' as const : 'normal' as const),
        energy,
        mood,
        overdueTasks,
    };
}

function formatPlanContext(db: ReturnType<typeof getDb>, date: string): string {
    try {
        const plan = db.prepare(`
            SELECT id,
                   sleep_time as sleepTime,
                   wake_estimate as wakeEstimate,
                   mood,
                   energy,
                   evening_notes as eveningNotes,
                   tomorrow_intention as tomorrowIntention,
                   generated_summary as generatedSummary
            FROM daily_plans
            WHERE plan_date = ?
            LIMIT 1
        `).get(date) as {
            id: number;
            sleepTime: string | null;
            wakeEstimate: string | null;
            mood: string | null;
            energy: string | null;
            eveningNotes: string | null;
            tomorrowIntention: string | null;
            generatedSummary: string | null;
        } | undefined;

        if (!plan) return '';

        const sessions = db.prepare(`
            SELECT title,
                   planned_start as plannedStart,
                   duration_minutes as durationMinutes,
                   session_type as sessionType,
                   reward_xp as rewardXp,
                   reward_coins as rewardCoins,
                   status,
                   soft_watch_id as softWatchId
            FROM planned_focus_sessions
            WHERE plan_id = ?
            ORDER BY planned_start ASC
            LIMIT 8
        `).all(plan.id) as Array<{
            title: string;
            plannedStart: string;
            durationMinutes: number;
            sessionType: string;
            rewardXp: number;
            rewardCoins: number;
            status: string;
            softWatchId: string | null;
        }>;
        const plannedMinutes = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
        const completed = sessions.filter(session => session.status === 'completed');
        const skipped = sessions.filter(session => session.status === 'skipped');
        const softWatchIds = sessions.map(session => session.softWatchId).filter((id): id is string => Boolean(id));
        const actualRows = softWatchIds.length > 0 ? db.prepare(`
            SELECT
              sw.id as softWatchId,
              gss.elapsed_minutes as elapsedMinutes,
              gss.average_focus_score as averageFocusScore
            FROM soft_watch_commitments sw
            LEFT JOIN guardian_session_summaries gss ON gss.session_id = sw.locked_in_session_id
            WHERE sw.id IN (${softWatchIds.map(() => '?').join(',')})
        `).all(...softWatchIds) as Array<{
            softWatchId: string;
            elapsedMinutes: number | null;
            averageFocusScore: number | null;
        }> : [];
        const actualBySoftWatch = new Map(actualRows.map(row => [row.softWatchId, row]));
        const actualMinutes = actualRows.reduce((sum, row) => sum + Math.max(0, Math.round(row.elapsedMinutes ?? 0)), 0);
        const focusScores = actualRows
            .map(row => Number(row.averageFocusScore))
            .filter(score => Number.isFinite(score));
        const avgFocusScore = focusScores.length
            ? Math.round(focusScores.reduce((sum, score) => sum + score, 0) / focusScores.length)
            : null;

        const lines = [
            plan.tomorrowIntention ? `Main intention: ${plan.tomorrowIntention}` : null,
            plan.sleepTime || plan.wakeEstimate ? `Sleep/wake: ${plan.sleepTime ?? '?'} -> ${plan.wakeEstimate ?? '?'}` : null,
            plan.mood || plan.energy ? `Evening state: ${plan.mood ?? 'unknown'} mood, ${plan.energy ?? 'unknown'} energy` : null,
            plan.eveningNotes ? `What changed: ${plan.eveningNotes.slice(0, 300)}` : null,
            plan.generatedSummary ? `Planner summary: ${plan.generatedSummary}` : null,
            sessions.length > 0
                ? `Planned focus follow-through: ${completed.length}/${sessions.length} completed, ${skipped.length} skipped, ${actualMinutes}/${plannedMinutes} actual minutes${avgFocusScore !== null ? `, avg focus ${avgFocusScore}` : ''}`
                : null,
            sessions.length > 0
                ? `Planned focus blocks:\n${sessions.map(session => {
                    const time = new Date(session.plannedStart).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const actual = session.softWatchId ? actualBySoftWatch.get(session.softWatchId) : null;
                    const actualText = actual?.elapsedMinutes ? `, actual ${Math.round(actual.elapsedMinutes)}m` : '';
                    return `- ${time} ${session.title} (${session.durationMinutes}m planned${actualText}, ${session.sessionType}, ${session.status}, ${session.rewardXp} XP/${session.rewardCoins} coins)`;
                }).join('\n')}`
                : null,
        ].filter(Boolean);

        return lines.join('\n');
    } catch {
        return '';
    }
}

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
                "SELECT title, status FROM tasks WHERE status IN ('todo', 'doing') ORDER BY priority_rank ASC, position ASC"
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
                    adaptiveContext: getSummaryAdaptiveContext(db, yesterdayStr),
                }) : 0,
                streak,
                yesterdayDistractionMinutes: (yesterdayScore as { distraction_minutes: number })?.distraction_minutes || 0,
                planningContext: formatPlanContext(db, date),
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
        const activityStats = getDailyActivityStats(db, date);

        const tasksCompleted = (db.prepare(
            "SELECT COUNT(*) as count FROM tasks WHERE status = 'done' AND date(completed_at) = ?"
        ).get(date) as { count: number }).count;

        const totalTasks = (db.prepare(
            "SELECT COUNT(*) as count FROM tasks WHERE status IN ('todo', 'doing', 'done') AND (date(created_at) <= ? OR date(completed_at) = ?)"
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
      FROM effective_activities WHERE date(started_at, 'localtime') = ?
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
            adaptiveContext: getSummaryAdaptiveContext(db, date),
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
            planningContext: formatPlanContext(db, date),
        });

        // Calculate daily sub-scores
        const taskScore = totalTasks > 0 ? Math.min(100, Math.round((tasksCompleted / totalTasks) * 100)) : 0;
        const habitScore = totalHabits > 0 ? Math.min(100, Math.round((habitsCompleted / totalHabits) * 100)) : 0;

        // Count tasks that were assigned (today/doing status) for the day
        const tasksAssigned = totalTasks;
        const tasksPending = totalTasks - tasksCompleted;

        // Save to daily_scores
        db.prepare(`
      INSERT INTO daily_scores (date, xp_earned, productive_minutes, distraction_minutes, neutral_minutes, tasks_completed, habits_completed, total_habits, ai_summary, task_score, habit_score, tasks_assigned, tasks_pending, accountability_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET 
        xp_earned = ?, productive_minutes = ?, distraction_minutes = ?, neutral_minutes = ?,
        tasks_completed = ?, habits_completed = ?, total_habits = ?, ai_summary = ?,
        task_score = ?, habit_score = ?, tasks_assigned = ?, tasks_pending = ?, accountability_score = ?
    `).run(
            date, xp, activityStats.productive_minutes || 0, activityStats.distraction_minutes || 0, activityStats.neutral_minutes || 0,
            tasksCompleted, habitsCompleted, totalHabits, summaryText, taskScore, habitScore, tasksAssigned, tasksPending, score,
            xp, activityStats.productive_minutes || 0, activityStats.distraction_minutes || 0, activityStats.neutral_minutes || 0,
            tasksCompleted, habitsCompleted, totalHabits, summaryText, taskScore, habitScore, tasksAssigned, tasksPending, score
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
