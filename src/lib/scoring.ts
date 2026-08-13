// Scoring & gamification utilities

import { Database } from 'better-sqlite3';
import { getAdaptiveBands } from './adaptive-bands';
import { lifeosDayBoundsUtc } from './timezone';

export interface ScoreConfig {
    xpPerTask: number;
    xpPerHabit: number;
    xpPerProductiveHour: number;
    xpPerCommit: number;
    levelXpBase: number;
}

// Priority-weighted XP for tasks
export const PRIORITY_XP: Record<string, number> = {
    low: 25,
    medium: 50,
    high: 75,
    critical: 100,
};

export function getPriorityXp(priority: string): number {
    const bands = getAdaptiveBands();
    const baseXp = Math.round(bands.dailyCapacityMinutes / 3.6);
    const scale: Record<string, number> = {
        low: baseXp * 0.5,
        medium: baseXp,
        high: baseXp * 1.5,
        critical: baseXp * 2,
    };
    return Math.round(PRIORITY_XP[priority] || scale[priority] || scale.medium);
}

export function getLevel(totalXp: number): { level: number; currentXp: number; nextLevelXp: number; progress: number } {
    const bands = getAdaptiveBands();
    const base = Math.round(bands.dailyCapacityMinutes * 1.5) || 500;
    let level = 1;
    let xpRemaining = totalXp;

    while (xpRemaining >= base * level) {
        xpRemaining -= base * level;
        level++;
    }

    const nextLevelXp = base * level;
    return {
        level,
        currentXp: xpRemaining,
        nextLevelXp,
        progress: Math.round((xpRemaining / nextLevelXp) * 100),
    };
}

export function calculateDailyXp(stats: {
    tasksCompleted: number;
    habitsCompleted: number;
    productiveMinutes: number;
    commits: number;
    config: ScoreConfig;
}): number {
    const { tasksCompleted, habitsCompleted, productiveMinutes, commits, config } = stats;
    return (
        tasksCompleted * config.xpPerTask +
        habitsCompleted * config.xpPerHabit +
        Math.floor(productiveMinutes / 60) * config.xpPerProductiveHour +
        commits * config.xpPerCommit
    );
}

export function getStreakCount(checkinDates: string[]): number {
    if (checkinDates.length === 0) return 0;

    const sorted = [...checkinDates].sort((a, b) => b.localeCompare(a));
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    // Check if the most recent checkin is today or yesterday
    const mostRecent = sorted[0];
    const daysDiff = dateDiffDays(mostRecent, today);
    if (daysDiff > 1) return 0;

    let streak = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
        const diff = dateDiffDays(sorted[i + 1], sorted[i]);
        if (diff === 1) {
            streak++;
        } else {
            break;
        }
    }

    return streak;
}

