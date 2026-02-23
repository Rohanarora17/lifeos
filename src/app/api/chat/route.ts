import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';

const DB_SCHEMA = `
TABLE activities (id, url, domain, title, category, subcategory, duration_seconds, started_at, ended_at)
TABLE habits (id, name, icon, frequency, streak_count, created_at, active, archived, goal_metric, goal_target, goal_id, current_streak, automaticity_score)
TABLE habit_checkins (id, habit_id, date, completed, value, created_at)
TABLE goals (id, title, description, deadline, color, category, active, created_at, status, tmt_score, priority)
TABLE tasks (id, title, description, status ('todo', 'doing', 'done', 'today', 'this_week', 'backlog'), due_date, position, goal_id, priority ('low', 'medium', 'high', 'critical'), created_at, completed_at)
TABLE focus_sessions (id, task_id, duration_minutes, created_at)
TABLE coin_ledger (id, amount, reason, created_at)
`;

export async function POST(request: NextRequest) {
    try {
        const { query } = await request.json();
        if (!query) return NextResponse.json({ error: 'Query required' }, { status: 400 });

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

        const sqlResult = await model.generateContent(prompt);
        let sql = sqlResult.response.text().trim();

        // Remove markdown backticks if Gemini ignored instructions
        if (sql.startsWith('\`\`\`sql')) sql = sql.substring(6);
        if (sql.startsWith('\`\`\`')) sql = sql.substring(3);
        if (sql.endsWith('\`\`\`')) sql = sql.substring(0, sql.length - 3);
        sql = sql.trim();

        if (!sql.toUpperCase().startsWith('SELECT')) {
            return NextResponse.json({ text: "I can only read data. I cannot modify the database through chat." });
        }

        const db = getDb();
        const data = db.prepare(sql).all();

        // Step 2: Feed data back to Gemini to generate natural language response
        const answerPrompt = `You are LifeOS, the user's personal assistant. 
The user asked: "${query}"
The database returned this raw JSON data:
${JSON.stringify(data).substring(0, 3000)}

Provide a concise, conversational answer to the user based on this data. Do not show them the raw JSON.`;

        const answerResult = await model.generateContent(answerPrompt);
        return NextResponse.json({ text: answerResult.response.text().trim() });

    } catch (error: any) {
        console.error('Chat API error:', error);
        return NextResponse.json({ text: `I encountered an error trying to pull that data: ${error.message}` });
    }
}
