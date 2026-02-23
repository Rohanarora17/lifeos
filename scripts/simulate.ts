#!/usr/bin/env npx tsx
/**
 * LifeOS Simulation Engine — "Time Machine"
 *
 * Generates realistic synthetic data across configurable date ranges
 * using predefined scenario profiles. Enables full-stack testing of
 * features that normally require days or months of real usage.
 *
 * Usage:
 *   npx tsx scripts/simulate.ts --scenario productive-developer --days 30
 *   npx tsx scripts/simulate.ts --scenario struggling-student --days 7 --test
 *   npx tsx scripts/simulate.ts --reset
 *   npx tsx scripts/simulate.ts --run-cron daily-summary
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ─── Config ──────────────────────────────────────────────────────────

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'lifeos.db');
const BACKUP_PATH = path.join(DB_DIR, `lifeos_pre_sim_${Date.now()}.db`);
const BASE_URL = 'http://localhost:3000';

// ─── Types ───────────────────────────────────────────────────────────

interface UserProfile {
    name: string;
    description: string;
    productiveRatio: number;       // 0-1, fraction of productive time
    distractionRatio: number;      // 0-1, fraction of distraction time
    activitiesPerDay: [number, number]; // min-max activities
    avgSessionMinutes: [number, number]; // min-max per session
    habitCompletionRate: number;   // 0-1
    taskCompletionRate: number;    // 0-1
    tasksCreatedPerWeek: [number, number];
    deepFocusSessionsPerDay: [number, number]; // min-max
    tabSwitchesPerHour: number;
    peakHoursStart: number;        // 0-23
    peakHoursEnd: number;          // 0-23
    weekendProductivity: number;   // multiplier 0-1
    burnoutPhase?: { startDay: number; endDay: number; severity: number };
}

// ─── Scenario Profiles ──────────────────────────────────────────────

const SCENARIOS: Record<string, UserProfile> = {
    'productive-developer': {
        name: 'Productive Developer',
        description: 'Consistent deep worker. Codes 5h/day, few distractions.',
        productiveRatio: 0.70,
        distractionRatio: 0.10,
        activitiesPerDay: [15, 35],
        avgSessionMinutes: [5, 45],
        habitCompletionRate: 0.92,
        taskCompletionRate: 0.80,
        tasksCreatedPerWeek: [4, 8],
        deepFocusSessionsPerDay: [2, 4],
        tabSwitchesPerHour: 4,
        peakHoursStart: 9,
        peakHoursEnd: 18,
        weekendProductivity: 0.3,
    },
    'struggling-student': {
        name: 'Struggling Student',
        description: 'Inconsistent. Lots of social media and entertainment.',
        productiveRatio: 0.30,
        distractionRatio: 0.45,
        activitiesPerDay: [25, 55],
        avgSessionMinutes: [1, 15],
        habitCompletionRate: 0.40,
        taskCompletionRate: 0.35,
        tasksCreatedPerWeek: [2, 5],
        deepFocusSessionsPerDay: [0, 1],
        tabSwitchesPerHour: 15,
        peakHoursStart: 12,
        peakHoursEnd: 23,
        weekendProductivity: 0.15,
    },
    'recovering-burnout': {
        name: 'Recovering Burnout',
        description: 'Good first 2 weeks, collapse in week 3, slow recovery.',
        productiveRatio: 0.55,
        distractionRatio: 0.25,
        activitiesPerDay: [10, 30],
        avgSessionMinutes: [3, 25],
        habitCompletionRate: 0.65,
        taskCompletionRate: 0.55,
        tasksCreatedPerWeek: [3, 6],
        deepFocusSessionsPerDay: [1, 3],
        tabSwitchesPerHour: 8,
        peakHoursStart: 10,
        peakHoursEnd: 19,
        weekendProductivity: 0.2,
        burnoutPhase: { startDay: 14, endDay: 21, severity: 0.6 },
    },
    'night-owl': {
        name: 'Night Owl',
        description: 'Most productive 9PM-2AM. Low daytime output.',
        productiveRatio: 0.60,
        distractionRatio: 0.20,
        activitiesPerDay: [15, 40],
        avgSessionMinutes: [5, 35],
        habitCompletionRate: 0.70,
        taskCompletionRate: 0.65,
        tasksCreatedPerWeek: [3, 7],
        deepFocusSessionsPerDay: [1, 3],
        tabSwitchesPerHour: 6,
        peakHoursStart: 21,
        peakHoursEnd: 2,   // wraps past midnight
        weekendProductivity: 0.5,
    },
    'context-switcher': {
        name: 'Context Switcher',
        description: 'Rapid tab hopping. Many short sessions, high entropy.',
        productiveRatio: 0.45,
        distractionRatio: 0.30,
        activitiesPerDay: [40, 70],
        avgSessionMinutes: [0.5, 8],
        habitCompletionRate: 0.55,
        taskCompletionRate: 0.50,
        tasksCreatedPerWeek: [5, 10],
        deepFocusSessionsPerDay: [0, 1],
        tabSwitchesPerHour: 25,
        peakHoursStart: 10,
        peakHoursEnd: 20,
        weekendProductivity: 0.25,
    },
};

// ─── Domain Pools ───────────────────────────────────────────────────

const PRODUCTIVE_DOMAINS = [
    { domain: 'github.com', sub: 'coding', titles: ['Pull Request #42', 'Issues · myproject', 'Code review', 'github.com/rohan/lifeos'] },
    { domain: 'stackoverflow.com', sub: 'research', titles: ['How to use SQLite WAL mode', 'TypeScript generics explained', 'React useEffect cleanup'] },
    { domain: 'docs.google.com', sub: 'documentation', titles: ['Project Roadmap', 'Meeting Notes Q1', 'Architecture Design Doc'] },
    { domain: 'notion.so', sub: 'productivity-tool', titles: ['Sprint Planning', 'Knowledge Base', 'Weekly Review'] },
    { domain: 'developer.mozilla.org', sub: 'documentation', titles: ['MDN Web Docs - Array.prototype.map()', 'CSS Grid Layout', 'Fetch API'] },
    { domain: 'vercel.com', sub: 'coding', titles: ['Dashboard - lifeos', 'Deployments', 'Analytics'] },
    { domain: 'linear.app', sub: 'productivity-tool', titles: ['LIF-234: Fix dashboard bug', 'Backlog', 'Sprint Board'] },
    { domain: 'arxiv.org', sub: 'research', titles: ['Attention Is All You Need', 'Diffusion Models Survey', 'RL from Human Feedback'] },
    { domain: 'figma.com', sub: 'productivity-tool', titles: ['LifeOS Dashboard v2', 'Component Library', 'Mobile Wireframes'] },
    { domain: 'coursera.org', sub: 'learning', titles: ['Machine Learning Specialization', 'Deep Learning Week 3', 'Quiz: Neural Networks'] },
];

const DISTRACTION_DOMAINS = [
    { domain: 'youtube.com', sub: 'youtube-entertainment', titles: ['Funny Cat Compilation', 'Top 10 Movie Scenes', 'Gaming Highlights 2024'] },
    { domain: 'twitter.com', sub: 'social-media', titles: ['Home / X', 'Trending', 'Notifications'] },
    { domain: 'reddit.com', sub: 'social-media', titles: ['r/programming - best IDE?', 'r/funny - top posts', 'r/gaming'] },
    { domain: 'instagram.com', sub: 'social-media', titles: ['Instagram', 'Explore', 'Reels'] },
    { domain: 'netflix.com', sub: 'entertainment', titles: ['Stranger Things S5', 'Browse', 'My List'] },
    { domain: 'tiktok.com', sub: 'social-media', titles: ['For You', 'Following', 'Discover'] },
    { domain: 'twitch.tv', sub: 'entertainment', titles: ['Live: xQc playing Minecraft', 'Browse Games', 'Following'] },
    { domain: '9gag.com', sub: 'entertainment', titles: ['Trending', 'Fresh', 'Hot'] },
];

const NEUTRAL_DOMAINS = [
    { domain: 'mail.google.com', sub: 'communication', titles: ['Inbox (3)', 'Compose', 'Sent'] },
    { domain: 'calendar.google.com', sub: 'productivity-tool', titles: ['Week View', 'Today', 'February 2026'] },
    { domain: 'slack.com', sub: 'communication', titles: ['#general', '#engineering', 'Direct Messages'] },
    { domain: 'news.ycombinator.com', sub: 'news', titles: ['Hacker News', 'Show HN', 'Ask HN'] },
    { domain: 'wikipedia.org', sub: 'research', titles: ['Artificial Intelligence', 'India', 'History of Computing'] },
];

const YOUTUBE_EDUCATIONAL = [
    { domain: 'youtube.com', sub: 'youtube-educational', titles: ['3Blue1Brown - Neural Networks', 'Fireship - 100 seconds of Rust', 'MIT OpenCourseWare Lecture 5'] },
];

// ─── Habit & Goal Templates ──────────────────────────────────────────

const HABIT_TEMPLATES = [
    { name: 'Morning Meditation', icon: '🧘' },
    { name: 'Exercise', icon: '💪' },
    { name: 'Read 30 minutes', icon: '📚' },
    { name: 'Journal', icon: '📝' },
    { name: 'No Social Media before 12pm', icon: '📵' },
    { name: 'Drink 2L Water', icon: '💧' },
];

const GOAL_TEMPLATES = [
    { title: 'Ship LifeOS V1', type: 'build_feature' as const, description: 'Complete the LifeOS productivity dashboard' },
    { title: 'Learn Rust', type: 'learn_skill' as const, description: 'Complete Rust book and build a CLI project' },
    { title: 'Maintain 30-day streak', type: 'general' as const, description: 'Build consistent daily habits for 30 days' },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function formatDateTime(d: Date): string {
    return d.toISOString().replace('T', ' ').slice(0, 19);
}

function isWeekend(d: Date): boolean {
    const day = d.getDay();
    return day === 0 || day === 6;
}

/** Log-normal duration in seconds for realistic session length distribution */
function logNormalDuration(minMinutes: number, maxMinutes: number): number {
    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const mean = Math.log((minMinutes + maxMinutes) / 2);
    const sigma = 0.8;
    const minutes = Math.exp(mean + sigma * z);
    return Math.max(minMinutes * 60, Math.min(maxMinutes * 60, Math.round(minutes * 60)));
}

