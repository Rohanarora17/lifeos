// Scoring & gamification utilities

export interface ScoreConfig {
    xpPerTask: number;
    xpPerHabit: number;
    xpPerProductiveHour: number;
    xpPerCommit: number;
    levelXpBase: number;
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
    const today = new Date().toISOString().split('T')[0];

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
