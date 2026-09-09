import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback, generateStreamWithFallback } from '@/lib/ai';
import { getActiveGuardianSession, startGuardianSession } from '@/lib/guardian-runtime';
import { MODEL_PRO } from '@/lib/models';
import { touchIntelligence } from '@/lib/intelligence';
import { extractMemoryFromVoice } from '@/lib/memory-extractor';
import { getKnowledgeGapSummary } from '@/lib/graph';
import { Type } from '@google/genai';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveSessionMinutes, getAdaptiveSessionMinutesLabel } from '@/lib/adaptive-command-defaults';
import { getAdaptiveTaskRecommendations } from '@/lib/adaptive-task-recommendations';
import { buildAdaptiveDashboardPolicy } from '@/lib/adaptive-dashboard-policy';
import { getAdaptiveRewardDecision } from '@/lib/adaptive-rewards';
import { recordAdaptiveHabitCheckin } from '@/lib/adaptive-habit-checkin';
import { buildAdaptiveTaskDefaults } from '@/lib/adaptive-task-defaults';
import {
    buildCognitiveSelfAnswer,
    formatCognitiveSelfAnswerForPrompt,
    isCognitiveSelfQuestion,
} from '@/lib/cognitive-self-answer';
import { recordHumanContact } from '@/lib/coaching-state';

const tools = [{
    functionDeclarations: [
        {
            name: 'getDashboardSnapshot',
            description: 'Fetch a compact summary of the user\'s productivity state: tasks, active goals, recent focus sessions, alerts, and today score.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    include_history: { type: Type.BOOLEAN }
                }
            }
        },
        {
            name: 'createTask',
            description: 'Create a new task in the user backlog',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING },
                    priority: { type: Type.STRING, description: 'low, medium, high, critical' }
                },
                required: ['title']
            }
        },
        {
            name: 'checkHabit',
            description: 'Check off a habit for today',
            parameters: {
                type: Type.OBJECT,
                properties: { habit_id: { type: Type.INTEGER } },
                required: ['habit_id']
            }
        },
        {
            name: 'startGuardianSession',
            description: 'Start a guarded focus session for the user',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    duration_minutes: { type: Type.INTEGER, description: 'Optional. If omitted, LifeOS will use the learned adaptive session length for the current day and task.' },
                    task_title: { type: Type.STRING },
                    mood: { type: Type.STRING, description: 'high, medium, or low' }
                },
                required: ['task_title']
            }
        },
        {
            name: 'explainCognitiveWiring',
            description: 'Explain how/why/when the user works using the Cognitive Self-Map (pressure dependency, voluntary starts, activation energy, trajectory). Use when they ask why they only work under pressure, how their brain works, or similar self-model questions.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'The user question about their wiring or patterns' }
                },
                required: ['query']
            }
        }
    ]
}];

type ChatMessage = {
    role: 'user' | 'assistant' | 'model' | string;
    content: string;
};

type ToolArgs = {
    include_history?: boolean;
    title?: string;
    priority?: string;
    habit_id?: number;
    duration_minutes?: number;
    task_title?: string;
    mood?: 'high' | 'medium' | 'low' | string;
    query?: string;
};

type FunctionResponsePart = {
    functionResponse: {
        name: string;
        response: Record<string, unknown>;
    };
};

type GenAiPart = { text?: string } | FunctionResponsePart | Record<string, unknown>;
type GenAiContent = {
    role: 'user' | 'model';
    parts: GenAiPart[];
};

function normalizeMood(mood: ToolArgs['mood']): 'high' | 'medium' | 'low' {
    return mood === 'high' || mood === 'medium' || mood === 'low' ? mood : 'medium';
}

function normalizeMessages(body: { messages?: unknown; query?: unknown }): ChatMessage[] | null {
    if (Array.isArray(body.messages)) {
        return body.messages.flatMap((m) => {
            if (!m || typeof m !== 'object') return [];
            const row = m as Record<string, unknown>;
            if (typeof row.content !== 'string') return [];
            return [{
                role: typeof row.role === 'string' ? row.role : 'user',
                content: row.content,
            }];
        });
    }
    if (typeof body.query === 'string' && body.query.trim()) {
        return [{ role: 'user', content: body.query }];
    }
    return null;
}

function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : { result: value };
}

