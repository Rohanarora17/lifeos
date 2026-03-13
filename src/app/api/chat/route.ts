import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getGenAI } from '@/lib/ai';
import { MODEL_PRO } from '@/lib/models';
import { buildBehaviorContext, buildGoalsContext } from '@/lib/behavior';
import { Type } from '@google/genai';

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

const tools = [{
    functionDeclarations: [
        {
            name: 'queryDatabase',
            description: 'Run a raw SQLite SELECT query to fetch data about the user\'s habits, tasks, focus sessions, or activities. Schema:\n' + DB_SCHEMA,
            parameters: {
                type: Type.OBJECT,
                properties: {
                    sql: { type: Type.STRING, description: 'The absolute raw SQLite SELECT query. No markdown.' }
                },
                required: ['sql']
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
            name: 'startFocusSession',
            description: 'Start a focus session',
            parameters: {
                type: Type.OBJECT,
                properties: { duration_minutes: { type: Type.INTEGER }, task_title: { type: Type.STRING } },
                required: ['duration_minutes']
            }
        }
    ]
}];

function executeTool(name: string, args: any) {
    const db = getDb();
    if (name === 'queryDatabase') {
        const stmt = db.prepare(args.sql);
        if (!stmt.readonly) throw new Error('Only SELECT queries allowed');
        return stmt.all();
    } else if (name === 'createTask') {
        const stmt = db.prepare("INSERT INTO tasks (title, status, priority, created_at) VALUES (?, 'backlog', ?, datetime('now', 'localtime'))");
        const info = stmt.run(args.title, args.priority || 'medium');
        return { success: true, task_id: info.lastInsertRowid };
    } else if (name === 'checkHabit') {
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const stmt = db.prepare('INSERT OR IGNORE INTO habit_checkins (habit_id, date, completed) VALUES (?, ?, 1)');
        stmt.run(args.habit_id, today);
        return { success: true, message: 'Habit checked off for today' };
    } else if (name === 'startFocusSession') {
        const start = new Date(Date.now() + 19800000).toISOString();
        const stmt = db.prepare("INSERT INTO focus_sessions (session_date, start_time, duration_minutes, task_title, status) VALUES (?, ?, ?, ?, 'active')");
        const info = stmt.run(start.slice(0, 10), start, args.duration_minutes, args.task_title || '');
        return { success: true, session_id: info.lastInsertRowid, message: 'Focus session created for ' + args.duration_minutes + 'm' };
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

        const behaviorContext = buildBehaviorContext();
        const goalsContext = typeof buildGoalsContext === 'function' ? buildGoalsContext() : '';

        const systemInstruction = "You are Jarvis, the core intelligence engine and personal assistant of LifeOS.\\n" +
            "You have direct access to the user's LifeOS database via tools.\\n" +
            "Always be proactive, concise, and hold the user accountable.\\n\\n" +
            "Behavioral Context:\\n" + behaviorContext + "\\n\\n" +
            "Goals Context:\\n" + goalsContext + "\\n\\n" +
            "When users ask questions about their data, use the queryDatabase tool to fetch it.\\n" +
            "When users ask to create a task, check a habit, or start a focus session, use the respective tool.\\n" +
            "Always wait for the tool outcome before finalizing your answer. Do not show raw JSON to the user. Explain data naturally.";

        // Format history for @google/genai SDK v3
        let contents = messages.map((m: any) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const MAX_TOOL_LOOPS = 5;
        let loopCount = 0;

        while (loopCount < MAX_TOOL_LOOPS) {
            loopCount++;

            const response = await ai.models.generateContent({
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
                return NextResponse.json({ text: (response.text || '').trim() });
            }
        }

        return NextResponse.json({ text: "I had to stop thinking because it took too long to execute all the tools." });

    } catch (error: any) {
        console.error('Chat API error:', error);
        return NextResponse.json({ text: `I encountered an error trying to process that: ${error.message} ` });
    }
}
