import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { startGuardianSession } from '@/lib/guardian-runtime';
import { MODEL_PRO } from '@/lib/models';
import { getIntelligenceContext, touchIntelligence } from '@/lib/intelligence';
import { extractMemoryFromVoice } from '@/lib/memory-extractor';
import { getKnowledgeGapSummary } from '@/lib/graph';
import { Type } from '@google/genai';

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
                    duration_minutes: { type: Type.INTEGER },
                    task_title: { type: Type.STRING },
                    mood: { type: Type.STRING, description: 'high, medium, or low' }
                },
                required: ['duration_minutes', 'task_title']
            }
        }
    ]
}];

function executeTool(name: string, args: any) {
    const db = getDb();
    if (name === 'getDashboardSnapshot') {
        const tasks = db.prepare(`
            SELECT id, title, status, priority, goal_id
            FROM tasks
            WHERE status IN ('doing', 'today', 'backlog')
            ORDER BY CASE status
                WHEN 'doing' THEN 0
                WHEN 'today' THEN 1
                ELSE 2
            END, created_at DESC
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
            SELECT id, goal_title, task_title, duration_minutes, started_at, ended_at, status, ai_report
            FROM focus_sessions
            ORDER BY COALESCE(started_at, created_at, id) DESC
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
        return { tasks, goals, focusSessions, alerts, today };
    } else if (name === 'createTask') {
        const stmt = db.prepare("INSERT INTO tasks (title, status, priority, created_at) VALUES (?, 'backlog', ?, datetime('now', 'localtime'))");
        const info = stmt.run(args.title, args.priority || 'medium');
        return { success: true, task_id: info.lastInsertRowid };
    } else if (name === 'checkHabit') {
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const stmt = db.prepare('INSERT OR IGNORE INTO habit_checkins (habit_id, date, completed) VALUES (?, ?, 1)');
        stmt.run(args.habit_id, today);
        return { success: true, message: 'Habit checked off for today' };
    } else if (name === 'startGuardianSession') {
        const session = startGuardianSession({
            conceptNodeName: args.task_title,
            durationMinutes: args.duration_minutes,
            mood: args.mood || 'medium',
            source: 'api',
        });
        return { success: true, session_id: session.sessionId, message: 'Guardian session started', session };
    }
    throw new Error('Unknown tool');
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        let messages = body.messages;
        if (!messages) {
            const query = body.query;
            if (!query) return NextResponse.json({ error: 'messages or query required' }, { status: 400 });
            messages = [{ role: 'user', content: query }];
        }

        const ai = getGenAI();
        if (!ai) return NextResponse.json({ error: 'AI not configured' }, { status: 500 });

        const intelligenceContext = getIntelligenceContext({ maxInsights: 4, includeThresholds: true, includeToday: true });
        const knowledgeContext = getKnowledgeGapSummary();

        const systemInstruction = "You are Jarvis, the core intelligence engine and personal assistant of LifeOS.\\n" +
            "You have access only to typed LifeOS tools and summaries, not arbitrary SQL.\\n" +
            "Always be proactive, concise, and hold the user accountable.\\n\\n" +
            intelligenceContext + "\\n\\n" +
            (knowledgeContext ? "Knowledge Graph:\\n" + knowledgeContext + "\\n\\n" : "") +
            "When users ask questions about their data, use the getDashboardSnapshot tool to fetch relevant structured context.\\n" +
            "When users ask to create a task, check a habit, or start a guardian session, use the respective tool.\\n" +
            "When users ask about concepts to study or which goal to focus on next, reference the Knowledge Graph status above.\\n" +
            "Always wait for the tool outcome before finalizing your answer. Do not show raw JSON to the user. Explain data naturally.";

        // Nudge UIL to re-synthesize in background after a chat (new data signal)
        touchIntelligence('chat');

        // Format history for @google/genai SDK v3
        let contents = messages.map((m: any) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const MAX_TOOL_LOOPS = 5;
        let loopCount = 0;

        while (loopCount < MAX_TOOL_LOOPS) {
            loopCount++;

            const response = await generateWithFallback(ai, {
                model: MODEL_PRO,
                contents: contents,
                config: {
                    systemInstruction: systemInstruction,
                    tools: tools as any,
                    temperature: 0.2
                }
            });

            if (response.functionCalls && response.functionCalls.length > 0) {
                const functionResponses: any[] = [];

                // Append model's exact response to history to preserve thoughts and signatures
                contents.push({
                    role: 'model',
                    parts: (response as any).candidates?.[0]?.content?.parts || []
                });

                // Execute each tool
                for (const call of response.functionCalls) {
                    try {
                        const toolResult = executeTool(call.name || '', call.args);
                        const safeResponse = (typeof toolResult === 'object' && toolResult !== null && !Array.isArray(toolResult))
                            ? toolResult
                            : { result: toolResult };

                        functionResponses.push({
                            functionResponse: {
                                name: call.name || '',
                                response: safeResponse
                            }
                        });
                    } catch (err: any) {
                        functionResponses.push({
                            functionResponse: {
                                name: call.name || '',
                                response: { error: err.message }
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
                const reply = (response.text || '').trim();

                // Background memory extraction — every chat conversation enriches mem_facts
                if (messages.length >= 4) {
                    const turns = messages.map((m: any) => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        text: m.content as string,
                    }));
                    extractMemoryFromVoice(turns, `chat-${Date.now()}`).catch(() => {});
                }

                return NextResponse.json({ text: reply });
            }
        }

        return NextResponse.json({ text: "I had to stop thinking because it took too long to execute all the tools." });

    } catch (error: any) {
        console.error('Chat API error:', error);
        return NextResponse.json({ text: `I encountered an error trying to process that: ${error.message} ` });
    }
}
