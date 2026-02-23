// Scoring & gamification utilities

import { Database } from 'better-sqlite3';

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
    return PRIORITY_XP[priority] || PRIORITY_XP.medium;
}

export function getLevel(totalXp: number, base: number = 500): { level: number; currentXp: number; nextLevelXp: number; progress: number } {
    // Each level requires progressively more XP: base * level
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
}): number {
    const { productiveMinutes, distractionMinutes, tasksCompleted, totalTasks, habitsCompleted, totalHabits } = stats;

    const totalActive = productiveMinutes + distractionMinutes;
    const focusScore = totalActive > 0 ? (productiveMinutes / totalActive) * 40 : 20;
    const taskScore = totalTasks > 0 ? (tasksCompleted / totalTasks) * 30 : 15;
    const habitScore = totalHabits > 0 ? (habitsCompleted / totalHabits) * 30 : 15;

    return Math.min(100, Math.round(focusScore + taskScore + habitScore));
}

// -----------------------------------------------------------------------------
// Omni-Device Overlap Deduplication
// Maps every activity to an 86400 array (seconds in a day) to precisely calculate
// total active time without double-counting when multiple devices track simultaneously.
// Tie-breaks overlapping categories: Distraction > Productive > Neutral
// -----------------------------------------------------------------------------
export function getDailyActivityStats(db: Database, dateString: string) {
    const activities = db.prepare(`SELECT category, started_at, ended_at, duration_seconds, is_actively_interacting FROM activities WHERE date(started_at, 'localtime') = ?`).all(dateString) as any[];

    // Array of 86400 elements representing each second of the day
    const day = new Uint8Array(86400);
    // 0 = none
    // Idle plane: 1 = neutral, 2 = productive, 3 = distraction
    // Active plane: 4 = neutral, 5 = productive, 6 = distraction
    const categoryMapIdle: Record<string, number> = { neutral: 1, productive: 2, distraction: 3 };
    const categoryMapActive: Record<string, number> = { neutral: 4, productive: 5, distraction: 6 };

    let totalActivities = activities.length;
    if (totalActivities === 0) {
        return { productive_minutes: 0, distraction_minutes: 0, neutral_minutes: 0, total_minutes: 0, total_activities: 0 };
    }

    const sysOffset = new Date().getTimezoneOffset() * 60000;
    const midnightObj = new Date(dateString + 'T00:00:00');
    // Account for local timezone offsets to correctly anchor midnight
    const midnight = new Date(midnightObj.getTime() + midnightObj.getTimezoneOffset() * 60000 - sysOffset).getTime();

    for (const a of activities) {
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