// ─── Core Simulation ─────────────────────────────────────────────────

function runSimulation(db: Database.Database, profile: UserProfile, days: number) {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);

    console.log(`\n🎬 Simulating "${profile.name}" for ${days} days`);
    console.log(`   ${profile.description}`);
    console.log(`   Date range: ${formatDate(startDate)} → ${formatDate(now)}\n`);

    // Step 1: Seed goals
    const goalIds = seedGoals(db);
    console.log(`  ✅ Seeded ${goalIds.length} goals`);

    // Step 2: Seed habits
    const habitIds = seedHabits(db, goalIds);
    console.log(`  ✅ Seeded ${habitIds.length} habits`);

    // Step 3: Seed domain_categories cache (so we skip AI calls)
    seedDomainCategories(db);
    console.log(`  ✅ Seeded domain_categories cache`);

    // Step 4: Seed implementation intentions
    seedIntentions(db, goalIds);
    console.log(`  ✅ Seeded implementation intentions`);

    // Step 5: Generate data for each day
    let totalActivities = 0;
    let totalTasks = 0;
    let totalCheckins = 0;

    for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + dayOffset);
        const dateStr = formatDate(date);
        const dayOfWeek = date.getDay();

        // Compute effective profile for this day (burnout modulation)
        const effectiveProfile = getEffectiveProfile(profile, dayOffset);

        // Activities
        const activities = generateActivities(db, effectiveProfile, date);
        totalActivities += activities.length;

        // Tab switches from activity transitions
        generateTabSwitches(db, activities, date);

        // Tasks (create new ones ~weekly, complete some daily)
        const taskCount = generateTasks(db, effectiveProfile, date, goalIds, dayOffset);
        totalTasks += taskCount;

        // Habit check-ins
        const checkinCount = generateHabitCheckins(db, effectiveProfile, dateStr, habitIds);
        totalCheckins += checkinCount;

        // Focus sessions
        generateFocusSessions(db, effectiveProfile, dateStr, activities);

        // Daily score
        generateDailyScore(db, dateStr, activities, habitIds, effectiveProfile);

        // Nudges on distraction-heavy days
        generateNudges(db, effectiveProfile, dateStr, activities);

        // Progress bar
        const pct = Math.round((dayOffset / days) * 100);
        process.stdout.write(`\r  📅 Day ${dayOffset + 1}/${days} (${dateStr}) [${pct}%]`);
    }

    console.log(`\n\n  📊 Simulation Summary:`);
    console.log(`     Activities: ${totalActivities}`);
    console.log(`     Tasks:      ${totalTasks}`);
    console.log(`     Checkins:   ${totalCheckins}`);
    console.log(`     Habits:     ${habitIds.length}`);
    console.log(`     Goals:      ${goalIds.length}\n`);
}

