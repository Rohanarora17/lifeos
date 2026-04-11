import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import {
    sendTelegram,
    SESSION_START_KEYBOARD,
    FULL_MENU_KEYBOARD,
    formatStandupBrief,
    formatTasksList,
    formatHabitStatus,
    formatWeeklyPlanSummary,
    formatGoalHealthStatus,
    formatPendingReviews,
    formatCalibrationStatus,
    buildTaskChipsKeyboard,
} from './telegram';
import { startGuardianSession, endGuardianSession, getActiveGuardianSession, adjustGuardianSessionDuration } from './guardian-runtime';
import { getMemoryContext } from './memory';
import { getDb, getSetting, setSetting } from './db';
import { getIntelligenceContext, touchIntelligence } from './intelligence';
import { extractMemoryFromVoice } from './memory-extractor';

// Track LLM-parsed message count for memory extraction cadence
let tgLlmTurnCount = 0;

// Pending confirmation: START_SESSION requires explicit user "yes/go/start" before executing
const pendingConfirmations = new Map<string, { action: string; payload: Record<string, unknown>; replyText: string; expiresAt: number }>();

function setPendingConfirmation(chatId: string, action: string, payload: Record<string, unknown>, replyText: string): void {
    pendingConfirmations.set(chatId, { action, payload, replyText, expiresAt: Date.now() + 90_000 });
}

function consumePendingConfirmation(chatId: string): { action: string; payload: Record<string, unknown>; replyText: string } | null {
    const pending = pendingConfirmations.get(chatId);
    if (!pending || Date.now() > pending.expiresAt) {
        pendingConfirmations.delete(chatId);
        return null;
    }
    pendingConfirmations.delete(chatId);
    return pending;
}

