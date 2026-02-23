import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';

// POST: Accepts highlighted text from the Chrome Extension context menu,
// passes it through Gemini with the user's active goals, and inserts a Task.
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { text, url, title: pageTitle } = body;

        if (!text) {
            return NextResponse.json({ error: 'No text provided' }, { status: 400 });
        }

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });

        const db = getDb();
        const activeGoals = db.prepare("SELECT id, title FROM goals WHERE active = 1").all() as { id: number, title: string }[];
        const goalsList = activeGoals.map(g => `[ID: ${g.id}] ${g.title}`).join('\n');

        const prompt = `You are an AI Task Extractor for the LifeOS application.
The user highlighted text on a webpage:
Webpage Title: "${pageTitle}"
URL: "${url}"
Highlighted Text: "${text}"

Your job is to extract an actionable task from this snippet.
Here are the user's currently active goals:
${goalsList}

Return JSON matching this schema:
{
  "title": "Short actionable task title",
  "description": "More context, optionally integrating why this matters based on the highlight.",
  "priority": "low" | "medium" | "high" | "critical",
  "goal_id": (number or null) The ID of the most relevant goal, or null if unrelated.
}`;

        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
            }
        });

        const extracted = JSON.parse(result.response.text());

        // We append the URL context to the description automatically
        const finalDescription = (extracted.description || '') + '\\n\\nSource: [' + pageTitle + '](' + url + ')';

        const insert = db.prepare(`
            INSERT INTO tasks(title, description, priority, goal_id, status)
        VALUES(?, ?, ?, ?, 'todo')
        `);

        insert.run(
            extracted.title,
            finalDescription,
            extracted.priority || 'medium',
            extracted.goal_id || null
        );

        return NextResponse.json({ success: true, task: extracted });
    } catch (error) {
        console.error('Extension Task API Error:', error);
        return NextResponse.json({ error: 'Failed to process task extraction' }, { status: 500 });
    }
}
