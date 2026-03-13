import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';
import { MODEL_PRO, MODEL_FLASH } from '@/lib/models';

const DB_SCHEMA = `
TABLE activities (id, url, domain, title, category, subcategory, duration_seconds, started_at, ended_at)
TABLE tasks (id, title, description, status, due_date, created_at, completed_at, goal_id, priority)
TABLE habits (id, name, icon, frequency, goal_metric, goal_target, created_at, archived, goal_id)
TABLE habit_checkins (id, habit_id, date, completed, value)
TABLE daily_scores (date, xp_earned, productive_minutes, distraction_minutes, tasks_completed, habits_completed, ai_summary, ai_morning_brief, level, task_score, habit_score, accountability_score)
TABLE goals (id, title, type, target_value, unit, active, deadline, description, current_value, progress, metric, category)
TABLE focus_sessions (id, session_date, duration_minutes, focus_type, primary_domain, goal_title, task_title, actual_duration_seconds, productive_seconds, distraction_seconds, ai_report, status, started_at, ended_at)
TABLE behavioral_memory (id, memory_type, content, confidence, reinforcement_count, last_reinforced, superseded, source)
TABLE behavior_insights (id, category, insight, actionable_tip, severity, feedback)
TABLE alerts (id, type, message, severity, read, title, priority)
TABLE coin_ledger (id, amount, reason, created_at)
`;

export async function POST(request: NextRequest) {
    try {
        const { query } = await request.json();
        if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 });

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });


        // Step 1: Ask Gemini to convert NL to SQL based on Schema
        const prompt = `You are an expert SQL translation layer for an SQLite database.
Here is the schema:
${DB_SCHEMA}

Convert the user's natural language query into a raw SQLite SELECT query.
RULES:
1. Return ONLY the raw SQL query, absolutely no markdown formatting, no backticks, no explanations.
2. The query MUST be a SELECT statement. Never return INSERT/UPDATE/DELETE.
3. If the query requires time context, assume 'now' is the current SQLite datetime('now', 'localtime').
4. Keep it robust and account for nulls if necessary.

User Query: "${query}"`;

        const sqlResult = await ai.models.generateContent({
            model: MODEL_FLASH,
            contents: prompt
        });
        let sql = (sqlResult.text || '').trim();

        // Remove markdown backticks if Gemini ignored instructions
        if (sql.startsWith('\`\`\`sql')) sql = sql.substring(6);
        if (sql.startsWith('\`\`\`')) sql = sql.substring(3);
        if (sql.endsWith('\`\`\`')) sql = sql.substring(0, sql.length - 3);
        sql = sql.trim();

        if (!sql.toUpperCase().startsWith('SELECT')) {
            return NextResponse.json({ text: "I can only read data. I cannot modify the database through chat." });
        }

        const db = getDb();
        const stmt = db.prepare(sql);

        if (!stmt.readonly) {
            return NextResponse.json({ text: "Security Alert: The generated query attempted to modify data. Action blocked." });
        }

        const data = stmt.all();

        // Step 2: Feed data back to Gemini to generate natural language response
        const answerPrompt = `You are LifeOS, the user's personal assistant. 
The user asked: "${query}"
The database returned this raw JSON data:
${JSON.stringify(data).substring(0, 3000)}

Provide a concise, conversational answer to the user based on this data. Do not show them the raw JSON.`;

        const answerResult = await ai.models.generateContent({
            model: MODEL_PRO,
            contents: answerPrompt
        });
        return NextResponse.json({ text: (answerResult.text || '').trim() });

    } catch (error: any) {
        console.error('Chat API error:', error);
        return NextResponse.json({ text: `I encountered an error trying to pull that data: ${error.message}` });
    }
}
