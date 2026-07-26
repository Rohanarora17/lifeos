import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_PRO } from '@/lib/models';
import { buildPersonalizationSnapshot, formatPersonalizationContext } from '@/lib/personalization-context';
import { buildAdaptiveTaskDefaults } from '@/lib/adaptive-task-defaults';

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

        const db = getDb();
        const activeGoals = db.prepare("SELECT id, title FROM goals WHERE active = 1").all() as { id: number, title: string }[];
        const goalsList = activeGoals.map(g => `[ID: ${g.id}] ${g.title}`).join('\n');
        const personalization = buildPersonalizationSnapshot({
            surface: 'tasks',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const personalizationContext = formatPersonalizationContext(personalization);

        const prompt = `You are an AI Task Extractor for the LifeOS application.
The user highlighted text on a webpage:
Webpage Title: "${pageTitle}"
URL: "${url}"
Highlighted Text: "${text}"

Your job is to extract an actionable task from this snippet.
Here are the user's currently active goals:
${goalsList}

Use this LifeOS personalization context. Do not assign priority generically; infer it from today's mode, energy, deadlines, goals, and current workload:
${personalizationContext}

Return JSON matching this schema:
{
  "title": "Short actionable task title",
  "description": "More context, optionally integrating why this matters based on the highlight.",
  "priority": "low" | "medium" | "high" | "critical",
  "energy_required": "low" | "medium" | "high",
  "estimated_minutes": number or null,
  "goal_id": (number or null) The ID of the most relevant goal, or null if unrelated.
}`;

        const result = await generateWithFallback(ai, {
            model: MODEL_PRO,
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
            }
        });

        const extracted = JSON.parse(result.text || '{}') as {
            title?: string;
            description?: string;
            priority?: string;
            energy_required?: string;
            estimated_minutes?: number | null;
            goal_id?: number | null;
        };

        // We append the URL context to the description automatically
        const finalDescription = (extracted.description || '') + '\n\nSource: [' + pageTitle + '](' + url + ')';
        const taskTitle = extracted.title?.trim() || String(text).slice(0, 120);
        const defaults = buildAdaptiveTaskDefaults({
            title: taskTitle,
            taskType: 'task',
            explicitPriority: extracted.priority,
            explicitEstimateMinutes: extracted.estimated_minutes,
            explicitEnergyRequired: extracted.energy_required,
            snapshot: personalization,
        });

        const insert = db.prepare(`
            INSERT INTO tasks(title, description, priority, goal_id, status, estimated_minutes, energy_required)
            VALUES(?, ?, ?, ?, 'todo', ?, ?)
        `);

        insert.run(
            taskTitle,
            finalDescription,
            defaults.priority,
            extracted.goal_id || null,
            defaults.estimatedMinutes,
            defaults.energyRequired,
        );

        return NextResponse.json({
            success: true,
            task: {
                ...extracted,
                title: taskTitle,
                priority: defaults.priority,
                estimated_minutes: defaults.estimatedMinutes,
                energy_required: defaults.energyRequired,
                adaptive_reason: defaults.reason,
            },
        });
    } catch (error: unknown) {
        console.error('Extension Task API Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to process task extraction';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