function getEffectiveProfile(profile: UserProfile, dayOffset: number): UserProfile {
    if (!profile.burnoutPhase) return profile;
    const { startDay, endDay, severity } = profile.burnoutPhase;

    if (dayOffset >= startDay && dayOffset <= endDay) {
        // During burnout: reduce productivity, increase distractions
        return {
            ...profile,
            productiveRatio: profile.productiveRatio * (1 - severity),
            distractionRatio: Math.min(0.7, profile.distractionRatio + severity * 0.3),
            habitCompletionRate: profile.habitCompletionRate * (1 - severity * 0.5),
            taskCompletionRate: profile.taskCompletionRate * (1 - severity * 0.5),
            deepFocusSessionsPerDay: [0, 1],
            tabSwitchesPerHour: profile.tabSwitchesPerHour * (1 + severity),
        };
    } else if (dayOffset > endDay) {
        // Recovery: gradually improve
        const recoveryDays = dayOffset - endDay;
        const recovery = Math.min(1, recoveryDays / 14); // Full recovery over 2 weeks
        return {
            ...profile,
            productiveRatio: profile.productiveRatio * (1 - severity * (1 - recovery)),
            distractionRatio: profile.distractionRatio + severity * 0.3 * (1 - recovery),
            habitCompletionRate: profile.habitCompletionRate * (1 - severity * 0.5 * (1 - recovery)),
        };
    }
    return profile;
}