function isConfirmation(text: string): boolean {
    return /^(yes|yeah|go|yep|ok|okay|confirm|do it|start|let'?s go|sure|yup)\b/i.test(text.trim());
}

function isDenial(text: string): boolean {
    return /^(no|nope|cancel|stop|not now|wait|hold on|nevermind|never mind|nah)\b/i.test(text.trim());
}

// Single-user system — one confirmation slot
const SINGLE_USER_KEY = 'default';

const TELEGRAM_SYSTEM_PROMPT = `You are LifeOS, an intelligent personal agent on Telegram. Your only job is to help this person do focused work and become better.

## CRITICAL INTENT RULES

1. **NEVER use START_SESSION unless the user uses an explicit immediate trigger word: "start", "begin", "go", "let's do it", "now", or a direct command like "start a session on X".**
   - "I want to study X" → STORE_INTENTION (ask when)
   - "I plan to do X tomorrow" → STORE_INTENTION
   - "I want to do 4 hours of X today" → ASK_CLARIFICATION ("When do you want to start? All at once or in blocks?")
   - "Start a session on X" / "Begin 90 min on X" → START_SESSION (explicit)

2. **Use the UIL context above.** It tells you this person's energy, focus patterns, coaching style, and recurring distractions. Tailor every response to it.

3. **When the user corrects you** ("no I meant...", "wrong topic", "not that", "I said X not Y") → use CORRECTION_NOTED. Acknowledge the error, state what you now understand.

4. **Require confirmation before starting sessions.** When START_SESSION is appropriate, respond with a confirmation prompt and set action=START_SESSION. The system will ask "Go?" before executing.

5. **One question at a time.** Never ask multiple clarifying questions in one message.

AVAILABLE ACTIONS:
- "START_SESSION": Start a focus session (requires explicit trigger). Payload: targetTitle, durationMinutes (default 60), mood (high/medium/low).
- "ADJUST_SESSION": Change duration of the CURRENT active session. Payload: durationMinutes (new total).
- "END_SESSION": End the current session.
- "STORE_INTENTION": Store a planned intention without starting anything. Payload: intention (string), when ("today"|"tomorrow"|"this_week").
- "LOG_EVENING": Log evening check-in — sleep time, wake estimate, tomorrow's intention. Payload: sleepTime ("HH:MM" 24h or null), wakeEstimate ("HH:MM" 24h or null, derive as sleepTime+8h if not stated), tomorrowIntention (string or null), recap (string).
- "CORRECTION_NOTED": User corrected a prior bot inference. Payload: wasWrong (what was incorrectly inferred), actualMeaning (what user actually meant).
- "LOG_HABIT": Log a habit. Payload: habitTitle.
- "LOG_STANDUP": Set today's goal + mood. Payload: goal (string), mood (high/medium/low).
- "SUBMIT_FEEDBACK": Post-session reflection/feedback. Payload: feedback (string), sessionId (if inferable).
- "SHOW_TASKS": Show ranked tasks for today.
- "SHOW_HABITS": Show today's habit status.
- "WEEKLY_PLAN": Show this week's plan.
- "GOAL_STATUS": Show goal health status.
- "SESSION_REVIEW": Show pending session completions.
- "CALIBRATION": Show model calibration accuracy.
- "STANDUP": Show standup brief (energy + suggestions).
- "STATUS": Current session status.
- "MENU": Show the full action menu.
- "CREATE_TASK": Create a new task. Payload: title (required), task_type (task/assignment/exam), status (todo/doing, default todo), priority (low/medium/high/critical, default medium), due_date (YYYY-MM-DD or null), due_time (HH:MM 24h or null), course (string or null).
- "UPDATE_TASK": Update an existing task. Payload: searchTitle, title, status, priority, due_date, due_time, course, task_type.
- "DELETE_TASK": Delete a task by title. Payload: searchTitle.
- "CREATE_GOAL": Create a new goal. Payload: title (required), category (productivity/health/learning/finance/relationships/other), deadline (YYYY-MM-DD or null).
- "DELETE_GOAL": Delete a goal. Payload: searchTitle.
- "CREATE_HABIT": Create a new habit. Payload: name (required), icon (emoji, default ✅), goal_metric (boolean/time, default boolean), goal_target (minutes if time, default 60).
- "UPDATE_HABIT": Rename a habit. Payload: searchName, newName.
- "DELETE_HABIT": Delete/archive a habit. Payload: searchName.
- "CHAT": Conversational reply (no action).

Respond ONLY with valid JSON:
{
  "action": "<ACTION>",
  "replyText": "<HTML reply to user, very brief, Telegram HTML allowed (<b>, <i>)>",
  "payload": {
    "targetTitle": "string",
    "durationMinutes": 60,
    "mood": "high|medium|low",
    "habitTitle": "string",
    "goal": "string",
    "feedback": "string",
    "title": "string",
    "status": "todo|doing|done",
    "priority": "string",
    "task_type": "task|assignment|exam",
    "due_date": "YYYY-MM-DD or null",
    "due_time": "HH:MM or null",
    "course": "string or null",
    "searchTitle": "string",
    "searchName": "string",
    "newName": "string",
    "category": "string",
    "deadline": "string",
    "name": "string",
    "icon": "string",
    "goal_metric": "boolean|time",
    "goal_target": 60
  }
}`;

// ─── Data fetchers (sync where possible to avoid async in the agent) ──────────

function fetchTasksData() {
    try {
        const { computeEnergyComposite } = require('./energy-composite') as typeof import('./energy-composite');
        const { rankTasksForSession } = require('./session-task-ranker') as typeof import('./session-task-ranker');
        const energy = computeEnergyComposite();
        return rankTasksForSession(energy.composite_score, 6);
    } catch {
        return [];
    }
}

function fetchHabitsData() {
    try {
        const db = getDb();
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        return db.prepare(`
      SELECT h.name as title, h.goal_metric, h.goal_target as target_value,
             COALESCE(hc.completed, 0) as completed,
             COALESCE(hc.value, 0) as current_value,
             0 as streak
      FROM habits h
      LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
      WHERE h.archived = 0
      ORDER BY h.created_at ASC
    `).all(today) as Array<{
            title: string; goal_metric: string; target_value: number | null;
            completed: number; current_value: number; streak: number;
        }>;
    } catch {
        return [];
    }
}

function fetchStandupData() {
    try {
        const { computeEnergyComposite } = require('./energy-composite') as typeof import('./energy-composite');
        const { rankTasksForSession } = require('./session-task-ranker') as typeof import('./session-task-ranker');
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const goal = getSetting('standup_goal_today');
        const goalDate = getSetting('standup_goal_date');
        const mood = getSetting('standup_mood_today');
        const isToday = goalDate === today;

        const energy = computeEnergyComposite();
        const suggestedTasks = rankTasksForSession(energy.composite_score, 4);

        let weakConcepts: Array<{ id: number; title: string; mastery: number; goalTitle: string | null }> = [];
        try {
            const { getUnblockedNextConcepts } = require('./graph') as typeof import('./graph');
            const db = getDb();
            const goals = db.prepare(`SELECT id, title FROM goals WHERE active = 1`).all() as { id: number; title: string }[];
            for (const g of goals) {
                const concepts = getUnblockedNextConcepts(g.id).slice(0, 2);
                for (const c of concepts) {
                    weakConcepts.push({ id: c.id, title: c.title, mastery: Math.round(c.mastery * 100), goalTitle: g.title });
                }
            }
            weakConcepts = weakConcepts.sort((a, b) => a.mastery - b.mastery).slice(0, 3);
        } catch { /* non-fatal */ }

        const ist = Date.now() + 19800000;
        const today2 = new Date(ist).toISOString().slice(0, 10);

        // Upcoming deadlines this week
        let deadlines: Array<{ id: number; title: string; due_date: string; due_time: string | null; task_type: string; course: string | null; daysLeft: number }> = [];
        try {
            const db = getDb();
            const dueTasks = db.prepare(`
                SELECT id, title, due_date, due_time, task_type, course
                FROM tasks
                WHERE due_date IS NOT NULL AND status NOT IN ('done','cancelled')
                  AND due_date <= date('now', '+7 days')
                ORDER BY due_date ASC LIMIT 5
            `).all() as Array<{ id: number; title: string; due_date: string; due_time: string | null; task_type: string; course: string | null }>;
            deadlines = dueTasks.map(t => {
                const todayD = new Date(today2 + 'T00:00:00');
                const dueD = new Date(t.due_date + 'T00:00:00');
                return { ...t, daysLeft: Math.round((dueD.getTime() - todayD.getTime()) / 86400000) };
            });
        } catch { /* non-fatal */ }

        return {
            goal: isToday ? goal : null,
            mood: isToday ? mood : null,
            energy: {
                composite: energy.composite_score,
                band: energy.composite_score >= 65 ? 'high' : energy.composite_score >= 35 ? 'medium' : 'low',
            },
            suggestedTasks,
            weakConcepts,
            deadlines,
        };
    } catch {
        return null;
    }
}

function fetchGoalsData() {
    try {
        const db = getDb();
        return db.prepare(`
      SELECT title, health_status, actual_velocity, velocity_needed,
             progress_value, target_value, deadline
      FROM goals WHERE active = 1 ORDER BY health_status ASC, title ASC
    `).all() as Array<{
            title: string; health_status: string | null; actual_velocity: number | null;
            velocity_needed: number | null; progress_value: number | null;
            target_value: number | null; deadline: string | null;
        }>;
    } catch {
        return [];
    }
}

function fetchPendingReviews() {
    try {
        const db = getDb();
        return db.prepare(`
      SELECT sc.id, sc.session_id, sc.task_id,
             t.title as task_title,
             gss.target_title, gss.elapsed_minutes, gss.average_focus_score,
             gss.mood
      FROM session_completions sc
      LEFT JOIN tasks t ON t.id = sc.task_id
      LEFT JOIN guardian_session_summaries gss ON gss.session_id = sc.session_id
      WHERE sc.status = 'pending'
      ORDER BY sc.created_at DESC
      LIMIT 5
    `).all() as Array<{
            id: number; session_id: string; task_id: number | null;
            task_title: string | null; target_title: string | null;
            elapsed_minutes: number | null; average_focus_score: number | null;
            mood: string | null;
        }>;
    } catch {
        return [];
    }
}

// ─── Exported handler ─────────────────────────────────────────────────────────

export async function handleTelegramCommand(text: string): Promise<void> {
    // Check if we're awaiting feedback for a specific session
    const awaitingFeedbackSession = getSetting('telegram_awaiting_feedback_session');
    if (awaitingFeedbackSession && text.trim().length > 10 && !text.startsWith('/')) {
        setSetting('telegram_awaiting_feedback_session', '');
        try {
            const { processSessionFeedback } = require('./guardian-calibration') as typeof import('./guardian-calibration');
            const db = getDb();
            const session = db.prepare(`
        SELECT average_focus_score, elapsed_minutes, duration_minutes, blocked_count, override_count
        FROM guardian_session_summaries WHERE session_id = ? LIMIT 1
      `).get(awaitingFeedbackSession) as { average_focus_score: number | null; elapsed_minutes: number | null; duration_minutes: number | null; blocked_count: number | null; override_count: number | null } | undefined;

            const energyRow = db.prepare(`SELECT composite_score FROM energy_readings WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 1`).get(awaitingFeedbackSession) as { composite_score: number } | undefined;

            const result = processSessionFeedback(awaitingFeedbackSession, text, {
                system_energy_composite: energyRow?.composite_score ?? null,
                system_focus_score: session?.average_focus_score ?? null,
                system_distraction_events: session?.blocked_count ?? null,
                system_tab_switch_count: null,
                system_idle_minutes: null,
                system_intervention_count: session?.blocked_count ?? null,
                system_override_count: session?.override_count ?? null,
                elapsed_minutes: session?.elapsed_minutes ?? null,
                planned_minutes: session?.duration_minutes ?? null,
            });
            const adj = result.adjustments.length;
            const acc = result.newAccuracy !== null ? ` Accuracy: ${Math.round(result.newAccuracy * 100)}%` : '';
            await sendTelegram(`✅ <b>Feedback saved.</b>${adj > 0 ? ` ${adj} weight${adj > 1 ? 's' : ''} adjusted.` : ''}${acc}`, 'HTML', FULL_MENU_KEYBOARD);
        } catch (err) {
            await sendTelegram(`⚠️ Feedback saved but calibration failed: ${(err as Error).message}`, 'HTML');
        }
        return;
    }

    // Check for pending confirmation (START_SESSION requires "yes/go" before executing)
    if (!text.startsWith('/')) {
        const pending = consumePendingConfirmation(SINGLE_USER_KEY);
        if (pending) {
            if (isConfirmation(text)) {
                await executeAction(pending.action, pending.replyText, pending.payload);
                return;
            } else if (isDenial(text)) {
                await sendTelegram('Got it — cancelled.', 'HTML', FULL_MENU_KEYBOARD);
                return;
            }
            // Not a clear yes/no — fall through to normal LLM processing
        }
    }

    // Slash command dispatch
    const cmd = text.trim();
    const cmdLower = cmd.toLowerCase();

    if (cmdLower === '/start' || cmdLower === '/menu') {
        await sendTelegram(`🛡️ <b>LifeOS Guardian</b>\n\nWhat would you like to do?`, 'HTML', FULL_MENU_KEYBOARD);
        return;
    }
    if (cmdLower === '/status') {
        await executeAction('STATUS', '', {});
        return;
    }
    if (cmdLower === '/tasks') {
        await executeAction('SHOW_TASKS', '', {});
        return;
    }
    if (cmdLower === '/habits') {
        await executeAction('SHOW_HABITS', '', {});
        return;
    }
    if (cmdLower === '/goals') {
        await executeAction('GOAL_STATUS', '', {});
        return;
    }
    if (cmdLower === '/plan') {
        await executeAction('WEEKLY_PLAN', '', {});
        return;
    }
    if (cmdLower === '/standup') {
        await executeAction('STANDUP', '', {});
        return;
    }
    if (cmdLower === '/review') {
        await executeAction('SESSION_REVIEW', '', {});
        return;
    }
    if (cmdLower === '/calibration') {
        await executeAction('CALIBRATION', '', {});
        return;
    }
    if (cmdLower === '/report') {
        // Reuse the action:report webhook path via executeAction-like call
        const db = getDb();
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const sessRow = db.prepare(`SELECT COUNT(*) as count, COALESCE(AVG(average_focus_score),0) as avg_focus, COALESCE(SUM(elapsed_minutes),0) as total_minutes FROM guardian_session_summaries WHERE date(completed_at,'localtime')=?`).get(today) as { count: number; avg_focus: number; total_minutes: number };
        const tasksRow = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done FROM tasks WHERE status IN ('done','todo','doing')`).get() as { total: number; done: number };
        const habitsRow = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN hc.completed=1 THEN 1 ELSE 0 END) as done FROM habits h LEFT JOIN habit_checkins hc ON hc.habit_id=h.id AND hc.date=? WHERE h.archived=0`).get(today) as { total: number; done: number };
        const emoji = sessRow.avg_focus >= 85 ? '🔥' : sessRow.avg_focus >= 70 ? '✅' : sessRow.avg_focus >= 50 ? '🟡' : '🔴';
        await sendTelegram(
            `📊 <b>Daily Report — ${today}</b>\n\n${emoji} <b>Avg Focus:</b> ${Math.round(sessRow.avg_focus)}/100\n🛡️ <b>Sessions:</b> ${sessRow.count} (${sessRow.total_minutes}m total)\n📋 <b>Tasks:</b> ${tasksRow.done}/${tasksRow.total} done\n💪 <b>Habits:</b> ${habitsRow.done}/${habitsRow.total} checked`,
            'HTML', FULL_MENU_KEYBOARD
        );
        return;
    }
    if (cmdLower === '/status') {
        const session = getActiveGuardianSession();
        const { getIntelligenceProfile: getProfile } = require('./intelligence') as typeof import('./intelligence');
        const profile = getProfile();
        const lines: string[] = [];

        if (session) {
            const elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000));
            const remaining = Math.max(0, session.durationMinutes - elapsed);
            const focusScore = session.focusScoreHistory?.at(-1) ?? 100;
            const stateIcon = session.state === 'BREAK' ? '⏸' : focusScore >= 75 ? '🟢' : focusScore >= 50 ? '🟡' : '🔴';
            lines.push(`${stateIcon} <b>Active:</b> ${session.targetTitle}`);
            lines.push(`⏱ <b>Time:</b> ${elapsed}m elapsed · ${remaining}m remaining`);
            lines.push(`🎯 <b>Focus:</b> ${focusScore}/100  |  <b>State:</b> ${session.state}`);
        } else {
            lines.push(`💤 <b>No active session</b>`);
            if (profile.nextBestFocusWindow) {
                lines.push(`⚡ <b>Best window:</b> ${profile.nextBestFocusWindow}`);
            }
        }

        lines.push('');
        lines.push(`📈 <b>Trend:</b> ${profile.focusTrend || 'stable'}  ·  <b>Style:</b> ${profile.preferredCoachingStyle || 'balanced'}`);

        if (profile.coachingInsights?.length) {
            lines.push('');
            lines.push(`<b>Insights:</b>`);
            profile.coachingInsights.slice(0, 3).forEach((ins: string) => lines.push(`• ${ins}`));
        }

        await sendTelegram(lines.join('\n'), 'HTML', SESSION_START_KEYBOARD);
        return;
    }
    if (cmdLower === '/endsession') {
        await executeAction('END_SESSION', '', {});
        return;
    }
    if (cmdLower === '/reflect') {
        const { sendEveningReflection } = require('./checkin') as typeof import('./checkin');
        await sendEveningReflection();
        return;
    }
    if (cmdLower === '/morning') {
        const { sendMorningCheckin } = require('./checkin') as typeof import('./checkin');
        await sendMorningCheckin();
        return;
    }
    // /addtask <title>
    if (cmdLower.startsWith('/addtask ')) {
        const title = cmd.slice('/addtask '.length).trim();
        await executeAction('CREATE_TASK', '', { title, status: 'todo', priority: 'medium' });
        return;
    }
    if (cmdLower === '/addtask') {
        await sendTelegram('Usage: <code>/addtask Task title here</code>', 'HTML');
        return;
    }
    // /deletetask <search>
    if (cmdLower.startsWith('/deletetask ')) {
        const searchTitle = cmd.slice('/deletetask '.length).trim();
        await executeAction('DELETE_TASK', '', { searchTitle });
        return;
    }
    if (cmdLower === '/deletetask') {
        await sendTelegram('Usage: <code>/deletetask partial task name</code>', 'HTML');
        return;
    }
    // /addgoal <title>
    if (cmdLower.startsWith('/addgoal ')) {
        const title = cmd.slice('/addgoal '.length).trim();
        await executeAction('CREATE_GOAL', '', { title });
        return;
    }
    if (cmdLower === '/addgoal') {
        await sendTelegram('Usage: <code>/addgoal Goal title here</code>', 'HTML');
        return;
    }
    // /addhabit <name>
    if (cmdLower.startsWith('/addhabit ')) {
        const name = cmd.slice('/addhabit '.length).trim();
        await executeAction('CREATE_HABIT', '', { name });
        return;
    }
    if (cmdLower === '/addhabit') {
        await sendTelegram('Usage: <code>/addhabit Habit name here</code>', 'HTML');
        return;
    }
    // /deletehabit <search>
    if (cmdLower.startsWith('/deletehabit ')) {
        const searchName = cmd.slice('/deletehabit '.length).trim();
        await executeAction('DELETE_HABIT', '', { searchName });
        return;
    }
    // /session <topic> or just /session
    if (cmdLower.startsWith('/session ')) {
        const topic = cmd.slice('/session '.length).trim();
        await executeAction('START_SESSION', '', { targetTitle: topic, durationMinutes: 60 });
        return;
    }
    // Allow user to literally type "session:60" or "/session:60"
    if (cmdLower.startsWith('session:') || cmdLower.startsWith('/session:')) {
        const parts = cmd.split(':');
        const duration = parseInt(parts[1]?.trim(), 10) || 60;
        await executeAction('START_SESSION', '', { targetTitle: 'Focus Session', durationMinutes: duration });
        return;
    }
    if (cmdLower === '/session') {
        await sendTelegram('Usage: <code>/session Topic name</code> — or just tell me what to focus on.', 'HTML', FULL_MENU_KEYBOARD);
        return;
    }
    if (cmdLower === '/help') {
        await sendTelegram(
            `🛡️ <b>LifeOS Commands</b>\n\n` +
            `<b>Sessions</b>\n/session &lt;topic&gt; — Start focus session\n/endsession — End current session\n/status — Current session status\n\n` +
            `<b>View</b>\n/tasks — Today's ranked tasks\n/habits — Habit check-ins\n/goals — Goal health status\n/plan — Weekly plan\n/standup — Standup brief\n/review — Pending reviews\n/report — Daily report\n/calibration — Model accuracy\n\n` +
            `<b>Create</b>\n/addtask &lt;title&gt;\n/addgoal &lt;title&gt;\n/addhabit &lt;name&gt;\n\n` +
            `<b>Delete</b>\n/deletetask &lt;search&gt;\n/deletehabit &lt;search&gt;\n\n` +
            `Or just send a natural language message — Jarvis understands context.`,
            'HTML', FULL_MENU_KEYBOARD
        );
        return;
    }

    const ai = getGenAI();
    if (!ai) {
        await sendTelegram('❌ LLM not configured. Use /menu for quick actions.', 'HTML', FULL_MENU_KEYBOARD);
        return;
    }

    const memoryCtx = getMemoryContext(3);
    const activeSession = getActiveGuardianSession();

    // Build the same rich context block the voice parser uses
    // Signal new data so UIL profile is fresh for this message (prevents stale context)
    touchIntelligence('telegram_message');
    const uilContext = getIntelligenceContext({ maxInsights: 2, includeToday: true, includeThresholds: false });
    const sessionBlock = activeSession
      ? [
          'ACTIVE SESSION:',
          `  topic:     "${activeSession.targetTitle}"`,
          `  elapsed:   ${Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60_000))} min`,
          `  remaining: ${Math.max(0, activeSession.durationMinutes - Math.round((Date.now() - activeSession.startedAt) / 60_000))} min (of ${activeSession.durationMinutes} planned)`,
          `  focus:     ${activeSession.focusScoreHistory?.at(-1) ?? 100}/100`,
          `  state:     ${activeSession.state}`,
        ].join('\n')
      : 'ACTIVE SESSION: none';

    const contextBlock = `--- CURRENT STATE ---\n${sessionBlock}\nUSER MEMORY: ${memoryCtx || 'None'}\n\n${uilContext}\n---------------------`;

    // Load recent conversation turns for multi-turn context
    let turnHistoryBlock = '';
    try {
        const db = getDb();
        const recentTurns = db.prepare(
            `SELECT role, text FROM voice_turns WHERE session_key = 'telegram'
             ORDER BY created_at DESC LIMIT 8`
        ).all() as { role: string; text: string }[];
        if (recentTurns.length > 0) {
            const chronological = recentTurns.reverse();
            turnHistoryBlock = '\n\nRECENT CONVERSATION:\n' + chronological
                .map(t => `${t.role === 'user' ? 'User' : 'LifeOS'}: ${t.text}`)
                .join('\n');
        }
    } catch { /* non-fatal */ }

    try {
        const response = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: `${TELEGRAM_SYSTEM_PROMPT}\n${contextBlock}${turnHistoryBlock}\n\nUSER: "${text}"`,
            config: { responseMimeType: 'application/json' },
        });

        const parsed = JSON.parse((response.text || '{}').trim()) as {
            action: string;
            replyText: string;
            payload?: Record<string, unknown>;
        };

        // Cross-channel memory: persist TG turns to voice_turns so voice parser has TG context
        try {
            const db = getDb();
            const tgKey = 'telegram';
            db.prepare('INSERT INTO voice_turns (session_key, role, text, action) VALUES (?, ?, ?, ?)').run(tgKey, 'user', text, null);
            if (parsed.replyText) {
                db.prepare('INSERT INTO voice_turns (session_key, role, text, action) VALUES (?, ?, ?, ?)').run(tgKey, 'model', parsed.replyText, parsed.action ?? null);
            }
        } catch { /* non-fatal */ }

        // Memory extraction every 8 TG LLM messages (same pattern as voice every-5-turns)
        tgLlmTurnCount++;
        if (tgLlmTurnCount % 8 === 0) {
            try {
                const db = getDb();
                const rows = db.prepare(
                    `SELECT role, text FROM voice_turns WHERE session_key = 'telegram'
                     ORDER BY created_at DESC LIMIT 20`
                ).all() as { role: string; text: string }[];
                const turns = rows.reverse();
                extractMemoryFromVoice(turns, 'telegram').catch(() => {});
            } catch { /* non-fatal */ }
        }

        // Gate START_SESSION through confirmation unless already confirmed
        if (parsed.action === 'START_SESSION' && !getActiveGuardianSession()) {
            const title = (parsed.payload?.targetTitle as string | undefined) || 'General Focus';
            const duration = Number(parsed.payload?.durationMinutes) || 60;
            setPendingConfirmation(SINGLE_USER_KEY, 'START_SESSION', parsed.payload ?? {}, parsed.replyText);
            await sendTelegram(
                `Starting a <b>${duration}-min session</b> on "<b>${title}</b>". Go? (yes / no)`,
                'HTML', FULL_MENU_KEYBOARD
            );
        } else {
            await executeAction(parsed.action, parsed.replyText, parsed.payload ?? {}, activeSession);
        }

    } catch (err) {
        console.error('[TelegramAgent] Error:', err);
        await sendTelegram(`Sorry, I couldn't process that. Use /menu for options.`, 'HTML', FULL_MENU_KEYBOARD);
    }
}

