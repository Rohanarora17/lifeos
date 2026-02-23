import { getDb } from './db';
import { getGenAI } from './ai';

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
            SELECT day, category, SUM(total_seconds) as total_seconds
            FROM (
                SELECT date(started_at, 'localtime') as day, category, SUM(duration_seconds) as total_seconds
                FROM activities
                WHERE started_at >= datetime('now', '-30 days', 'localtime')
                GROUP BY day, category
                
                UNION ALL
                
                SELECT date, category, SUM(total_duration) as total_seconds
                FROM daily_domain_aggregates
                WHERE date >= date('now', '-30 days', 'localtime')
                GROUP BY date, category
            )
            GROUP BY day, category
            ORDER BY day ASC
        `).all() as any[];

        // 2. Gather 30-day habit checkins
        const habitCheckins = db.prepare(`
            SELECT 
                h.name as habit_name,
                c.date as checkin_date
            FROM habit_checkins c
            JOIN habits h ON c.habit_id = h.id
            WHERE c.completed = 1 AND c.date >= date('now', '-30 days', 'localtime')
        `).all() as any[];

        // 3. Gather 30-day task completions
        const tasks = db.prepare(`
            SELECT 
                date(completed_at, 'localtime') as day,
                COUNT(*) as tasks_done
            FROM tasks 
            WHERE status = 'done' AND completed_at >= datetime('now', '-30 days', 'localtime')
            GROUP BY day
        `).all() as any[];

        // 4. Gather 30-day focus sessions
        const focus = db.prepare(`
            SELECT 
                date(created_at, 'localtime') as day,
                SUM(duration_minutes) as focus_minutes
            FROM focus_sessions
            WHERE created_at >= datetime('now', '-30 days', 'localtime')
            GROUP BY day
        `).all() as any[];

        // Format data into a concise text matrix for the LLM
        // We'll create a map of day -> stats
        const matrixMap: Record<string, any> = {};

        // Pre-fill last 30 days
        for (let i = 0; i < 30; i++) {
            const d = new Date(Date.now() - i * 86400000 + 19800000).toISOString().slice(0, 10);
            matrixMap[d] = {
                productive_mins: 0,
                distraction_mins: 0,
                tasks_done: 0,
                focus_mins: 0,
                habits: [],
            };
        }

        activities.forEach(a => {
            if (matrixMap[a.day]) {
                if (a.category === 'productive') matrixMap[a.day].productive_mins = Math.round(a.total_seconds / 60);
                if (a.category === 'distraction') matrixMap[a.day].distraction_mins = Math.round(a.total_seconds / 60);
            }
        });

        tasks.forEach(t => { if (matrixMap[t.day]) matrixMap[t.day].tasks_done = t.tasks_done; });
        focus.forEach(f => { if (matrixMap[f.day]) matrixMap[f.day].focus_mins = f.focus_minutes; });
        habitCheckins.forEach(h => { if (matrixMap[h.checkin_date]) matrixMap[h.checkin_date].habits.push(h.habit_name); });

        // Convert matrix to CSV-ish string to save tokens
        let matrixString = 'Date | ProdMins | DistractMins | Tasks | FocusMins | HabitsFinished\n';
        for (const [day, stats] of Object.entries(matrixMap).sort((a, b) => a[0].localeCompare(b[0]))) {
            matrixString += `${day} | ${stats.productive_mins} | ${stats.distraction_mins} | ${stats.tasks_done} | ${stats.focus_mins} | [${stats.habits.join(', ')}]\n`;
        }

        const prompt = `You are a behavioral data scientist analyzing a human's life tracking data over the last 30 days.
Your goal is to find HIDDEN PATTERNS and CORRELATIONS to help them optimize their life.

Data Matrix:
${matrixString}

Analyze the data and return EXACTLY 3 powerful insights in JSON array format:
[
  { "type": "correlation", "insight": "On days you complete your 'Morning Run' habit, your deep work output increases by 45%." },
  { "type": "warning", "insight": "Your distraction minutes spike drastically on Thursdays, usually correlating with 0 focus sessions." },
  { "type": "praise", "insight": "You completed 30% more tasks this week compared to your 30-day baseline." }
]

Keep insights specific, data-driven, and actionable. Only return the JSON array.`;

        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\\[[\\s\\S]*\\]/);

        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]) as { type: string, insight: string }[];

                // Clear old insights and insert new
                db.prepare('DELETE FROM ai_insights').run();

                const insert = db.prepare('INSERT INTO ai_insights (insight, type) VALUES (?, ?)');
                const insertMany = db.transaction((rows: any[]) => {
                    for (const row of rows) insert.run(row.insight, row.type);
                });
                insertMany(parsed);
            } catch (parseError) {
                console.error('[AI Analytics] Failed to parse Gemini JSON output:', text);
            }
        } else {
            console.error('[AI Analytics] Gemini output did not contain valid JSON array:', text);
        }

    } catch (error) {
        console.error('Failed to generate deep correlations:', error);
    }
}