// ─── Data Generators ─────────────────────────────────────────────────

function seedGoals(db: Database.Database): number[] {
    const ids: number[] = [];
    for (const g of GOAL_TEMPLATES) {
        const result = db.prepare(`
            INSERT INTO goals (title, type, description, active, deadline, category, metric)
            VALUES (?, ?, ?, 1, date('now', '+30 days'), 'productivity', 'tasks')
        `).run(g.title, g.type, g.description);
        ids.push(Number(result.lastInsertRowid));
    }
    return ids;
}

function seedHabits(db: Database.Database, goalIds: number[]): number[] {
    const ids: number[] = [];
    for (let i = 0; i < HABIT_TEMPLATES.length; i++) {
        const h = HABIT_TEMPLATES[i];
        const goalId = goalIds[i % goalIds.length]; // rotate through goals
        const result = db.prepare(`
            INSERT INTO habits (name, icon, frequency, goal_id) VALUES (?, ?, 'daily', ?)
        `).run(h.name, h.icon, goalId);
        ids.push(Number(result.lastInsertRowid));
    }
    return ids;
}

function seedDomainCategories(db: Database.Database) {
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
        VALUES (?, ?, ?, 0.9, ?)
    `);

    for (const d of PRODUCTIVE_DOMAINS) {
        stmt.run(d.domain, 'productive', d.sub, 'Seeded by simulation');
    }
    for (const d of DISTRACTION_DOMAINS) {
        stmt.run(d.domain, 'distraction', d.sub, 'Seeded by simulation');
    }
    for (const d of NEUTRAL_DOMAINS) {
        stmt.run(d.domain, 'neutral', d.sub, 'Seeded by simulation');
    }
    for (const d of YOUTUBE_EDUCATIONAL) {
        stmt.run(d.domain, 'productive', d.sub, 'Seeded by simulation (educational)');
    }
}

function seedIntentions(db: Database.Database, goalIds: number[]) {
    const intentions = [
        { if_cond: 'I open Twitter or Reddit', then_act: 'Close the tab and do one Pomodoro', goal: 0 },
        { if_cond: 'I feel like procrastinating', then_act: 'Start with the smallest task on my list', goal: 0 },
        { if_cond: 'I finish a focus session', then_act: 'Take a 5-minute walk', goal: 2 },
    ];

    for (const int of intentions) {
        try {
            db.prepare(`
                INSERT INTO intentions (if_condition, then_action, goal_id, active)
                VALUES (?, ?, ?, 1)
            `).run(int.if_cond, int.then_act, goalIds[int.goal] || null);
        } catch { /* ignore if already exists */ }
    }
}

function generateActivities(db: Database.Database, profile: UserProfile, date: Date): any[] {
    const dateStr = formatDate(date);
    const weekend = isWeekend(date);
    const activityCount = rand(profile.activitiesPerDay[0], profile.activitiesPerDay[1]);
    const effectiveCount = weekend ? Math.round(activityCount * profile.weekendProductivity) : activityCount;
    const activities: any[] = [];

    const stmt = db.prepare(`
        INSERT INTO activities (url, domain, title, category, subcategory, started_at, ended_at, duration_seconds, ai_classification, youtube_video_id, youtube_channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < Math.max(3, effectiveCount); i++) {
        // Pick category based on profile ratios
        const roll = Math.random();
        let pool: typeof PRODUCTIVE_DOMAINS;
        let category: string;

        if (roll < profile.productiveRatio) {
            // 15% chance of educational YouTube counting as productive
            pool = Math.random() < 0.15 ? YOUTUBE_EDUCATIONAL : PRODUCTIVE_DOMAINS;
            category = 'productive';
        } else if (roll < profile.productiveRatio + profile.distractionRatio) {
            pool = DISTRACTION_DOMAINS;
            category = 'distraction';
        } else {
            pool = NEUTRAL_DOMAINS;
            category = 'neutral';
        }

        const entry = pick(pool);
        const title = pick(entry.titles);
        const duration = logNormalDuration(profile.avgSessionMinutes[0], profile.avgSessionMinutes[1]);

        // Distribute time across the day, biased toward peak hours
        const hour = generateHour(profile, weekend);
        const minute = rand(0, 59);

        const startTime = new Date(date);
        startTime.setHours(hour, minute, rand(0, 59));

        const endTime = new Date(startTime.getTime() + duration * 1000);
        const url = `https://${entry.domain}/${Math.random().toString(36).slice(2, 8)}`;

        const isYouTube = entry.domain === 'youtube.com';
        const videoId = isYouTube ? `dQw4w9WgXc${rand(0, 9)}` : null;
        const channel = isYouTube ? pick(['3Blue1Brown', 'Fireship', 'MrBeast', 'Veritasium', 'PewDiePie']) : null;

        const act = {
            url,
            domain: entry.domain,
            title,
            category,
            subcategory: entry.sub,
            started_at: formatDateTime(startTime),
            ended_at: formatDateTime(endTime),
            duration_seconds: duration,
            youtube_video_id: videoId,
            youtube_channel: channel,
        };

        stmt.run(
            act.url, act.domain, act.title, act.category, act.subcategory,
            act.started_at, act.ended_at, act.duration_seconds,
            JSON.stringify({ category: act.category, subcategory: act.subcategory, confidence: 'high' }),
            act.youtube_video_id, act.youtube_channel
        );

        activities.push(act);
    }

    return activities;
}

