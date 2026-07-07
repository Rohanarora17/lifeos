import { NextRequest, NextResponse } from 'next/server';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_FLASH } from '@/lib/models';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveSessionMinutes } from '@/lib/adaptive-command-defaults';

type StudyBlock = {
    title: string;
    duration: number;
    type: 'study' | 'break';
    description: string;
};

type StudyPlan = {
    topic: string;
    overview: string;
    blocks: StudyBlock[];
    adaptiveContext: {
        mode: PersonalizationSnapshot['moment']['mode'];
        energy: PersonalizationSnapshot['userState']['energy'];
        mood: PersonalizationSnapshot['userState']['mood'];
        guidance: string;
        studyBlockMinutes: number;
        breakMinutes: number;
        generatedBy: 'ai' | 'adaptive_fallback';
    };
};

function clampDuration(value: unknown): number {
    const mins = Number(value);
    if (!Number.isFinite(mins)) return 0;
    return Math.max(10, Math.min(480, Math.round(mins)));
}

function getAdaptiveStudyRhythm(snapshot: PersonalizationSnapshot, requestedMinutes: number) {
    const learnedSession = getAdaptiveSessionMinutes();
    const lowEnergy = snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low';
    const deadlinePressure = snapshot.moment.mode === 'deadline_pressure' || snapshot.today.overdueTasks > 0;
    const protectFocus = snapshot.moment.mode === 'protect_focus';

    let studyBlockMinutes = Math.min(learnedSession, requestedMinutes);
    let breakMinutes = 5;

    if (lowEnergy) {
        studyBlockMinutes = Math.min(studyBlockMinutes, 18);
        breakMinutes = 7;
    } else if (deadlinePressure) {
        studyBlockMinutes = Math.min(Math.max(studyBlockMinutes, 30), 45);
        breakMinutes = 5;
    } else if (protectFocus) {
        studyBlockMinutes = Math.min(Math.max(studyBlockMinutes, 35), 50);
        breakMinutes = 5;
    } else {
        studyBlockMinutes = Math.min(Math.max(studyBlockMinutes, 22), 35);
        breakMinutes = 5;
    }

    if (requestedMinutes <= 25) {
        studyBlockMinutes = Math.max(10, requestedMinutes);
        breakMinutes = 0;
    }

    return {
        studyBlockMinutes: Math.max(10, Math.round(studyBlockMinutes)),
        breakMinutes,
        lowEnergy,
        deadlinePressure,
        protectFocus,
    };
}

function buildAdaptiveFallbackPlan(
    topic: string,
    durationMinutes: number,
    difficulty: string,
    snapshot: PersonalizationSnapshot,
): StudyPlan {
    const rhythm = getAdaptiveStudyRhythm(snapshot, durationMinutes);
    const blocks: StudyBlock[] = [];
    let remaining = durationMinutes;
    let studyIndex = 1;

    while (remaining > 0) {
        const isFinalStudy = remaining <= rhythm.studyBlockMinutes + rhythm.breakMinutes + 8;
        const studyDuration = isFinalStudy
            ? remaining
            : Math.min(rhythm.studyBlockMinutes, Math.max(10, remaining - rhythm.breakMinutes));

        blocks.push({
            title: studyIndex === 1 ? `Orient around ${topic}` : studyIndex === 2 ? `Work the hard part` : `Apply and review`,
            duration: studyDuration,
            type: 'study',
            description: studyIndex === 1
                ? `Map what you already know, then pick the smallest useful ${difficulty} target.`
                : studyIndex === 2
                    ? `Practice the core idea directly and write down the point that still feels unclear.`
                    : `Use retrieval or a worked example to prove what stuck.`,
        });
        remaining -= studyDuration;
        studyIndex += 1;

        if (remaining <= 0) break;

        const breakDuration = Math.min(rhythm.breakMinutes || 5, remaining);
        if (breakDuration > 0 && remaining - breakDuration >= 8) {
            blocks.push({
                title: rhythm.lowEnergy ? 'Low-friction reset' : 'Reset',
                duration: breakDuration,
                type: 'break',
                description: rhythm.lowEnergy
                    ? 'Step away, lower stimulation, and come back with one next action.'
                    : 'Move briefly, avoid feeds, and return to the next block.',
            });
            remaining -= breakDuration;
        } else {
            blocks[blocks.length - 1].duration += remaining;
            remaining = 0;
        }
    }

    const reason = rhythm.lowEnergy
        ? 'shorter study blocks and gentler resets because the current mode is recovery'
        : rhythm.deadlinePressure
            ? 'longer execution blocks because deadline pressure is active'
            : rhythm.protectFocus
                ? 'longer quiet blocks because current focus should be protected'
                : 'balanced blocks based on the current day profile';

    return {
        topic,
        overview: `This plan uses ${reason}. It keeps the full ${durationMinutes} minutes accounted for while matching ${snapshot.userState.energy} energy and ${snapshot.moment.mode} mode.`,
        blocks,
        adaptiveContext: {
            mode: snapshot.moment.mode,
            energy: snapshot.userState.energy,
            mood: snapshot.userState.mood,
            guidance: snapshot.moment.guidance,
            studyBlockMinutes: rhythm.studyBlockMinutes,
            breakMinutes: rhythm.breakMinutes,
            generatedBy: 'adaptive_fallback',
        },
    };
}