function dateDiffDays(dateA: string, dateB: string): number {
    const a = new Date(dateA);
    const b = new Date(dateB);
    return Math.round(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// -----------------------------------------------------------------------------
// Lally's Habit Formation Curve (Automaticity Score)
// Based on Lally et al. (2010): "How are habits formed: Modelling habit formation in the real world"
// Habit strength grows asymptotically. Median 66 days to 95% automaticity.
// Formula: A(t) = A_max * (1 - e^(-k * t))
// -----------------------------------------------------------------------------
export function getAutomaticityScore(streak: number): number {
    if (streak <= 0) return 0;

    // k = 0.045 sets 66 days to roughly 95% automaticity
    // 1 - e^(-0.045 * 66) ≈ 0.948
    const k = 0.045;
    const maxAutomaticity = 100;

    const automaticity = maxAutomaticity * (1 - Math.exp(-k * streak));
    return Math.min(100, Math.round(automaticity));
}

export function getAccountabilityScore(stats: {
    productiveMinutes: number;
    distractionMinutes: number;
    tasksCompleted: number;
    totalTasks: number;
    habitsCompleted: number;
    totalHabits: number;
    knowledgeMasteryBonus?: number;
    adaptiveContext?: {
        mode?: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
        energy?: 'high' | 'medium' | 'low';
        mood?: 'high' | 'medium' | 'low' | null;
        overdueTasks?: number;
        recentDistractionMinutes?: number;
    };
}): number {
    const { productiveMinutes, distractionMinutes, tasksCompleted, totalTasks, habitsCompleted, totalHabits, knowledgeMasteryBonus = 0, adaptiveContext } = stats;
    const bands = getAdaptiveBands();
    const mode = adaptiveContext?.mode ?? 'normal';
    const lowCapacity = adaptiveContext?.energy === 'low' || adaptiveContext?.mood === 'low' || mode === 'recovery';
    const deadlinePressure = mode === 'deadline_pressure' || Number(adaptiveContext?.overdueTasks ?? 0) > 0;
    const protectFocus = mode === 'protect_focus';

    let focusWeight = bands.focusDeepWeight / 100;
    let taskWeight = bands.focusFlowWeight / 100;
    let habitWeight = bands.focusFragWeight / 100;
    if (lowCapacity) {
        focusWeight *= 1.1;
        taskWeight *= 0.85;
        habitWeight *= 0.85;
    } else if (deadlinePressure) {
        focusWeight *= 0.9;
        taskWeight *= 1.2;
        habitWeight *= 0.8;
    } else if (protectFocus) {
        focusWeight *= 1.2;
        taskWeight *= 0.9;
    } else if (mode === 'planning') {
        focusWeight *= 0.9;
        taskWeight *= 0.85;
        habitWeight *= 1.15;
    }
    const weightTotal = focusWeight + taskWeight + habitWeight || 1;
    const scoreWeightTotal = (bands.focusDeepWeight + bands.focusFlowWeight + bands.focusFragWeight) / 100 || 1;
    focusWeight = (focusWeight / weightTotal) * scoreWeightTotal;
    taskWeight = (taskWeight / weightTotal) * scoreWeightTotal;
    habitWeight = (habitWeight / weightTotal) * scoreWeightTotal;
    const masteryMaxPct = bands.focusSwitchWeight / 100;
    const effectiveTotalTasks = lowCapacity ? Math.max(tasksCompleted, Math.ceil(totalTasks * 0.7), 1) : totalTasks;
    const effectiveTotalHabits = lowCapacity || deadlinePressure ? Math.max(habitsCompleted, Math.ceil(totalHabits * 0.75), 1) : totalHabits;
    const effectiveDistractionMinutes = protectFocus
        ? distractionMinutes + Math.round(Number(adaptiveContext?.recentDistractionMinutes ?? 0) * 0.5)
        : distractionMinutes;

    const totalActive = productiveMinutes + effectiveDistractionMinutes;
    const focusScore = totalActive > 0 ? (productiveMinutes / totalActive) * focusWeight * 100 : focusWeight * 50;
    const taskScore = effectiveTotalTasks > 0 ? (tasksCompleted / effectiveTotalTasks) * taskWeight * 100 : taskWeight * 50;
    const habitScore = effectiveTotalHabits > 0 ? (habitsCompleted / effectiveTotalHabits) * habitWeight * 100 : habitWeight * 50;
    const masteryBonus = Math.min(masteryMaxPct * 100, knowledgeMasteryBonus);

    return Math.min(100, Math.round(focusScore + taskScore + habitScore + masteryBonus));
}

// -----------------------------------------------------------------------------
// Omni-Device Overlap Deduplication
// Maps every activity to an 86400 array (seconds in a day) to precisely calculate
// total active time without double-counting when multiple devices track simultaneously.
// Tie-breaks overlapping categories: Distraction > Productive > Neutral
// -----------------------------------------------------------------------------
export function getDailyActivityStats(db: Database, dateString: string) {
    const { startIso, endIso } = lifeosDayBoundsUtc(dateString);
    const activities = db.prepare(`
        SELECT category, started_at, ended_at, duration_seconds, is_actively_interacting
        FROM activities
        WHERE started_at >= ? AND started_at < ? AND COALESCE(counted, 1) = 1
        UNION ALL
        SELECT category, observed_start AS started_at, observed_end AS ended_at,
               duration_seconds, CASE WHEN score_eligible = 1 THEN 1 ELSE 0 END AS is_actively_interacting
        FROM session_activity_intervals
        WHERE observed_start >= ? AND observed_start < ? AND counted = 1
          AND NOT EXISTS (
            SELECT 1 FROM guardian_sessions gs
            WHERE gs.session_id = session_activity_intervals.session_id
              AND gs.evidence_pipeline_mode = 'authoritative'
          )
        UNION ALL
        SELECT category, slice_start AS started_at, slice_end AS ended_at,
               duration_seconds, score_eligible AS is_actively_interacting
        FROM guardian_activity_slices
        WHERE slice_start >= ? AND slice_start < ?
          AND pipeline_mode = 'authoritative' AND provisional = 0 AND counted = 1
    `).all(startIso, endIso, startIso, endIso, startIso, endIso) as Array<{
        category: string;
        started_at: string;
        ended_at: string | null;
        duration_seconds: number;
        is_actively_interacting: number;
    }>;

    // Array of 86400 elements representing each second of the day
    const day = new Uint8Array(86400);
    // 0 = none
    // Idle plane: 1 = neutral, 2 = productive, 3 = distraction
    // Active plane: 4 = neutral, 5 = productive, 6 = distraction
    const categoryMapIdle: Record<string, number> = { neutral: 1, productive: 2, distraction: 3 };
    const categoryMapActive: Record<string, number> = { neutral: 4, productive: 5, distraction: 6 };

    const totalActivities = activities.length;
    if (totalActivities === 0) {
        return { productive_minutes: 0, distraction_minutes: 0, neutral_minutes: 0, total_minutes: 0, total_activities: 0 };
    }

    const midnight = Date.parse(startIso);

    for (const a of activities) {
        // Normalize legacy native labels (shallow_work, communication, …) into 3 buckets
        const rawCat = String(a.category || 'neutral').toLowerCase();
        if (rawCat === 'deep_work' || rawCat === 'productive') a.category = 'productive';
        else if (rawCat === 'distraction') a.category = 'distraction';
        else if (
            rawCat === 'neutral' || rawCat === 'communication' || rawCat === 'consumption' ||
            rawCat === 'shallow_work' || rawCat === 'idle' || rawCat === 'browsing'
        ) a.category = 'neutral';
        else a.category = 'neutral';

        const start = new Date(a.started_at).getTime();
        let end = a.ended_at ? new Date(a.ended_at).getTime() : start + (a.duration_seconds * 1000);
        if (start === end) end += 1000; // Give it 1 second if empty

        const startSec = Math.max(0, Math.floor((start - midnight) / 1000));
        const endSec = Math.min(86399, Math.floor((end - midnight) / 1000));

        const map = a.is_actively_interacting === 0 ? categoryMapIdle : categoryMapActive;
        const catVal = map[a.category] || map['neutral'];

        for (let i = startSec; i <= endSec; i++) {
            if (catVal > day[i]) {
                day[i] = catVal;
            }
        }
    }

    let prod = 0, dist = 0, neut = 0;
    for (let i = 0; i < 86400; i++) {
        if (day[i] === 2 || day[i] === 5) prod++;
        else if (day[i] === 3 || day[i] === 6) dist++;
        else if (day[i] === 1 || day[i] === 4) neut++;
    }

    return {
        productive_minutes: Math.round(prod / 60),
        distraction_minutes: Math.round(dist / 60),
        neutral_minutes: Math.round(neut / 60),
        total_minutes: Math.round((prod + dist + neut) / 60),
        total_activities: totalActivities
    };
}