function generateHour(profile: UserProfile, weekend: boolean): number {
    // Bias heavily toward peak hours
    const { peakHoursStart, peakHoursEnd } = profile;
    const isPeakHour = Math.random() < (weekend ? 0.5 : 0.75);

    if (isPeakHour) {
        if (peakHoursEnd > peakHoursStart) {
            return rand(peakHoursStart, peakHoursEnd);
        } else {
            // Night owl: wraps past midnight (e.g., 21-2)
            const totalHours = (24 - peakHoursStart) + peakHoursEnd;
            const offset = rand(0, totalHours);
            return (peakHoursStart + offset) % 24;
        }
    } else {
        // Off-peak: any hour 7-23
        return rand(7, 23);
    }
}

function generateTabSwitches(db: Database.Database, activities: any[], date: Date) {
    if (activities.length < 2) return;

    const stmt = db.prepare(`
        INSERT INTO tab_switches (from_domain, to_domain, from_category, to_category, switched_at)
        VALUES (?, ?, ?, ?, ?)
    `);

    // Sort by start time
    const sorted = [...activities].sort((a, b) => a.started_at.localeCompare(b.started_at));

    for (let i = 1; i < sorted.length; i++) {
        const from = sorted[i - 1];
        const to = sorted[i];
        if (from.domain !== to.domain) {
            stmt.run(from.domain, to.domain, from.category, to.category, to.started_at);
        }
    }
}

