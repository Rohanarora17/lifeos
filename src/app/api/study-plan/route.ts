import { NextRequest, NextResponse } from 'next/server';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_FLASH } from '@/lib/models';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { topic, durationMinutes, difficulty } = body;

        if (!topic || !durationMinutes) {
            return NextResponse.json({ error: 'Missing topic or duration' }, { status: 400 });
        }

        const ai = getGenAI();
        if (!ai) {
            return NextResponse.json({ error: 'AI not configured' }, { status: 500 });
        }

        const prompt = `You are an expert tutor and productivity coach. Create a highly optimized study plan for the topic: "${topic}".
The user has ${durationMinutes} minutes available and their current knowledge level is "${difficulty || 'beginner'}".
Organize the time into a series of focus blocks and breaks based on the Pomodoro technique (like 25 min work, 5 min break), but dynamically adjusted for the topic complexity and total duration.

Respond ONLY with a valid JSON object matching this schema. Do not include markdown blocks like \`\`\`json:
{
  "topic": "${topic}",
  "overview": "A brief 2-sentence summary of what will be learned",
  "blocks": [
    {
      "title": "Module title",
      "duration": number_of_minutes, 
      "type": "study" | "break",
      "description": "What to do in this block (keep it concise, 1 sentence)"
    }
  ]
}

CRITICAL RULES:
1. The sum of all block durations MUST equal exactly ${durationMinutes} minutes.
2. Start with a "study" block.
3. Every 20-30 minutes of study should be followed by a 5-10 minute "break" block.
4. The final block should be a "study" block for review, or a short break if the time ends exactly after a long study block.
5. All durations must be integers.`;

        const result = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: prompt,
            config: {
                responseMimeType: 'application/json'
            }
        });

        const text = result.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const plan = JSON.parse(jsonMatch[0]);
            return NextResponse.json(plan);
        } else {
            return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 });
        }
    } catch (error) {
        console.error('Study plan generation error:', error);
        return NextResponse.json({ error: 'Failed to generate study plan' }, { status: 500 });
    }
}
