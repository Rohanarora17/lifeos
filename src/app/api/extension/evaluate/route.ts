import { NextRequest, NextResponse } from 'next/server';
import { getGenAI } from '@/lib/ai';

// POST: Evaluates if a given URL is a distraction based on the user's active goals
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { url, title, activeGoals } = body;

        if (!url || !activeGoals) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });

        const goalsList = activeGoals.map((g: any) => `- ${g.title}: ${g.description}`).join('\n');

        const prompt = `You are a strict but fair productivity AI built into the user's browser.
The user's currently active goals are:
${goalsList}

The user just opened a new tab:
URL: "${url}"
Title: "${title}"

Is this website a distraction from ALL of their active goals?
If the website is a general tool (e.g. Wikipedia, a blog, a coding resource) and it aligns with their goals, allow it.
If the website is a known universal time-sink (e.g. YouTube, Twitter, Instagram, Reddit) AND does not align specifically with their goals, block it.
If they have no active goals, do not block it.

Return JSON matching { "isDistraction": boolean, "reason": "1-sentence supportive explanation" }`;

        const model = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
            }
        });

        const evaluation = JSON.parse(result.response.text());

        return NextResponse.json(evaluation);
    } catch (error) {
        console.error('Extension Evaluate API Error:', error);
        // Fail open - don't block if the AI fails
        return NextResponse.json({ isDistraction: false, reason: 'AI Error - Defaulting to Allow' });
    }
}