function generateTasks(db: Database.Database, profile: UserProfile, date: Date, goalIds: number[], dayOffset: number): number {
    let created = 0;

    // Create new tasks on Mondays or every ~3 days
    if (dayOffset % 3 === 0 || date.getDay() === 1) {
        const count = rand(profile.tasksCreatedPerWeek[0], profile.tasksCreatedPerWeek[1]);
        const taskTitles = [
            'Fix login page bug', 'Write unit tests for API', 'Review PR #42',
            'Update documentation', 'Deploy to staging', 'Fix CSS responsive layout',
            'Implement search filter', 'Optimize database queries', 'Add error handling',
            'Refactor auth module', 'Setup CI/CD pipeline', 'Create onboarding flow',
            'Design settings page', 'Audit security headers', 'Update dependencies',
        ];
        const priorities = ['low', 'medium', 'medium', 'high', 'critical'];
        const statuses = ['backlog', 'this_week', 'today'];

        for (let i = 0; i < Math.min(count, 3); i++) {
            const title = pick(taskTitles) + ` (${formatDate(date).slice(5)})`;
            db.prepare(`
                INSERT INTO tasks (title, status, priority, goal_id, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(title, pick(statuses), pick(priorities), pick(goalIds), formatDateTime(date));
            created++;
        }
    }

    // Complete some tasks based on profile rate
    if (Math.random() < profile.taskCompletionRate) {
        const doable = db.prepare(
            `SELECT id FROM tasks WHERE status IN ('today', 'doing', 'this_week') ORDER BY RANDOM() LIMIT ?`
        ).all(rand(1, 3)) as { id: number }[];

        for (const task of doable) {
            db.prepare(
                `UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?`
            ).run(formatDateTime(date), task.id);
        }
    }

    // Advance some backlog tasks to active
    if (Math.random() < 0.4) {
        db.prepare(
            `UPDATE tasks SET status = 'today' WHERE id IN (SELECT id FROM tasks WHERE status = 'backlog' ORDER BY RANDOM() LIMIT 2)`
        ).run();
    }

    return created;
}

function generateHabitCheckins(db: Database.Database, profile: UserProfile, dateStr: string, habitIds: number[]): number {
    let count = 0;
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO habit_checkins (habit_id, date, completed, value) VALUES (?, ?, ?, 1)
    `);

    for (const id of habitIds) {
        if (Math.random() < profile.habitCompletionRate) {
            stmt.run(id, dateStr, 1);
            count++;
        }
    }
    return count;
}

function generateFocusSessions(db: Database.Database, profile: UserProfile, dateStr: string, activities: any[]) {
    const count = rand(profile.deepFocusSessionsPerDay[0], profile.deepFocusSessionsPerDay[1]);
    if (count === 0) return;

    const productiveActs = activities.filter(a => a.category === 'productive');
    if (productiveActs.length === 0) return;

    const stmt = db.prepare(`
        INSERT INTO focus_sessions (session_date, start_time, end_time, duration_minutes, focus_type, primary_domain, primary_category, tab_switches, context_switches, flow_state_detected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < count; i++) {
        const act = pick(productiveActs);
        const duration = rand(10, 60);
        const focusType = duration >= 45 ? 'deep' :
            duration >= 25 ? 'moderate' :
                duration >= 10 ? 'shallow' : 'fragmented';
        const tabSwitches = focusType === 'deep' ? rand(0, 3) : rand(3, 15);
        const flowDetected = focusType === 'deep' && Math.random() < 0.6 ? 1 : 0;

        const start = new Date(`${dateStr}T${String(rand(8, 21)).padStart(2, '0')}:${String(rand(0, 59)).padStart(2, '0')}:00`);
        const end = new Date(start.getTime() + duration * 60000);

        stmt.run(
            dateStr, formatDateTime(start), formatDateTime(end),
            duration, focusType, act.domain, 'productive',
            tabSwitches, Math.floor(tabSwitches / 3), flowDetected
        );
    }
}

function generateDailyScore(db: Database.Database, dateStr: string, activities: any[], habitIds: number[], profile: UserProfile) {
    const prodMin = Math.round(activities.filter(a => a.category === 'productive').reduce((s, a) => s + a.duration_seconds, 0) / 60);
    const distMin = Math.round(activities.filter(a => a.category === 'distraction').reduce((s, a) => s + a.duration_seconds, 0) / 60);
    const neutMin = Math.round(activities.filter(a => a.category === 'neutral').reduce((s, a) => s + a.duration_seconds, 0) / 60);

    const tasksCompleted = (db.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND date(completed_at) = ?`
    ).get(dateStr) as { c: number }).c;

    const habitsCompleted = (db.prepare(
        `SELECT COUNT(DISTINCT habit_id) as c FROM habit_checkins WHERE date = ? AND completed = 1`
    ).get(dateStr) as { c: number }).c;

    const tasksActive = (db.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE status IN ('today', 'doing', 'this_week')`
    ).get() as { c: number }).c;

    // Simple XP formula
    const xp = (tasksCompleted * 50) + (habitsCompleted * 20) + Math.round(prodMin * 0.5);

    try {
        db.prepare(`
            INSERT OR REPLACE INTO daily_scores (date, xp_earned, productive_minutes, distraction_minutes, neutral_minutes,
                tasks_completed, habits_completed, total_habits, tasks_assigned, tasks_pending, task_score, habit_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            dateStr, xp, prodMin, distMin, neutMin,
            tasksCompleted, habitsCompleted, habitIds.length,
            tasksActive + tasksCompleted, tasksActive,
            tasksCompleted > 0 ? Math.min(100, Math.round((tasksCompleted / Math.max(tasksActive + tasksCompleted, 1)) * 100)) : 0,
            habitIds.length > 0 ? Math.round((habitsCompleted / habitIds.length) * 100) : 0
        );
    } catch { /* daily_subscores columns may not exist */ }
}

function generateNudges(db: Database.Database, profile: UserProfile, dateStr: string, activities: any[]) {
    const distractionActs = activities.filter(a => a.category === 'distraction' && a.duration_seconds > 600);
    if (distractionActs.length === 0) return;

    const stmt = db.prepare(`
        INSERT INTO nudge_log (message, domain, duration_minutes, created_at)
        VALUES (?, ?, ?, ?)
    `);

    // Generate nudges for long distraction sessions
    for (const act of distractionActs.slice(0, 3)) {
        const minutes = Math.round(act.duration_seconds / 60);
        stmt.run(
            `⚠️ You've been on ${act.domain} for ${minutes} minutes`,
            act.domain, minutes,
            act.started_at
        );
    }

    // Simulate some overrides (for testing auto-learning)
    if (Math.random() < 0.3) {
        const overrideDomain = pick(distractionActs).domain;
        for (let i = 0; i < rand(1, 4); i++) {
            db.prepare(`
                INSERT INTO nudge_log (message, domain, duration_minutes, created_at)
                VALUES (?, ?, 0, ?)
            `).run(`[OVERRIDE] User overrode AI block on ${overrideDomain}`, overrideDomain, `${dateStr} ${rand(10, 20)}:${rand(0, 59)}:00`);
        }
    }
}

// ─── Database Operations ─────────────────────────────────────────────

function resetDatabase(db: Database.Database) {
    console.log('🗑️  Resetting database (preserving schema)...');
    const tables = [
        'activities', 'tasks', 'habits', 'habit_checkins', 'daily_scores',
        'tab_switches', 'focus_sessions', 'nudge_log', 'behavioral_memory',
        'behavior_snapshots', 'behavior_insights', 'behavior_profile',
        'domain_categories', 'alerts', 'intentions', 'coin_ledger',
        'user_badges', 'github_activity', 'calendar_events', 'screen_time',
        'goals',
    ];

    for (const table of tables) {
        try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table may not exist */ }
    }

    // Reset auto-increment counters
    try { db.prepare(`DELETE FROM sqlite_sequence`).run(); } catch { }

    console.log('  ✅ All user data cleared. Schema preserved.');
}

