import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { buildAdaptiveInsightsPolicy } from './adaptive-insights-policy';
import { buildPersonalizationSnapshot, formatPersonalizationContext } from './personalization-context';

interface ActivityAggregateRow {
    day: string;
    category: string;
    active_seconds: number;
    idle_seconds: number;
}

interface HabitCheckinRow {
    habit_name: string;
    checkin_date: string;
}

interface TaskCompletionRow {
    day: string;
    tasks_done: number;
}

interface FocusAggregateRow {
    day: string;
    focus_minutes: number;
}

interface DayContextRow {
    day: string;
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    day_events: string | null;
    tomorrow_intention: string | null;
}

interface DayMatrix {
    productive_mins: number;
    distraction_mins: number;
    idle_mins: number;
    tasks_done: number;
    focus_mins: number;
    habits: string[];
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    day_events: string | null;
    tomorrow_intention: string | null;
}

interface AiInsightRow {
    type: string;
    insight: string;
}

function isAiInsightRow(value: unknown): value is AiInsightRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.type === 'string' && typeof row.insight === 'string';
}

/**
 * The Hidden Patterns Engine
 * Aggregates 30 days of user data and prompts Gemini to find hidden behavioral correlations.
 */
export async function generateDeepCorrelations(): Promise<void> {
    const ai = getGenAI();
    if (!ai) return;

    try {
        const db = getDb();

        // 1. Gather 30-day activity logs (duration per category per day)
        // UNION raw activities with the compressed `daily_domain_aggregates` to preserve older pruned data
        const activities = db.prepare(`
            SELECT day, category, SUM(active_seconds) as active_seconds, SUM(idle_seconds) as idle_seconds
            FROM (
                SELECT 
                    date(started_at, 'localtime') as day, 
                    category, 
                    SUM(CASE WHEN is_actively_interacting = 1 THEN duration_seconds ELSE 0 END) as active_seconds,
                    SUM(CASE WHEN is_actively_interacting = 0 THEN duration_seconds ELSE 0 END) as idle_seconds
                FROM activities
                WHERE started_at >= datetime('now', '-30 days', 'localtime')
                GROUP BY day, category
                
                UNION ALL
                
                SELECT 
                    date, 
                    category, 
                    SUM(total_duration) as active_seconds, 
                    0 as idle_seconds
                FROM daily_domain_aggregates
                WHERE date >= date('now', '-30 days', 'localtime')
                GROUP BY date, category
            )
            GROUP BY day, category
            ORDER BY day ASC
        `).all() as ActivityAggregateRow[];

        // 2. Gather 30-day habit checkins
        const habitCheckins = db.prepare(`
            SELECT 
                h.name as habit_name,
                c.date as checkin_date
            FROM habit_checkins c
            JOIN habits h ON c.habit_id = h.id
            WHERE c.completed = 1 AND c.date >= date('now', '-30 days', 'localtime')
        `).all() as HabitCheckinRow[];

        // 3. Gather 30-day task completions
        const tasks = db.prepare(`
            SELECT 
                date(completed_at, 'localtime') as day,
                COUNT(*) as tasks_done
            FROM tasks 
            WHERE status = 'done' AND completed_at >= datetime('now', '-30 days', 'localtime')
            GROUP BY day
        `).all() as TaskCompletionRow[];

        // 4. Gather 30-day focus sessions
        const focus = db.prepare(`
            SELECT
                date(COALESCE(started_at, completed_at), 'localtime') as day,
                SUM(elapsed_minutes) as focus_minutes
            FROM guardian_session_summaries
            WHERE COALESCE(started_at, completed_at) >= datetime('now', '-30 days', 'localtime')
            GROUP BY day
        `).all() as FocusAggregateRow[];

        // 5. Gather day-state context from evening check-ins and generated plans.
        const dayContext = db.prepare(`
            WITH RECURSIVE days(value) AS (
                SELECT 0
                UNION ALL
                SELECT value + 1 FROM days WHERE value < 29
            )
            SELECT
                d.day,
                COALESCE(p.sleep_time, c.sleep_time) as sleep_time,
                COALESCE(p.wake_estimate, c.wake_estimate) as wake_estimate,
                COALESCE(p.mood, c.mood) as mood,
                COALESCE(p.energy, c.energy) as energy,
                COALESCE(p.evening_notes, c.day_events) as day_events,
                COALESCE(p.tomorrow_intention, c.tomorrow_intention) as tomorrow_intention
            FROM (
                SELECT date('now', '-' || value || ' days', 'localtime') as day
                FROM days
            ) d
            LEFT JOIN daily_plans p ON p.plan_date = d.day
            LEFT JOIN daily_checkins c ON c.checkin_date = d.day AND c.checkin_type = 'evening'
            ORDER BY d.day ASC
        `).all() as DayContextRow[];

        const personalization = buildPersonalizationSnapshot({
            surface: 'analytics',
            maxInsights: 4,
            includeThresholds: true,
            includeMemoryFacts: 6,
        });
        const adaptivePolicy = buildAdaptiveInsightsPolicy(personalization);

        // Format data into a concise text matrix for the LLM
        // We'll create a map of day -> stats
        const matrixMap: Record<string, DayMatrix> = {};

        // Pre-fill last 30 days
        for (let i = 0; i < 30; i++) {
            const d = new Date(Date.now() - i * 86400000 + 19800000).toISOString().slice(0, 10);
            matrixMap[d] = {
                productive_mins: 0,
                distraction_mins: 0,
                idle_mins: 0,
                tasks_done: 0,
                focus_mins: 0,
                habits: [],
                sleep_time: null,
                wake_estimate: null,
                mood: null,
                energy: null,
                day_events: null,
                tomorrow_intention: null,
            };
        }

        activities.forEach(a => {
            if (matrixMap[a.day]) {
                if (a.category === 'productive') {
                    matrixMap[a.day].productive_mins = Math.round(a.active_seconds / 60);
                }
                if (a.category === 'distraction') {
                    matrixMap[a.day].distraction_mins = Math.round(a.active_seconds / 60);
                }
                matrixMap[a.day].idle_mins += Math.round(a.idle_seconds / 60);
            }
        });

        tasks.forEach(t => { if (matrixMap[t.day]) matrixMap[t.day].tasks_done = t.tasks_done; });
        focus.forEach(f => { if (matrixMap[f.day]) matrixMap[f.day].focus_mins = f.focus_minutes; });
        habitCheckins.forEach(h => { if (matrixMap[h.checkin_date]) matrixMap[h.checkin_date].habits.push(h.habit_name); });
        dayContext.forEach(day => {
            if (!matrixMap[day.day]) return;
            matrixMap[day.day].sleep_time = day.sleep_time;
            matrixMap[day.day].wake_estimate = day.wake_estimate;
            matrixMap[day.day].mood = day.mood;
            matrixMap[day.day].energy = day.energy;
            matrixMap[day.day].day_events = day.day_events;
            matrixMap[day.day].tomorrow_intention = day.tomorrow_intention;
        });

        // Convert matrix to CSV-ish string to save tokens
        let matrixString = 'Date | ActiveProdMins | ActiveDistractMins | IdleMins | Tasks | FocusMins | Mood | Energy | Sleep | Wake | DayEvents | TomorrowIntention | HabitsFinished\n';
        for (const [day, stats] of Object.entries(matrixMap).sort((a, b) => a[0].localeCompare(b[0]))) {
            matrixString += `${day} | ${stats.productive_mins} | ${stats.distraction_mins} | ${stats.idle_mins} | ${stats.tasks_done} | ${stats.focus_mins} | ${stats.mood ?? ''} | ${stats.energy ?? ''} | ${stats.sleep_time ?? ''} | ${stats.wake_estimate ?? ''} | ${(stats.day_events ?? '').slice(0, 160)} | ${(stats.tomorrow_intention ?? '').slice(0, 120)} | [${stats.habits.join(', ')}]\n`;
        }

        const prompt = `You are LifeOS analyzing one specific person, not a generic productivity user.
Your goal is to find HIDDEN PATTERNS and CORRELATIONS that fit their current day, feedback, goals, and learned behavior.

${formatPersonalizationContext(personalization)}

=== ANALYTICS LENS ===
Mode: ${adaptivePolicy.mode}
Tone: ${adaptivePolicy.insightTone}
Lens: ${adaptivePolicy.lensTitle}
Summary: ${adaptivePolicy.lensSummary}
Recommended analysis: ${adaptivePolicy.recommendedAnalysis}
Interpretation rules:
${adaptivePolicy.interpretationRules.map(rule => `- ${rule}`).join('\n')}

Data Matrix:
${matrixString}

NOTE: "Active" means they were physically moving the mouse or typing on the app. "IdleMins" means the app was open but they stepped away from the computer or stopped interacting entirely (like watching a long video or walking away).

Analyze the data and return EXACTLY 3 powerful insights in JSON array format:
[
  { "type": "correlation", "insight": "..." },
  { "type": "warning", "insight": "..." },
  { "type": "praise", "insight": "..." }
]

Rules:
- Use only patterns supported by the matrix or personalization context.
- Reference actual habits, task pressure, focus windows, sleep, mood, energy, day events, goals, or feedback signals when present.
- Adapt the wording to the analytics lens and tone above.
- Avoid universal productivity advice and format-only examples.
- Keep insights specific, data-driven, and actionable.
- Only return the JSON array.`;

        const result = await generateWithFallback(ai, {
            model: MODEL_PRO,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });
        // Strip markdown code fences the model sometimes wraps output in
        const text = (result.text || '').trim();
        const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const jsonMatch = stripped.match(/\[[\s\S]*\]/);

        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]) as unknown;
                const rows = Array.isArray(parsed) ? parsed.filter(isAiInsightRow).slice(0, 3) : [];
                if (rows.length === 0) {
                    console.error('[AI Analytics] Gemini JSON did not contain valid insight rows:', text);
                    return;
                }

                // Clear old insights and insert new
                db.prepare('DELETE FROM ai_insights').run();

                const insert = db.prepare('INSERT INTO ai_insights (insight, type) VALUES (?, ?)');
                const insertMany = db.transaction((items: AiInsightRow[]) => {
                    for (const row of items) insert.run(row.insight, row.type);
                });
                insertMany(rows);
            } catch (parseError) {
                console.error('[AI Analytics] Failed to parse Gemini JSON output:', parseError, text);
            }
        } else {
            console.error('[AI Analytics] Gemini output did not contain valid JSON array:', text);
        }

    } catch (error) {
        console.error('Failed to generate deep correlations:', error);
    }
}