function normalizePlan(raw: unknown, fallback: StudyPlan, durationMinutes: number): StudyPlan {
    if (!raw || typeof raw !== 'object') return fallback;
    const plan = raw as Partial<StudyPlan>;
    const blocks = Array.isArray(plan.blocks)
        ? plan.blocks
            .map((block) => ({
                title: String(block?.title ?? '').trim(),
                duration: Math.round(Number(block?.duration ?? 0)),
                type: block?.type === 'break' ? 'break' as const : 'study' as const,
                description: String(block?.description ?? '').trim(),
            }))
            .filter((block) => block.title && block.duration > 0 && block.description)
        : [];

    const total = blocks.reduce((sum, block) => sum + block.duration, 0);
    if (blocks.length === 0 || total !== durationMinutes || blocks[0]?.type !== 'study') return fallback;

    return {
        ...fallback,
        topic: String(plan.topic ?? fallback.topic),
        overview: String(plan.overview ?? fallback.overview),
        blocks,
        adaptiveContext: {
            ...fallback.adaptiveContext,
            generatedBy: 'ai',
        },
    };
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const topic = String(body.topic ?? '').trim();
        const durationMinutes = clampDuration(body.durationMinutes);
        const difficulty = String(body.difficulty || 'intermediate').trim() || 'intermediate';

        if (!topic || !durationMinutes) {
            return NextResponse.json({ error: 'Missing topic or duration' }, { status: 400 });
        }

        const personalization = buildPersonalizationSnapshot({
            surface: 'study_plan',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const fallbackPlan = buildAdaptiveFallbackPlan(topic, durationMinutes, difficulty, personalization);
        const rhythm = getAdaptiveStudyRhythm(personalization, durationMinutes);
        const ai = getGenAI();
        const personalizationContext = formatPersonalizationContext(personalization);

        const prompt = `You are an expert tutor and productivity coach. Create a highly optimized study plan for the topic: "${topic}".
The user has ${durationMinutes} minutes available and their current knowledge level is "${difficulty}".

Use this personalization profile. Not every day is the same: adapt block length, breaks, review intensity, tone, and cognitive load to this exact day.
${personalizationContext}

Adaptive rhythm to respect unless the topic clearly requires a small adjustment:
- Target study block: about ${rhythm.studyBlockMinutes} minutes
- Break length: ${rhythm.breakMinutes || 0} minutes
- Current mode: ${personalization.moment.mode}
- Current guidance: ${personalization.moment.guidance}

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
3. Break cadence must fit the current mode and energy, not a fixed Pomodoro template.
4. The final study block should include recall, application, or review unless the duration is too short.
5. All durations must be integers.`;

        try {
            const result = await generateWithFallback(ai, {
                model: MODEL_FLASH,
                contents: prompt,
                config: {
                    responseMimeType: 'application/json'
                }
            });

            const text = result.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return NextResponse.json(fallbackPlan);
            return NextResponse.json(normalizePlan(JSON.parse(jsonMatch[0]), fallbackPlan, durationMinutes));
        } catch (aiError) {
            console.warn('Study plan AI generation failed, using adaptive fallback:', aiError);
            return NextResponse.json(fallbackPlan);
        }
    } catch (error: unknown) {
        console.error('Study plan generation error:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to generate study plan' }, { status: 500 });
    }
}

export async function GET() {
    try {
        const personalization = buildPersonalizationSnapshot({
            surface: 'study_plan',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const recommendedDurationMinutes = getAdaptiveSessionMinutes();
        const rhythm = getAdaptiveStudyRhythm(personalization, recommendedDurationMinutes);

        return NextResponse.json({
            recommendedDurationMinutes,
            adaptiveContext: {
                mode: personalization.moment.mode,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                guidance: personalization.moment.guidance,
                nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
                standupGoal: personalization.userState.standupGoal,
                studyBlockMinutes: rhythm.studyBlockMinutes,
                breakMinutes: rhythm.breakMinutes,
            },
        });
    } catch (error: unknown) {
        console.error('Study plan defaults error:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to load adaptive defaults' }, { status: 500 });
    }
}