// ─── Action executor ─────────────────────────────────────────────────────────

export async function executeAction(
    action: string,
    replyText: string,
    payload: Record<string, unknown>,
    activeSession?: ReturnType<typeof getActiveGuardianSession>,
): Promise<void> {
    const session = activeSession ?? getActiveGuardianSession();

    switch (action) {

        case 'START_SESSION': {
            if (session) {
                // Active session exists — offer to adjust instead of hard-blocking
                const elapsed = Math.max(0, Math.floor((Date.now() - session.startedAt) / 60000));
                const remaining = Math.max(0, session.durationMinutes - elapsed);
                await sendTelegram(
                    `Session already active: <b>${session.targetTitle}</b> (${elapsed}m elapsed, ${remaining}m left).\n\nDid you mean to adjust it? Use <code>/adjust &lt;minutes&gt;</code> or end it first.`,
                    'HTML', SESSION_START_KEYBOARD
                );
                break;
            }
            const title = (payload.targetTitle as string | undefined) || 'General Focus';
            const duration = Number(payload.durationMinutes) || 60;
            const moodRaw = payload.mood as string | undefined;
            const mood = (moodRaw === 'high' || moodRaw === 'medium' || moodRaw === 'low') ? moodRaw : undefined;
            startGuardianSession({ topic: title, durationMinutes: duration, mood, source: 'api' });
            await sendTelegram(`🛡️ ${replyText || `Session started: <b>${title}</b> for ${duration}m`}`, 'HTML', SESSION_START_KEYBOARD);
            break;
        }

        case 'ADJUST_SESSION': {
            if (!session) {
                await sendTelegram('No active session to adjust.', 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            const newDuration = Number(payload.durationMinutes);
            if (!newDuration || newDuration < 1) {
                await sendTelegram('What duration should I change the session to? (in minutes)', 'HTML');
                break;
            }
            const { adjustGuardianSessionDuration } = require('./guardian-runtime') as typeof import('./guardian-runtime');
            const adjusted = adjustGuardianSessionDuration(session.sessionId, newDuration);
            if (!adjusted) {
                await sendTelegram('Could not find the session to adjust.', 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            const adjElapsed = Math.max(0, Math.round((Date.now() - adjusted.startedAt) / 60_000));
            const adjRemaining = Math.max(0, newDuration - adjElapsed);
            await sendTelegram(
                `✅ Session adjusted to <b>${newDuration} min</b>.\n⏱️ ${adjElapsed}m elapsed · ${adjRemaining}m remaining`,
                'HTML', SESSION_START_KEYBOARD
            );
            break;
        }

        case 'END_SESSION': {
            if (!session) {
                await sendTelegram('💤 No active session to end.', 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            endGuardianSession(session.sessionId);
            // Prompt for feedback
            setSetting('telegram_awaiting_feedback_session', session.sessionId);
            await sendTelegram(
                `🏁 ${replyText || 'Session ended.'}\n\n💬 How did it feel? Reply with a short reflection to calibrate your model.\n<i>(or send anything else to skip)</i>`,
                'HTML'
            );
            break;
        }

        case 'LOG_HABIT': {
            const title = payload.habitTitle as string | undefined;
            if (!title) { await sendTelegram('Which habit? Tell me the name.', ''); break; }
            const db = getDb();
            const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
            try {
                const habit = db.prepare(`SELECT id FROM habits WHERE archived = 0 AND LOWER(name) LIKE ? LIMIT 1`).get(`%${title.toLowerCase()}%`) as { id: number } | undefined;
                if (!habit) { await sendTelegram(`Habit "${title}" not found.`, ''); break; }
                db.prepare(`
          INSERT INTO habit_checkins (habit_id, date, completed, value, source)
          VALUES (?, ?, 1, NULL, 'telegram')
          ON CONFLICT(habit_id, date) DO UPDATE SET completed = 1, source = 'telegram'
        `).run(habit.id, today);
                await sendTelegram(`✅ ${replyText || `Logged: ${title}`}`, 'HTML', FULL_MENU_KEYBOARD);
            } catch (err) {
                await sendTelegram(`Failed: ${(err as Error).message}`, '');
            }
            break;
        }

        case 'LOG_STANDUP': {
            const goal = payload.goal as string | undefined;
            const mood = payload.mood as string | undefined;
            if (!goal) { await sendTelegram('What is your goal for today?', ''); break; }
            const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
            setSetting('standup_goal_today', goal);
            setSetting('standup_goal_date', today);
            if (mood) setSetting('standup_mood_today', mood);
            await sendTelegram(`✅ ${replyText || `Today's goal set: <b>${goal}</b>`}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'SUBMIT_FEEDBACK': {
            const feedbackText = payload.feedback as string | undefined;
            if (!feedbackText) {
                // Ask for feedback
                const sessionToFeedback = (payload.sessionId as string | undefined) || '';
                setSetting('telegram_awaiting_feedback_session', sessionToFeedback);
                await sendTelegram('💬 How did the session feel? Reply with your reflection.', '');
                break;
            }
            // Process inline feedback
            const sessionId = payload.sessionId as string || getSetting('telegram_awaiting_feedback_session') || '';
            setSetting('telegram_awaiting_feedback_session', '');
            if (!sessionId) { await sendTelegram('No session ID to attach feedback to.', ''); break; }
            try {
                const { processSessionFeedback } = require('./guardian-calibration') as typeof import('./guardian-calibration');
                const result = processSessionFeedback(sessionId, feedbackText, {
                    system_energy_composite: null, system_focus_score: null, system_distraction_events: null,
                    system_tab_switch_count: null, system_idle_minutes: null,
                    system_intervention_count: null, system_override_count: null,
                    elapsed_minutes: null, planned_minutes: null,
                });
                await sendTelegram(`✅ Feedback saved. ${result.adjustments.length} adjustments made.`, 'HTML', FULL_MENU_KEYBOARD);
            } catch { await sendTelegram(`Feedback saved.`, 'HTML', FULL_MENU_KEYBOARD); }
            break;
        }

        case 'SHOW_TASKS': {
            const tasks = fetchTasksData();
            await sendTelegram(formatTasksList(tasks), 'HTML', buildTaskChipsKeyboard(tasks.map(t => ({ id: t.id, title: t.title }))));
            break;
        }

        case 'SHOW_HABITS': {
            const habits = fetchHabitsData();
            await sendTelegram(formatHabitStatus(habits.map(h => ({
                title: h.title,
                completed: !!h.completed,
                streak: h.streak,
                target_value: h.target_value,
                current_value: h.current_value,
                goal_metric: h.goal_metric,
            }))), 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'WEEKLY_PLAN': {
            const { loadActiveWeeklyPlan, generateWeeklyPlan, saveWeeklyPlan } = require('./weekly-planner') as typeof import('./weekly-planner');
            let plan = loadActiveWeeklyPlan();
            if (!plan) { plan = generateWeeklyPlan(); saveWeeklyPlan(plan); }
            await sendTelegram(formatWeeklyPlanSummary(plan), 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'GOAL_STATUS': {
            const goals = fetchGoalsData();
            await sendTelegram(formatGoalHealthStatus(goals), 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'SESSION_REVIEW': {
            const reviews = fetchPendingReviews();
            if (reviews.length === 0) {
                await sendTelegram(`📝 <b>Review Queue</b>\n\nNo pending reviews — all caught up! 🎉`, 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            const { buildReviewKeyboard } = require('./telegram') as typeof import('./telegram');
            await sendTelegram(formatPendingReviews(reviews), 'HTML', buildReviewKeyboard(reviews[0].id));
            break;
        }

        case 'STANDUP': {
            const data = fetchStandupData();
            if (!data) { await sendTelegram('Could not fetch standup data.', ''); break; }
            const tasks = (data.suggestedTasks as Array<{ id: number; title: string }>) ?? [];
            await sendTelegram(formatStandupBrief({
                goal: data.goal ?? null,
                mood: data.mood ?? null,
                energy: data.energy,
                suggestedTasks: data.suggestedTasks as Array<{ id: number; title: string; goal_health: string | null; reason: string }>,
                weakConcepts: data.weakConcepts,
            }), 'HTML', buildTaskChipsKeyboard(tasks));
            break;
        }

        case 'CALIBRATION': {
            const { getCalibrationStatus } = require('./guardian-calibration') as typeof import('./guardian-calibration');
            const status = getCalibrationStatus();
            await sendTelegram(formatCalibrationStatus(status), 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'STATUS': {
            if (session) {
                const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
                const remaining = Math.max(0, session.durationMinutes - elapsed);
                await sendTelegram(
                    `🛡️ <b>Session Active</b>\n📚 ${session.targetTitle}\n⏱️ ${elapsed}m elapsed · ${remaining}m left\n🔴 ${session.blockedCount} blocks`,
                    'HTML', SESSION_START_KEYBOARD
                );
            } else {
                const standup = fetchStandupData();
                const energyLine = standup?.energy ? `\n${standup.energy.band === 'high' ? '🟢' : standup.energy.band === 'medium' ? '🟡' : '🔴'} Energy: ${standup.energy.band} (${Math.round(standup.energy.composite)}/100)` : '';
                await sendTelegram(`💤 <b>No active session.</b>${energyLine}`, 'HTML', FULL_MENU_KEYBOARD);
            }
            break;
        }

        case 'CREATE_TASK': {
            const title = (payload.title as string | undefined)?.trim();
            if (!title) { await sendTelegram('What should the task be called?', ''); break; }
            const db = getDb();
            const safeStatus = ['todo', 'doing', 'done'].includes(payload.status as string) ? (payload.status as string) : 'todo';
            const safeType = ['task', 'assignment', 'exam'].includes(payload.task_type as string) ? (payload.task_type as string) : 'task';
            const result = db.prepare(
                `INSERT INTO tasks (title, status, priority, task_type, due_date, due_time, course) VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(
                title,
                safeStatus,
                (payload.priority as string | undefined) || 'medium',
                safeType,
                (payload.due_date as string | undefined) || null,
                (payload.due_time as string | undefined) || null,
                (payload.course as string | undefined) || null,
            );
            const taskId = Number(result.lastInsertRowid);
            // Fire-and-forget: auto-link + prioritize
            try { const { autoLinkTaskToGoal } = require('./task-auto-linker') as typeof import('./task-auto-linker'); autoLinkTaskToGoal(taskId).catch(console.error); } catch { /* non-fatal */ }
            try { const { triggerPrioritize } = require('./task-priority-ranker') as typeof import('./task-priority-ranker'); triggerPrioritize(); } catch { /* non-fatal */ }
            const typeLabel = safeType === 'exam' ? ' (exam)' : safeType === 'assignment' ? ' (assignment)' : '';
            const courseLabel = payload.course ? ` [${payload.course}]` : '';
            const dueLabel = payload.due_date ? ` · due ${payload.due_date}` : '';
            await sendTelegram(`✅ Task created: <b>${title}</b>${typeLabel}${courseLabel}${dueLabel}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'UPDATE_TASK': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram('Which task? Give me a search term.', ''); break; }
            const db = getDb();
            const task = db.prepare(`SELECT id, title FROM tasks WHERE LOWER(title) LIKE ? AND status != 'done' LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!task) { await sendTelegram(`Task matching "<i>${search}</i>" not found.`, 'HTML', FULL_MENU_KEYBOARD); break; }
            const sets: string[] = [];
            const vals: (string | number)[] = [];
            if (payload.title) { sets.push('title = ?'); vals.push(payload.title as string); }
            if (payload.status) { sets.push('status = ?'); vals.push(payload.status as string); }
            if (payload.priority) { sets.push('priority = ?'); vals.push(payload.priority as string); }
            if (sets.length === 0) { await sendTelegram('Nothing to update — specify title, status, or priority.', ''); break; }
            vals.push(task.id);
            db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
            await sendTelegram(`✅ Updated task: <b>${(payload.title as string) || task.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_TASK': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram('Which task should I delete?', ''); break; }
            const db = getDb();
            const task = db.prepare(`SELECT id, title FROM tasks WHERE LOWER(title) LIKE ? LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!task) { await sendTelegram(`Task matching "<i>${search}</i>" not found.`, 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
            await sendTelegram(`🗑️ Deleted task: <b>${task.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'CREATE_GOAL': {
            const title = (payload.title as string | undefined)?.trim();
            if (!title) { await sendTelegram('What should the goal be called?', ''); break; }
            const db = getDb();
            db.prepare(`INSERT INTO goals (title, category, deadline) VALUES (?, ?, ?)`).run(
                title,
                (payload.category as string | undefined) || 'productivity',
                (payload.deadline as string | undefined) || null
            );
            await sendTelegram(`✅ Goal created: <b>${title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_GOAL': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram('Which goal should I delete?', ''); break; }
            const db = getDb();
            const goal = db.prepare(`SELECT id, title FROM goals WHERE LOWER(title) LIKE ? LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!goal) { await sendTelegram(`Goal matching "<i>${search}</i>" not found.`, 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`DELETE FROM goals WHERE id = ?`).run(goal.id);
            await sendTelegram(`🗑️ Deleted goal: <b>${goal.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'CREATE_HABIT': {
            const name = (payload.name as string | undefined)?.trim();
            if (!name) { await sendTelegram('What should the habit be called?', ''); break; }
            const db = getDb();
            db.prepare(`INSERT INTO habits (name, icon, frequency, goal_metric, goal_target) VALUES (?, ?, 'daily', ?, ?)`).run(
                name,
                (payload.icon as string | undefined) || '✅',
                (payload.goal_metric as string | undefined) || 'boolean',
                Number(payload.goal_target) || 1
            );
            await sendTelegram(`✅ Habit created: <b>${name}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'UPDATE_HABIT': {
            const search = (payload.searchName as string | undefined)?.trim();
            const newName = (payload.newName as string | undefined)?.trim();
            if (!search || !newName) { await sendTelegram('Provide both the current habit name and the new name.', ''); break; }
            const db = getDb();
            const habit = db.prepare(`SELECT id, name FROM habits WHERE LOWER(name) LIKE ? AND archived = 0 LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; name: string } | undefined;
            if (!habit) { await sendTelegram(`Habit matching "<i>${search}</i>" not found.`, 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`UPDATE habits SET name = ? WHERE id = ?`).run(newName, habit.id);
            await sendTelegram(`✅ Renamed: <b>${habit.name}</b> → <b>${newName}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_HABIT': {
            const search = (payload.searchName as string | undefined)?.trim();
            if (!search) { await sendTelegram('Which habit should I delete?', ''); break; }
            const db = getDb();
            const habit = db.prepare(`SELECT id, name FROM habits WHERE LOWER(name) LIKE ? AND archived = 0 LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; name: string } | undefined;
            if (!habit) { await sendTelegram(`Habit matching "<i>${search}</i>" not found.`, 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`UPDATE habits SET archived = 1 WHERE id = ?`).run(habit.id);
            await sendTelegram(`🗑️ Archived habit: <b>${habit.name}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'STORE_INTENTION': {
            const intention = payload.intention as string | undefined;
            const when = (payload.when as string | undefined) || 'today';
            if (intention) {
                const db = getDb();
                const today = new Date().toISOString().slice(0, 10);
                try {
                    db.prepare(`
                        INSERT INTO daily_checkins (checkin_date, checkin_type, tomorrow_intention, raw_transcript)
                        VALUES (?, 'evening', ?, ?)
                    `).run(today, `${intention} (${when})`, `[telegram intent] ${intention}`);
                    touchIntelligence('intention_stored');
                } catch { /* non-fatal if column missing until migration runs */ }
            }
            await sendTelegram(replyText || `Stored: ${payload.intention || 'intention'}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'LOG_EVENING': {
            const db = getDb();
            const today = new Date().toISOString().slice(0, 10);
            const sleepTime = payload.sleepTime as string | null ?? null;
            const wakeEstimate = payload.wakeEstimate as string | null ?? null;
            const tomorrowIntention = payload.tomorrowIntention as string | null ?? null;
            const recap = payload.recap as string | undefined;
            try {
                // Upsert evening check-in with sleep/wake fields
                const existing = db.prepare(
                    `SELECT id FROM daily_checkins WHERE checkin_date = ? AND checkin_type = 'evening' ORDER BY received_at DESC LIMIT 1`
                ).get(today) as { id: number } | undefined;
                if (existing) {
                    db.prepare(`
                        UPDATE daily_checkins SET sleep_time = ?, wake_estimate = ?, tomorrow_intention = ?, raw_transcript = ?
                        WHERE id = ?
                    `).run(sleepTime, wakeEstimate, tomorrowIntention, recap ?? null, existing.id);
                } else {
                    db.prepare(`
                        INSERT INTO daily_checkins (checkin_date, checkin_type, sleep_time, wake_estimate, tomorrow_intention, raw_transcript)
                        VALUES (?, 'evening', ?, ?, ?, ?)
                    `).run(today, sleepTime, wakeEstimate, tomorrowIntention, recap ?? null);
                }
                touchIntelligence('evening_checkin');
            } catch { /* non-fatal */ }
            await sendTelegram(replyText || `Evening logged. Wake estimate: ${wakeEstimate ?? 'not set'}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'CORRECTION_NOTED': {
            const wasWrong = payload.wasWrong as string | undefined;
            const actualMeaning = payload.actualMeaning as string | undefined;
            if (wasWrong && actualMeaning) {
                const db = getDb();
                try {
                    db.prepare(`
                        INSERT INTO mem_facts (category, topic, content, confidence, importance, source, status)
                        VALUES ('pattern', ?, ?, 0.15, 0.8, 'telegram_correction', 'active')
                    `).run(
                        `agent_inference:${wasWrong.slice(0, 80)}`,
                        `CORRECTION: agent incorrectly inferred "${wasWrong}" — user actually meant "${actualMeaning}"`
                    );
                    db.prepare(`
                        INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, was_corrected, correction_text, helpful)
                        VALUES ('telegram_inference', ?, ?, 1, ?, 0)
                    `).run(wasWrong.slice(0, 200), actualMeaning.slice(0, 200), `User corrected: ${actualMeaning}`.slice(0, 200));
                    touchIntelligence('correction_recorded');
                } catch { /* non-fatal */ }
            }
            await sendTelegram(replyText || `Understood — noted the correction.`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'MENU':
            await sendTelegram(replyText || `🛡️ <b>Guardian Menu</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;

        case 'CHAT':
        default:
            await sendTelegram(replyText || 'OK', 'HTML', session ? SESSION_START_KEYBOARD : FULL_MENU_KEYBOARD);
            break;
    }
}