function createCoachOutcome(input: {
    messages: ChatMessage[];
    momentMode: string;
    surface?: string;
}): number {
    const lastUserMessage = [...input.messages].reverse().find(m => m.role !== 'assistant' && m.role !== 'model')?.content ?? '';
    const result = getDb().prepare(`
        INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, helpful)
        VALUES ('coach_response', ?, NULL, NULL)
    `).run(JSON.stringify({
        surface: input.surface ?? 'web_chat',
        momentMode: input.momentMode,
        lastUserMessage: lastUserMessage.slice(0, 500),
        messageCount: input.messages.length,
    }));
    return Number(result.lastInsertRowid);
}

function updateCoachOutcome(outcomeId: number, text: string, status: 'completed' | 'timeout' | 'error'): void {
    try {
        getDb().prepare(`
            UPDATE agent_action_outcomes
            SET actual_outcome = ?
            WHERE id = ?
        `).run(JSON.stringify({
            status,
            text: text.slice(0, 2000),
            completedAt: new Date().toISOString(),
        }), outcomeId);
    } catch { /* non-fatal feedback bookkeeping */ }
}

function getTodayIst(): string {
    return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

function executeTool(name: string, args: ToolArgs, personalization: PersonalizationSnapshot) {
    const db = getDb();
    if (name === 'getDashboardSnapshot') {
        const recommendedTasks = getAdaptiveTaskRecommendations(personalization, 5);
        const tasks = db.prepare(`
            SELECT id, title, status, priority, goal_id, estimated_minutes
            FROM tasks
            WHERE status IN ('doing', 'todo')
            ORDER BY CASE status
                WHEN 'doing' THEN 0
                ELSE 1
            END, priority_rank ASC, created_at DESC
            LIMIT 10
        `).all();
        const goals = db.prepare(`
            SELECT id, title, progress, deadline
            FROM goals
            WHERE active = 1
            ORDER BY deadline IS NULL, deadline ASC
            LIMIT 5
        `).all();
        const focusSessions = db.prepare(`
            SELECT session_id as id, goal_title, concept_node_name as task_title,
                   elapsed_minutes as duration_minutes, started_at, completed_at as ended_at,
                   average_focus_score, final_focus_score
            FROM guardian_session_summaries
            ORDER BY COALESCE(started_at, completed_at) DESC
            LIMIT ?
        `).all(args.include_history ? 10 : 3);
        const alerts = db.prepare(`
            SELECT id, type, message, severity, title, priority
            FROM alerts
            WHERE read = 0
            ORDER BY id DESC
            LIMIT 5
        `).all();
        const today = db.prepare(`
            SELECT *
            FROM daily_scores
            ORDER BY date DESC
            LIMIT 1
        `).get();
        const habitStats = db.prepare(`
            SELECT
                COUNT(DISTINCT hc.habit_id) as completed_today,
                (SELECT COUNT(*) FROM habits WHERE archived = 0) as total_habits
            FROM habit_checkins hc
            JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
            WHERE hc.date = ? AND hc.completed = 1
        `).get(getTodayIst()) as { completed_today: number; total_habits: number };
        const dashboardPolicy = buildAdaptiveDashboardPolicy({
            snapshot: personalization,
            recommendedTasks,
            recommendedSessionMinutes: getAdaptiveSessionMinutes(),
            habitStats,
            unreadAlerts: alerts.length,
            productiveMinutes: Number((today as { productive_minutes?: number } | undefined)?.productive_minutes ?? 0),
            distractionMinutes: Number((today as { distraction_minutes?: number } | undefined)?.distraction_minutes ?? 0),
        });
        return {
            tasks,
            goals,
            focusSessions,
            alerts,
            today,
            recommendedTasks,
            dashboardPolicy,
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
                plannedFocus: personalization.today.plannedFocus,
                alertFatigueLevel: personalization.feedback.alertFatigueLevel,
            },
        };
    } else if (name === 'createTask') {
        const title = args.title || 'Untitled task';
        const defaults = buildAdaptiveTaskDefaults({
            title,
            taskType: 'task',
            explicitPriority: args.priority,
            snapshot: personalization,
        });
        const stmt = db.prepare(`
            INSERT INTO tasks (title, status, priority, estimated_minutes, energy_required, created_at)
            VALUES (?, 'todo', ?, ?, ?, datetime('now', 'localtime'))
        `);
        const info = stmt.run(title, defaults.priority, defaults.estimatedMinutes, defaults.energyRequired);
        return {
            success: true,
            task_id: info.lastInsertRowid,
            priority: defaults.priority,
            estimated_minutes: defaults.estimatedMinutes,
            energy_required: defaults.energyRequired,
            adaptive_reason: defaults.reason,
        };
    } else if (name === 'checkHabit') {
        const today = getTodayIst();
        const habit = db.prepare('SELECT id, name FROM habits WHERE id = ? AND archived = 0').get(args.habit_id) as { id: number; name: string } | undefined;
        if (!habit) return { success: false, error: 'Habit not found' };
        const checkin = recordAdaptiveHabitCheckin({
            habitId: habit.id,
            date: today,
            source: 'chat',
            forceComplete: true,
        });
        let reward = null;
        if (!checkin.alreadyCompleted && checkin.completed) {
            reward = getAdaptiveRewardDecision({
                action: 'habit_checkin',
                baseCoins: 20,
                subject: habit.name,
                snapshot: personalization,
            });
            try { db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason); } catch { }
        }
        return {
            success: true,
            habit_id: habit.id,
            habit: habit.name,
            already_completed: checkin.alreadyCompleted,
            value: checkin.value,
            adaptive_target: checkin.adaptiveTarget,
            reward,
            adaptive_reason: checkin.adaptiveReason ?? personalization.moment.guidance,
        };
    } else if (name === 'startGuardianSession') {
        const duration = getAdaptiveSessionMinutes(args.duration_minutes);
        const session = startGuardianSession({
            conceptNodeName: args.task_title || 'Deep Work',
            durationMinutes: duration,
            mood: normalizeMood(args.mood ?? personalization.userState.mood ?? personalization.userState.energy),
            source: 'api',
        });
        return {
            success: true,
            session_id: session.sessionId,
            message: 'Guardian session started',
            session,
            adaptive_reason: `${getAdaptiveSessionMinutesLabel(args.duration_minutes)} selected for ${personalization.moment.mode} mode`,
        };
    } else if (name === 'explainCognitiveWiring') {
        const answer = buildCognitiveSelfAnswer(args.query || 'how does my brain work');
        return {
            success: true,
            focus: answer.focus,
            title: answer.title,
            summary: answer.summary,
            sections: answer.sections,
            evidence: answer.evidence,
            next_move: answer.nextMove,
            confidence: answer.confidence,
            markdown: answer.markdown,
            plain_text: answer.plainText,
        };
    }
    throw new Error('Unknown tool');
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json() as { messages?: unknown; query?: unknown };
        const messages = normalizeMessages(body);
        if (!messages) return NextResponse.json({ error: 'messages or query required' }, { status: 400 });
        const lastUserMessage = [...messages].reverse().find(message => message.role === 'user');
        recordHumanContact('web_chat', { length: lastUserMessage?.content.length ?? 0 });

        const ai = getGenAI();

        const activeSession = getActiveGuardianSession();
        const activeFocusScore = activeSession?.focusScoreHistory?.slice(-1)[0] ?? null;
        const personalization = buildPersonalizationSnapshot({
            surface: 'chat',
            maxInsights: 4,
            includeThresholds: true,
            includeMemoryFacts: 8,
            activeSession: activeSession ? {
                sessionId: activeSession.sessionId,
                targetTitle: activeSession.targetTitle,
                focusScore: activeFocusScore,
                elapsedMinutes: Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60000)),
            } : null,
        });
        const personalizationContext = formatPersonalizationContext(personalization);
        const knowledgeContext = getKnowledgeGapSummary();
        const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        const cognitiveQuestion = isCognitiveSelfQuestion(lastUserText);
        const cognitiveGrounding = cognitiveQuestion
            ? formatCognitiveSelfAnswerForPrompt(lastUserText)
            : '';

        // Deterministic path for self-map questions: return grounded answer without requiring LLM tool loops
        if (cognitiveQuestion && process.env.LIFEOS_COGNITIVE_CHAT_DETERMINISTIC !== '0') {
            const answer = buildCognitiveSelfAnswer(lastUserText);
            touchIntelligence('chat');
            return NextResponse.json({
                response: answer.markdown,
                grounded: true,
                focus: answer.focus,
                confidence: answer.confidence,
                next_move: answer.nextMove,
            });
        }

        const systemInstruction = "You are Jarvis, the core intelligence engine and personal assistant of LifeOS.\\n" +
            "You have access only to typed LifeOS tools and summaries, not arbitrary SQL.\\n" +
            "Always be proactive, concise, and hold the user accountable, but adapt to today's moment mode.\\n" +
            "Never give generic productivity advice when current LifeOS context can ground the answer.\\n\\n" +
            personalizationContext + "\\n\\n" +
            (cognitiveGrounding ? cognitiveGrounding + "\\n\\n" : "") +
            (knowledgeContext ? "Knowledge Graph:\\n" + knowledgeContext + "\\n\\n" : "") +
            "When users ask questions about their data or what to do next, use getDashboardSnapshot; it includes the adaptive dashboard policy and ranked tasks.\\n" +
            "If plannedFocus shows an upcoming planned block or weak follow-through, prioritize protecting or adjusting that schedule before suggesting unrelated new work.\\n" +
            "When users ask how/why/when their brain works, pressure dependency, or rewiring, call explainCognitiveWiring with their question and ground on the tool result — do not invent patterns.\\n" +
            "When users ask to create a task, check a habit, or start a guardian session, use the respective tool. If the user did not name a session length, omit duration_minutes and let LifeOS pick the learned adaptive length.\\n" +
            "When users ask about concepts to study or which goal to focus on next, reference the Knowledge Graph status above.\\n" +
            "Always wait for the tool outcome before finalizing your answer. Do not show raw JSON to the user. Explain the adaptive reason naturally.";

        // Nudge UIL to re-synthesize in background after a chat (new data signal)
        touchIntelligence('chat');

        // Format history for @google/genai SDK v3
        const contents: GenAiContent[] = messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        if (!ai) {
            if (cognitiveQuestion) {
                const answer = buildCognitiveSelfAnswer(lastUserText);
                return NextResponse.json({
                    response: answer.markdown,
                    grounded: true,
                    focus: answer.focus,
                    offline: true,
                });
            }
            return NextResponse.json({ error: 'AI not configured' }, { status: 503 });
        }

        const MAX_TOOL_LOOPS = 5;
        let loopCount = 0;

        while (loopCount < MAX_TOOL_LOOPS) {
            loopCount++;

            const response = await generateWithFallback(ai, {
                model: MODEL_PRO,
                contents: contents,
                config: {
                    systemInstruction: systemInstruction,
                    tools: tools as never,
                    temperature: 0.2
                }
            });

            if (response.functionCalls && response.functionCalls.length > 0) {
                const functionResponses: FunctionResponsePart[] = [];

                // Append model's exact response to history to preserve thoughts and signatures
                contents.push({
                    role: 'model',
                    parts: (response.candidates?.[0]?.content?.parts || []) as unknown as GenAiPart[]
                });

                // Execute each tool
                for (const call of response.functionCalls) {
                    try {
                        const toolResult = executeTool(call.name || '', (call.args || {}) as ToolArgs, personalization);
                        const safeResponse = toRecord(toolResult);

                        functionResponses.push({
                            functionResponse: {
                                name: call.name || '',
                                response: safeResponse
                            }
                        });
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        functionResponses.push({
                            functionResponse: {
                                name: call.name || '',
                                response: { error: message }
                            }
                        });
                    }
                }

                // Append tool returns
                contents.push({
                    role: 'user',
                    parts: functionResponses
                });

                continue;
            } else {
                // Background memory extraction — every chat conversation enriches mem_facts
                if (messages.length >= 4) {
                    const turns = messages.map((m) => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        text: m.content,
                    }));
                    extractMemoryFromVoice(turns, `chat-${Date.now()}`).catch(() => {});
                }

                const outcomeId = createCoachOutcome({
                    messages,
                    momentMode: personalization.moment.mode,
                    surface: 'ai_coach',
                });

                // Stream the final text response so the user sees tokens as they arrive
                const streamResult = await generateStreamWithFallback(ai, {
                    model: MODEL_PRO,
                    contents,
                    config: {
                        systemInstruction,
                        tools: tools as never,
                        temperature: 0.2,
                    },
                });

                const encoder = new TextEncoder();
                let fullText = '';
                const readable = new ReadableStream({
                    async start(controller) {
                        try {
                            for await (const chunk of streamResult) {
                                const text = chunk.text;
                                if (text) {
                                    fullText += text;
                                    controller.enqueue(encoder.encode(text));
                                }
                            }
                            updateCoachOutcome(outcomeId, fullText, 'completed');
                        } catch (err) {
                            updateCoachOutcome(outcomeId, err instanceof Error ? err.message : String(err), 'error');
                            throw err;
                        } finally {
                            controller.close();
                        }
                    },
                });

                return new Response(readable, {
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                        'X-LifeOS-Outcome-Id': String(outcomeId),
                    },
                });
            }
        }

        const outcomeId = createCoachOutcome({ messages, momentMode: personalization.moment.mode, surface: 'ai_coach' });
        const timeoutText = "I had to stop thinking because it took too long to execute all the tools.";
        updateCoachOutcome(outcomeId, timeoutText, 'timeout');
        return NextResponse.json({ text: timeoutText, outcomeId });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Chat API error:', error);
        return NextResponse.json({ text: `I encountered an error trying to process that: ${message} ` });
    }
}