// ─── Cron Job Runner ─────────────────────────────────────────────────

async function runCronJob(jobName: string) {
    console.log(`\n⏰ Running cron job: ${jobName}`);

    const routes: Record<string, { url: string; method: string; body?: any }> = {
        'daily-summary': { url: `${BASE_URL}/api/summary`, method: 'POST' },
        'alert-engine': { url: `${BASE_URL}/api/alerts/engine`, method: 'POST' },
        'gamification': { url: `${BASE_URL}/api/gamification/engine`, method: 'POST' },
        'weekly-review': { url: `${BASE_URL}/api/weekly`, method: 'POST' },
        'backup': { url: `${BASE_URL}/api/cron?action=backup`, method: 'POST' },
        'archive': { url: `${BASE_URL}/api/cron?action=archive`, method: 'POST' },
        'behavior': { url: `${BASE_URL}/api/behavior`, method: 'POST' },
    };

    const route = routes[jobName];
    if (!route) {
        console.error(`  ❌ Unknown cron job: ${jobName}. Available: ${Object.keys(routes).join(', ')}`);
        return;
    }

    try {
        const res = await fetch(route.url, {
            method: route.method,
            headers: { 'Content-Type': 'application/json' },
            body: route.body ? JSON.stringify(route.body) : undefined,
        });
        const data = await res.json();
        console.log(`  ${res.ok ? '✅' : '❌'} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    } catch (err: any) {
        console.error(`  ❌ Failed to reach ${route.url}: ${err.message}`);
        console.error(`     Is the dev server running? (npm run dev)`);
    }
}

// ─── Main Entry Point ────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    const scenarioArg = args.find(a => a.startsWith('--scenario'))
        ? args[args.indexOf('--scenario') + 1] || args.find(a => a.startsWith('--scenario='))?.split('=')[1]
        : null;
    const daysArg = args.find(a => a.startsWith('--days'))
        ? parseInt(args[args.indexOf('--days') + 1] || '30')
        : 30;
    const shouldTest = args.includes('--test');
    const shouldReset = args.includes('--reset');
    const cronJob = args.find(a => a.startsWith('--run-cron'))
        ? args[args.indexOf('--run-cron') + 1]
        : null;

    console.log('╔══════════════════════════════════════════╗');
    console.log('║    🧪 LifeOS Simulation Engine v1.0     ║');
    console.log('╚══════════════════════════════════════════╝');

    // Handle cron job runner mode
    if (cronJob) {
        await runCronJob(cronJob);
        return;
    }

    // Open database
    if (!fs.existsSync(DB_PATH)) {
        console.error(`❌ Database not found at ${DB_PATH}. Run the app first (npm run dev).`);
        process.exit(1);
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Handle reset
    if (shouldReset) {
        // Backup before reset
        fs.copyFileSync(DB_PATH, BACKUP_PATH);
        console.log(`  💾 Backup saved to ${BACKUP_PATH}`);
        resetDatabase(db);
        if (!scenarioArg) {
            db.close();
            return;
        }
    }

    // Validate scenario
    if (!scenarioArg) {
        console.log('\n📋 Available scenarios:');
        for (const [key, profile] of Object.entries(SCENARIOS)) {
            console.log(`   --scenario ${key}`);
            console.log(`      ${profile.description}\n`);
        }
        console.log('Usage: npx tsx scripts/simulate.ts --scenario <name> --days <N> [--reset] [--test]');
        db.close();
        return;
    }

    const profile = SCENARIOS[scenarioArg];
    if (!profile) {
        console.error(`❌ Unknown scenario: "${scenarioArg}". Run without --scenario to see available options.`);
        db.close();
        process.exit(1);
    }

    // Backup before simulation
    if (!shouldReset) {
        fs.copyFileSync(DB_PATH, BACKUP_PATH);
        console.log(`  💾 Backup saved to ${BACKUP_PATH}`);
    }

    // Run simulation
    runSimulation(db, profile, daysArg);
    db.close();

    // Run cron jobs to populate derived data
    console.log('\n⏰ Running post-simulation cron jobs...');
    for (const job of ['alert-engine', 'gamification']) {
        await runCronJob(job);
    }

    // Optionally run test suite
    if (shouldTest) {
        console.log('\n🧪 Running API test suite...');
        const { runAllTests } = await import('./test-all');
        await runAllTests();
    }

    console.log('\n✨ Simulation complete! Open http://localhost:3000 to see the results.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
