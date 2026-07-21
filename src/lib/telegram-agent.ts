import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import {
    sendTelegram,
    SESSION_START_KEYBOARD,
    FULL_MENU_KEYBOARD,
    formatStandupBrief,
    formatTasksList,
    formatHabitStatus,
    formatNextDayPlanSummary,
    formatWeeklyPlanSummary,
    formatGoalHealthStatus,
    formatPendingReviews,
    formatCalibrationStatus,
    buildTaskChipsKeyboard,
} from './telegram';
import { startGuardianSession, endGuardianSession, getActiveGuardianSession } from './guardian-runtime';
import { classifyEnergy, getAdaptiveBands } from './adaptive-bands';
import { getDb, getSetting, setSetting } from './db';
import { touchIntelligence } from './intelligence';
import { extractMemoryFromVoice } from './memory-extractor';
import { buildPersonalizationSnapshot, formatPersonalizationContext } from './personalization-context';
import { formatCommandMomentLine, getAdaptiveSessionMinutes, getAdaptiveSessionMinutesLabel } from './adaptive-command-defaults';
import { buildAdaptiveNewHabitDefaults } from './adaptive-habit-plan';
import { recordAdaptiveHabitCheckin } from './adaptive-habit-checkin';
import { buildAdaptiveTaskDefaults } from './adaptive-task-defaults';
import { generateNextDayPlan } from './next-day-planner';
import { getTaskTimeProgress } from './task-time-sessions';

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

function focusStatusIcon(score: number): string {
    const bands = getAdaptiveBands();
    if (score >= bands.focusExcellent) return '🔥';
    if (score >= bands.focusGood) return '🟢';
    if (score >= bands.focusNeutral) return '🟡';
    return '🔴';
}

function isConfirmation(text: string): boolean {
    return /^(yes|yeah|go|yep|ok|okay|confirm|do it|start|let'?s go|sure|yup)\b/i.test(text.trim());
}

function isDenial(text: string): boolean {
    return /^(no|nope|cancel|stop|not now|wait|hold on|nevermind|never mind|nah)\b/i.test(text.trim());
}

function normalizeTelegramSignalLevel(value: unknown): 'high' | 'medium' | 'low' | null {
    if (value !== 'high' && value !== 'medium' && value !== 'low') return null;
    return value;
}

function normalizeTelegramTime(value: unknown): string | null {
    return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

function nextIsoDate(): string {
    const tomorrow = new Date(Date.now() + 19_800_000 + 86_400_000);
    return tomorrow.toISOString().slice(0, 10);
}

function formatActiveSessionConflict(session: NonNullable<ReturnType<typeof getActiveGuardianSession>>): string {
    const elapsed = Math.max(0, Math.floor((Date.now() - session.startedAt) / 60000));
    const remaining = Math.max(0, session.durationMinutes - elapsed);
    let suffix = `Use <code>/adjust &lt;minutes&gt;</code> if this block needs to change, or end it first.`;

    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
            activeSession: {
                sessionId: session.sessionId,
                targetTitle: session.targetTitle,
                focusScore: session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? null,
                elapsedMinutes: elapsed,
            },
        });

        if (snapshot.feedback.alertFatigueLevel === 'high') {
            suffix = `Keeping this quiet because alert fatigue is high. Adjust only if the current block is wrong.`;
        } else if (snapshot.moment.mode === 'deadline_pressure') {
            suffix = `If the new request beats this deadline path, use <code>/adjust &lt;minutes&gt;</code>; otherwise finish this relief block first.`;
        } else if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
            suffix = `Do not stack another commitment on a low-capacity window. Shrink or end this one before switching.`;
        } else if (snapshot.moment.mode === 'protect_focus') {
            suffix = `Protect the current thread unless the new request is clearly more important.`;
        } else if ((snapshot.today.plannedFocus.recentFollowThroughRate ?? 1) < 0.5) {
            suffix = `Recent planned-block follow-through is low, so changing plans should be intentional.`;
        }
    } catch { /* keep generic fallback */ }

    return `Session already active: <b>${session.targetTitle}</b> (${elapsed}m elapsed, ${remaining}m left).\n\n${suffix}`;
}

function formatScheduleFitLine(snapshot: ReturnType<typeof buildPersonalizationSnapshot>, plannedMinutes: number): string {
    const mode = snapshot.moment.mode.replace(/_/g, ' ');
    if (snapshot.today.plannedFocus.nextTitle) {
        return `\n<i>Fit: ${mode}; next planned focus is ${snapshot.today.plannedFocus.nextTitle}.</i>`;
    }
    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
        return `\n<i>Fit: low-capacity day; ${plannedMinutes}m is treated as a smaller usable block.</i>`;
    }
    if (snapshot.moment.mode === 'deadline_pressure') {
        return `\n<i>Fit: deadline-pressure mode; this block should reduce the nearest risk before optional work.</i>`;
    }
    if (snapshot.moment.mode === 'planning') {
        return `\n<i>Fit: planning mode; this gives tomorrow a concrete anchor.</i>`;
    }
    if (snapshot.userState.nextBestFocusWindow) {
        return `\n<i>Fit: ${mode}; learned best window is ${snapshot.userState.nextBestFocusWindow}.</i>`;
    }
    return `\n<i>Fit: ${mode}; reminders will follow today's adaptive cadence.</i>`;
}

function formatScheduleClarification(missing: 'title' | 'time' | 'both'): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        const titleAsk = missing === 'time' ? 'Which time should I move it to?' : 'Which focus block should I schedule?';
        const timeAsk = missing === 'title' ? 'When should it start?' : 'What should I schedule, and when should it start?';
        const ask = missing === 'both' ? timeAsk : titleAsk;
        if (snapshot.today.plannedFocus.nextTitle) {
            return `${ask} Existing planned focus: <b>${snapshot.today.plannedFocus.nextTitle}</b>${snapshot.today.plannedFocus.nextMinutes ? ` (${snapshot.today.plannedFocus.nextMinutes}m)` : ''}.`;
        }
        if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
            return `${ask} Keep it small enough for a low-capacity day.`;
        }
        if (snapshot.moment.mode === 'deadline_pressure') {
            return `${ask} Use the window that reduces the nearest deadline risk first.`;
        }
        if (snapshot.moment.mode === 'planning') {
            return `${ask} Prefer a concrete anchor for tomorrow.`;
        }
        if (snapshot.userState.nextBestFocusWindow) {
            return `${ask} Your learned best window is ${snapshot.userState.nextBestFocusWindow}.`;
        }
    } catch { /* keep fallback */ }
    if (missing === 'both') return 'What should I schedule, and when should it start?';
    return missing === 'title' ? 'Which focus block should I schedule?' : 'When should it start?';
}

function formatNoActiveTelegramSession(snapshot: ReturnType<typeof buildPersonalizationSnapshot>, action: 'status' | 'adjust' | 'end'): string {
    if (snapshot.today.plannedFocus.nextTitle) {
        return `💤 <b>No active session.</b> Next planned focus: <b>${snapshot.today.plannedFocus.nextTitle}</b>${snapshot.today.plannedFocus.nextMinutes ? ` (${snapshot.today.plannedFocus.nextMinutes}m)` : ''}.`;
    }
    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
        return `💤 <b>No active session.</b> If you start one, keep it small and low-friction.`;
    }
    if (snapshot.moment.mode === 'deadline_pressure') {
        return `💤 <b>No active session.</b> Start the deadline-relief block before optional work.`;
    }
    if (snapshot.moment.mode === 'planning') {
        return `💤 <b>No active session.</b> Lock tomorrow's first block before adding more.`;
    }
    if (action === 'adjust') return `💤 <b>No active session to adjust.</b> Start the next useful block first.`;
    if (action === 'end') return `💤 <b>No active session to end.</b>`;
    if (snapshot.userState.nextBestFocusWindow) {
        return `💤 <b>No active session.</b> Best learned window: <b>${snapshot.userState.nextBestFocusWindow}</b>.`;
    }
    return `💤 <b>No active session.</b> Start the next useful block when ready.`;
}

function formatAdjustDurationPrompt(snapshot: ReturnType<typeof buildPersonalizationSnapshot>): string {
    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
        return 'What smaller duration should I use for this low-capacity window?';
    }
    if (snapshot.moment.mode === 'deadline_pressure') {
        return 'What duration gives enough deadline relief without drifting?';
    }
    if (snapshot.today.plannedFocus.nextMinutes) {
        return `Should I match the planned ${snapshot.today.plannedFocus.nextMinutes}m block, or use a different duration?`;
    }
    return 'What duration should I change the session to?';
}

function formatTelegramLookupPrompt(kind: 'task' | 'goal' | 'habit' | 'session', action: 'update' | 'delete' | 'cancel' | 'log'): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        const verb = action === 'delete' ? 'delete' : action === 'cancel' ? 'cancel' : action === 'log' ? 'log' : 'update';
        if (kind === 'task') {
            if (snapshot.today.plannedFocus.nextTitle) return `Which task should I ${verb}? Planned focus is on <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            if (snapshot.moment.mode === 'deadline_pressure') return `Which deadline-relief task should I ${verb}?`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
                return `Which small or recovery-safe task should I ${verb}?`;
            }
            return `Which task should I ${verb}? Give me a title or search term.`;
        }
        if (kind === 'habit') {
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
                return `Which low-friction habit should I ${verb}?`;
            }
            if (snapshot.moment.mode === 'planning') return `Which tomorrow-supporting habit should I ${verb}?`;
            if (snapshot.today.plannedFocus.nextTitle) return `Which habit should I ${verb} around <b>${snapshot.today.plannedFocus.nextTitle}</b>?`;
            return `Which habit should I ${verb}? Give me the name.`;
        }
        if (kind === 'session') {
            if (snapshot.today.plannedFocus.nextTitle) return `Which planned focus session should I ${verb}? Next planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            if (snapshot.moment.mode === 'deadline_pressure') return `Which deadline session should I ${verb}?`;
            if (snapshot.moment.mode === 'planning') return `Which tomorrow-planning session should I ${verb}?`;
            if (snapshot.userState.nextBestFocusWindow) return `Which session should I ${verb}? Best learned window is <b>${snapshot.userState.nextBestFocusWindow}</b>.`;
            return `Which session should I ${verb}? Give me a title or search term.`;
        }
        if (snapshot.userState.standupGoal) return `Which goal should I ${verb}? Today's stated goal is <b>${snapshot.userState.standupGoal}</b>.`;
        if (snapshot.moment.mode === 'deadline_pressure') return `Which deadline goal should I ${verb}?`;
        if (snapshot.moment.mode === 'planning') return `Which tomorrow-facing goal should I ${verb}?`;
    } catch { /* keep fallback */ }
    if (kind === 'task') return `Which task should I ${action === 'delete' ? 'delete' : 'update'}? Give me a search term.`;
    if (kind === 'habit') return `Which habit should I ${action === 'delete' ? 'delete' : action === 'log' ? 'log' : 'update'}? Give me the name.`;
    if (kind === 'session') return `Which session should I ${action === 'cancel' ? 'cancel' : 'update'}? Give me a search term.`;
    return `Which goal should I ${action === 'delete' ? 'delete' : 'update'}?`;
}

function formatTelegramLookupMiss(kind: 'task' | 'goal' | 'habit' | 'session', search: string): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        const label = kind === 'session' ? 'scheduled session' : kind;
        if (snapshot.today.plannedFocus.nextTitle) {
            return `${label[0].toUpperCase()}${label.slice(1)} matching "<i>${search}</i>" not found. Current planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; try that title or a narrower search term.`;
        }
        if (snapshot.moment.mode === 'deadline_pressure') {
            return `${label[0].toUpperCase()}${label.slice(1)} matching "<i>${search}</i>" not found. Try the deadline, course, or deliverable name so I can protect the pressure path.`;
        }
        if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
            return `${label[0].toUpperCase()}${label.slice(1)} matching "<i>${search}</i>" not found. Use the smallest exact name you remember; keep this lookup low-friction.`;
        }
        if (kind === 'goal' && snapshot.userState.standupGoal) {
            return `Goal matching "<i>${search}</i>" not found. Today's stated goal is <b>${snapshot.userState.standupGoal}</b>; try that wording.`;
        }
    } catch { /* keep fallback */ }
    const label = kind === 'session' ? 'Scheduled session' : kind[0].toUpperCase() + kind.slice(1);
    return `${label} matching "<i>${search}</i>" not found.`;
}

function formatTelegramFailureFallback(): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        if (snapshot.today.plannedFocus.nextTitle) {
            return `I could not process that cleanly. Next planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; send a simpler command like "start ${snapshot.today.plannedFocus.nextTitle}" or use /menu.`;
        }
        if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
            return 'I could not process that cleanly. Keep the next command small: start, schedule, log habit, or /menu.';
        }
        if (snapshot.moment.mode === 'deadline_pressure') {
            return 'I could not process that cleanly. Send the deadline task and one action, or use /menu to avoid losing the window.';
        }
        if (snapshot.moment.mode === 'planning') {
            return 'I could not process that cleanly. Send tomorrow intention, sleep/wake, or /menu for planner actions.';
        }
    } catch { /* keep fallback */ }
    return 'I could not process that cleanly. Use /menu for options.';
}

function formatTelegramTitlePrompt(kind: 'session_task' | 'scheduled_session' | 'task' | 'goal' | 'habit'): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        if (kind === 'scheduled_session') {
            if (snapshot.today.plannedFocus.nextTitle) return `What topic should I schedule? Existing planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'What small focus block should I schedule for this low-capacity window?';
            if (snapshot.moment.mode === 'deadline_pressure') return 'What deadline-relief topic should I schedule?';
        }
        if (kind === 'session_task') {
            if (snapshot.today.plannedFocus.nextTitle) return `What should this session task be called? Planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'What small session task should I create for today?';
            if (snapshot.moment.mode === 'deadline_pressure') return 'What deadline-relief session task should I create?';
        }
        if (kind === 'task') {
            if (snapshot.userState.standupGoal) return `What should the task be called? Today's stated goal is <b>${snapshot.userState.standupGoal}</b>.`;
            if (snapshot.moment.mode === 'planning') return 'What tomorrow-facing task should I create?';
        }
        if (kind === 'goal') {
            if (snapshot.userState.standupGoal) return `What should the goal be called? Today's stated goal is <b>${snapshot.userState.standupGoal}</b>.`;
            if (snapshot.moment.mode === 'deadline_pressure') return 'What deadline or deliverable should this goal protect?';
        }
        if (kind === 'habit') {
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'What low-friction habit should I create?';
            if (snapshot.moment.mode === 'planning') return 'What habit would make tomorrow easier to start?';
        }
    } catch { /* keep fallback */ }
    if (kind === 'scheduled_session') return 'What topic should I schedule?';
    if (kind === 'session_task') return 'What should the session task be called?';
    if (kind === 'goal') return 'What should the goal be called?';
    if (kind === 'habit') return 'What should the habit be called?';
    return 'What should the task be called?';
}

function formatTelegramActionRepair(kind: 'goal_type' | 'goal_no_changes' | 'task_no_changes' | 'habit_rename_missing' | 'adjust_missing' | 'standup_failed', title?: string): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        if (kind === 'goal_type') {
            if (snapshot.moment.mode === 'deadline_pressure') return `What type of goal is "${title}"? If this protects a deadline, use build_feature or learn_skill with the deliverable name.`;
            if (snapshot.moment.mode === 'planning') return `What type of goal is "${title}"? Pick the type tomorrow should optimize around: build_feature / learn_skill / launch_project / general.`;
            return `What type of goal is "${title}"? (build_feature / learn_skill / launch_project / general)`;
        }
        if (kind === 'goal_no_changes') {
            if (snapshot.userState.standupGoal) return `No goal changes provided for <b>${title}</b>. Today's stated goal is <b>${snapshot.userState.standupGoal}</b>; send deadline or active status if that changed.`;
            if (snapshot.moment.mode === 'planning') return `No goal changes provided for <b>${title}</b>. Add a deadline or active/inactive state if tomorrow's plan should change.`;
            return `No changes provided for goal: <b>${title}</b>.`;
        }
        if (kind === 'task_no_changes') {
            if (snapshot.today.plannedFocus.nextTitle) return `Nothing to update. For <b>${snapshot.today.plannedFocus.nextTitle}</b>, send title, status, priority, or linked focus-time progress.`;
            if (snapshot.moment.mode === 'deadline_pressure') return 'Nothing to update. Send the deadline task status or priority so I can protect the pressure path.';
            return 'Nothing to update. Specify title, status, or priority.';
        }
        if (kind === 'habit_rename_missing') {
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'Send current habit name and new name. Keep the habit wording small enough for low-capacity days.';
            if (snapshot.moment.mode === 'planning') return 'Send current habit name and new name, especially if it should support tomorrow.';
            return 'Provide both the current habit name and the new name.';
        }
        if (kind === 'adjust_missing') {
            if (snapshot.today.plannedFocus.nextTitle) return `Could not find that session to adjust. Current planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; start or reschedule that block instead.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'Could not find that session to adjust. Start a smaller recovery-safe block instead.';
            return 'Could not find the session to adjust.';
        }
        if (kind === 'standup_failed') {
            if (snapshot.moment.mode === 'planning') return 'Could not fetch standup data. Send tomorrow intention, sleep/wake, and fixed calendar constraints directly.';
            if (snapshot.today.plannedFocus.nextTitle) return `Could not fetch standup data. Use current planned focus: <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            return 'Could not fetch standup data.';
        }
    } catch { /* keep fallback */ }
    if (kind === 'goal_type') return `What type of goal is "${title}"? (build_feature / learn_skill / launch_project / general)`;
    if (kind === 'goal_no_changes') return `No changes provided for goal: <b>${title}</b>.`;
    if (kind === 'task_no_changes') return 'Nothing to update. Specify title, status, or priority.';
    if (kind === 'habit_rename_missing') return 'Provide both the current habit name and the new name.';
    if (kind === 'adjust_missing') return 'Could not find the session to adjust.';
    return 'Could not fetch standup data.';
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
6. **Missing Required Fields:** If a required field (like goal type) is missing from the user's prompt, do NOT guess. Use CHAT to ask them for it.

AVAILABLE ACTIONS:
- "START_SESSION": Start a focus session RIGHT NOW (requires explicit trigger). Payload: targetTitle, durationMinutes (omit durationMinutes unless the user explicitly gave one), mood (high/medium/low).
- "CREATE_SESSION_TASK": Create a task indicating a planned session. Used when user says "I want to do a 50 min session on X". Payload: title (topic), durationMinutes, due_date (YYYY-MM-DD).
- "SCHEDULE_SESSION": Schedule a session for a FUTURE time (adds to calendar). Payload: targetTitle, durationMinutes, intendedStartAt (unix ms).
- "RESCHEDULE_SESSION": Move an existing pending session to a new time. Payload: searchTitle, durationMinutes (optional), intendedStartAt (unix ms).
- "CANCEL_SCHEDULED_SESSION": Cancel/dismiss a pending scheduled session. Payload: searchTitle.
- "ADJUST_SESSION": Change duration of the CURRENT active session. Payload: durationMinutes (new total).
- "END_SESSION": End the current session.
- "STORE_INTENTION": Store a planned intention without starting anything. Payload: intention (string), when ("today"|"tomorrow"|"this_week").
- "LOG_EVENING": Log evening check-in — sleep time, wake estimate, mood, energy, day events, tomorrow's intention. Payload: sleepTime ("HH:MM" 24h or null), wakeEstimate ("HH:MM" 24h or null, derive as sleepTime+8h if not stated), mood ("high"|"medium"|"low"|null), energy ("high"|"medium"|"low"|null), tomorrowIntention (string or null), recap (what happened today that affected focus/mood/body/schedule).
- "CORRECTION_NOTED": User corrected a prior bot inference. Payload: wasWrong (what was incorrectly inferred), actualMeaning (what user actually meant).
- "LOG_HABIT": Log a habit. Payload: habitTitle.
- "LOG_STANDUP": Set today's goal + mood. Payload: goal (string), mood (high/medium/low).
- "SUBMIT_FEEDBACK": Post-session reflection/feedback. Payload: feedback (string), sessionId (if inferable).
- "SHOW_TASKS": Show ranked tasks for today.
- "SHOW_HABITS": Show today's habit status.
- "NEXT_DAY_PLAN": Show tomorrow's adaptive plan and planned focus sessions. Prefer this for "plan".
- "WEEKLY_PLAN": Show this week's retrospective plan only if the user explicitly asks for the week.
- "GOAL_STATUS": Show goal health status.
- "SESSION_REVIEW": Show pending session completions.
- "CALIBRATION": Show model calibration accuracy.
- "STANDUP": Show standup brief (energy + suggestions).
- "STATUS": Current session status.
- "MENU": Show the full action menu.
- "CREATE_TASK": Create a new task. Payload: title (required), task_type (task/assignment/exam), status (todo/doing, default todo), priority (low/medium/high/critical only if the user explicitly states it), due_date (YYYY-MM-DD or null), due_time (HH:MM 24h or null), course (string or null). Omit priority when unstated so LifeOS can choose from today's context.
- "UPDATE_TASK": Update an existing task. Payload: searchTitle, title, status, priority, due_date, due_time, course, task_type.
- "DELETE_TASK": Delete a task by title. Payload: searchTitle.
- "CREATE_GOAL": Create a new goal. Payload: title (required), type (required: build_feature/learn_skill/launch_project/general), category (productivity/health/learning/finance/relationships/other), deadline (YYYY-MM-DD or null).
- "UPDATE_GOAL": Update a goal's deadline or status. Payload: searchTitle, deadline (YYYY-MM-DD or null), active (0 or 1).
- "DELETE_GOAL": Delete a goal. Payload: searchTitle.
- "CREATE_HABIT": Create a new habit. Payload: name (required), icon (emoji, optional), goal_metric (boolean/time, optional), goal_target (minutes if time, optional). Omit metric/target unless the user explicitly gives them; LifeOS will choose adaptive defaults for the current day.
- "UPDATE_HABIT": Rename a habit. Payload: searchName, newName.
- "DELETE_HABIT": Delete/archive a habit. Payload: searchName.
- "MULTI_ACTION": Execute multiple actions in sequence (e.g. archiving X, prioritizing Y, scheduling Z). Payload: actions (array of action objects).
- "CHAT": Conversational reply (no action).

Respond ONLY with valid JSON:
{
  "action": "<ACTION>",
  "replyText": "<HTML reply to user, very brief, Telegram HTML allowed (<b>, <i>). For MULTI_ACTION, put the final combined reply here.>",
  "payload": {
    "targetTitle": "string",
    "durationMinutes": 0,
    "intendedStartAt": 1234567890,
    "mood": "high|medium|low",
    "habitTitle": "string",
    "goal": "string",
    "feedback": "string",
    "title": "string",
    "status": "todo|doing|done",
    "priority": "string",
    "task_type": "task|assignment|exam|session",
    "due_date": "YYYY-MM-DD or null",
    "due_time": "HH:MM or null",
    "course": "string or null",
    "searchTitle": "string",
    "searchName": "string",
    "newName": "string",
    "category": "string",
    "type": "build_feature|learn_skill|launch_project|general",
    "deadline": "string",
    "name": "string",
    "icon": "string",
    "goal_metric": "boolean|time",
    "goal_target": 0,
    "active": 1,
    "actions": [{"action": "string", "replyText": "string", "payload": {}}]
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
                band: classifyEnergy(energy.composite_score),
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

            const result = await processSessionFeedback(awaitingFeedbackSession, text, {
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
        await executeAction('NEXT_DAY_PLAN', '', {});
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
        const avgFocus = Number(sessRow.avg_focus ?? 0);
        const emoji = focusStatusIcon(avgFocus);
        await sendTelegram(
            `📊 <b>Daily Report — ${today}</b>\n\n${emoji} <b>Avg Focus:</b> ${Math.round(avgFocus)}/100\n🛡️ <b>Sessions:</b> ${sessRow.count} (${sessRow.total_minutes}m total)\n📋 <b>Tasks:</b> ${tasksRow.done}/${tasksRow.total} done\n💪 <b>Habits:</b> ${habitsRow.done}/${habitsRow.total} checked`,
            'HTML', FULL_MENU_KEYBOARD
        );
        return;
    }
    if (cmdLower === '/status') {
        const session = getActiveGuardianSession();
        const focusScore = session?.focusScoreHistory?.at(-1) ?? null;
        const personalization = buildPersonalizationSnapshot({
            surface: 'voice',
            maxInsights: 2,
            includeThresholds: false,
            includeMemoryFacts: 4,
            activeSession: session ? {
                sessionId: session.sessionId,
                targetTitle: session.targetTitle,
                focusScore,
                elapsedMinutes: Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)),
            } : null,
        });
        const lines: string[] = [];

        if (session) {
            const elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000));
            const remaining = Math.max(0, session.durationMinutes - elapsed);
            const liveFocusScore = focusScore ?? 100;
            const stateIcon = session.state === 'BREAK' ? '⏸' : focusStatusIcon(liveFocusScore);
            lines.push(`${stateIcon} <b>Active:</b> ${session.targetTitle}`);
            lines.push(`⏱ <b>Time:</b> ${elapsed}m elapsed · ${remaining}m remaining`);
            lines.push(`🎯 <b>Focus:</b> ${liveFocusScore}/100  |  <b>State:</b> ${session.state}`);
        } else {
            lines.push(formatNoActiveTelegramSession(personalization, 'status'));
            lines.push(`🧭 <b>${formatCommandMomentLine(personalization)}</b>`);
            lines.push(`⏱ <b>Suggested session:</b> ${getAdaptiveSessionMinutes()}m`);
            if (personalization.userState.nextBestFocusWindow) {
                lines.push(`⚡ <b>Best window:</b> ${personalization.userState.nextBestFocusWindow}`);
            }
        }

        lines.push('');
        lines.push(`📈 <b>Trend:</b> ${personalization.userState.focusTrend || 'stable'}  ·  <b>Style:</b> ${personalization.userState.coachingStyle || 'balanced'}`);

        const insights = personalization.intelligenceContext.match(/💡 Coaching insights:\n([\s\S]*)/)?.[1]?.split('\n').slice(0, 3) ?? [];
        if (insights.length) {
            lines.push('');
            lines.push(`<b>Insights:</b>`);
            insights.forEach((ins: string) => lines.push(ins.replace(/^\s*\d+\.\s*/, '• ')));
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
        await executeAction('CREATE_TASK', '', { title, status: 'todo' });
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
        await executeAction('START_SESSION', '', { targetTitle: topic });
        return;
    }
    // Allow user to literally type "session:60" or "/session:60"
    if (cmdLower.startsWith('session:') || cmdLower.startsWith('/session:')) {
        const parts = cmd.split(':');
        const duration = getAdaptiveSessionMinutes(parseInt(parts[1]?.trim(), 10));
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
            `<b>View</b>\n/tasks — Today's ranked tasks\n/habits — Habit check-ins\n/goals — Goal health status\n/plan — Tomorrow plan\n/standup — Standup brief\n/review — Pending reviews\n/report — Daily report\n/calibration — Model accuracy\n\n` +
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

    const activeSession = getActiveGuardianSession();
    const activeFocusScore = activeSession?.focusScoreHistory?.slice(-1)[0] ?? null;

    // Build the same rich context block the voice parser uses
    // Signal new data so UIL profile is fresh for this message (prevents stale context)
    touchIntelligence('telegram_message');
    const personalization = buildPersonalizationSnapshot({
        surface: 'voice',
        maxInsights: 2,
        includeThresholds: false,
        includeMemoryFacts: 4,
        activeSession: activeSession ? {
            sessionId: activeSession.sessionId,
            targetTitle: activeSession.targetTitle,
            focusScore: activeFocusScore,
            elapsedMinutes: Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60_000)),
        } : null,
    });
    const personalizationContext = formatPersonalizationContext(personalization);
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

    const nowMs = Date.now();
    const localTimeStr = new Date(nowMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const contextBlock = `--- CURRENT STATE ---\nCURRENT TIME: ${localTimeStr} (Unix ms: ${nowMs})\nTIMEZONE: Asia/Kolkata (IST, UTC+5:30)\n${sessionBlock}\n\n${personalizationContext}\n---------------------`;

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
            model: MODEL_PRO,
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
                extractMemoryFromVoice(turns, 'telegram').catch(() => { });
            } catch { /* non-fatal */ }
        }

        // Gate START_SESSION through confirmation unless already confirmed
        if (parsed.action === 'START_SESSION' && !getActiveGuardianSession()) {
            const title = (parsed.payload?.targetTitle as string | undefined) || 'General Focus';
            setPendingConfirmation(SINGLE_USER_KEY, 'START_SESSION', parsed.payload ?? {}, parsed.replyText);
            await sendTelegram(
                `Starting a <b>${getAdaptiveSessionMinutesLabel(parsed.payload?.durationMinutes)} session</b> on "<b>${title}</b>". Go? (yes / no)`,
                'HTML', FULL_MENU_KEYBOARD
            );
        } else {
            await executeAction(parsed.action, parsed.replyText, parsed.payload ?? {}, activeSession);
        }

    } catch (err) {
        console.error('[TelegramAgent] Error:', err);
        await sendTelegram(formatTelegramFailureFallback(), 'HTML', FULL_MENU_KEYBOARD);
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

        case 'MULTI_ACTION': {
            const actions = payload.actions as Array<{ action: string; replyText: string; payload: Record<string, unknown> }>;
            if (Array.isArray(actions)) {
                for (const sub of actions) {
                    await executeAction(sub.action, '', sub.payload, activeSession);
                }
            }
            if (replyText) {
                await sendTelegram(replyText, 'HTML', session ? SESSION_START_KEYBOARD : FULL_MENU_KEYBOARD);
            }
            break;
        }

        case 'CREATE_SESSION_TASK': {
            const title = (payload.title as string | undefined)?.trim();
            if (!title) { await sendTelegram(formatTelegramTitlePrompt('session_task'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const personalization = buildPersonalizationSnapshot({ surface: 'telegram', maxInsights: 2, includeMemoryFacts: 4 });
            const defaults = buildAdaptiveTaskDefaults({
                title,
                taskType: 'session',
                course: (payload.course as string | undefined) || null,
                dueDate: (payload.due_date as string | undefined) || null,
                explicitEstimateMinutes: payload.durationMinutes,
                snapshot: personalization,
            });
            const duration = defaults.estimatedMinutes;
            const result = db.prepare(
                `INSERT INTO tasks (title, status, priority, task_type, estimated_minutes, energy_required, due_date) VALUES (?, 'todo', ?, 'session', ?, ?, ?)`
            ).run(
                title,
                defaults.priority,
                duration,
                defaults.energyRequired,
                (payload.due_date as string | undefined) || null
            );
            const taskId = Number(result.lastInsertRowid);
            try { const { autoLinkTaskToGoal } = require('./task-auto-linker') as typeof import('./task-auto-linker'); autoLinkTaskToGoal(taskId).catch(console.error); } catch { /* non-fatal */ }
            if (replyText) await sendTelegram(`✅ Session Task added: <b>${title}</b> (${duration}m, ${defaults.priority}, ${defaults.energyRequired} energy)\n${defaults.reason}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'SCHEDULE_SESSION': {
            const title = (payload.targetTitle as string | undefined)?.trim();
            if (!title) { await sendTelegram(formatTelegramTitlePrompt('scheduled_session'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const intendedStartAt = Number(payload.intendedStartAt) || Date.now() + 60 * 60_000;
            const plannedMinutes = getAdaptiveSessionMinutes(payload.durationMinutes);
            const schedulerSnapshot = buildPersonalizationSnapshot({
                surface: 'scheduler',
                maxInsights: 2,
                includeMemoryFacts: 3,
            });

            const { createSoftWatchCommitment } = require('./guardian-runtime') as typeof import('./guardian-runtime');
            const commitment = createSoftWatchCommitment({
                targetTitle: title,
                intendedStartAt,
                plannedMinutes,
                source: 'telegram',
            });

            const startTime = new Date(intendedStartAt);
            const endTime = new Date(intendedStartAt + plannedMinutes * 60_000);
            const startStr = startTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const endStr = endTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

            let conflictMsg = '';
            try {
                const { createCalendarEvent, getConflictingEvents, isCalendarConfigured } = require('./google-calendar') as typeof import('./google-calendar');
                if (isCalendarConfigured()) {
                    const conflicts = await getConflictingEvents(startTime, endTime);
                    if (conflicts.length > 0) {
                        conflictMsg = `\n⚠️ <b>Conflict:</b> You have ${conflicts.length} overlapping event(s). It was not added to calendar.`;
                    } else {
                        const eventId = await createCalendarEvent({
                            summary: `📚 ${commitment.targetTitle}`,
                            description: `LifeOS Guardian session\\nScheduled via Telegram.`,
                            startTime,
                            endTime,
                            colorId: '9',
                            reminderSnapshot: schedulerSnapshot,
                        });
                        if (eventId) {
                            const { attachCalendarEventId } = require('./guardian-runtime') as typeof import('./guardian-runtime');
                            attachCalendarEventId(commitment.id, eventId);
                        }
                        conflictMsg = `\n🗓️ Added to Calendar!`;
                    }
                }
            } catch { /* ignore calendar errors */ }

            if (replyText) {
                await sendTelegram(
                    `📅 <b>Scheduled: ${title}</b>\n🕐 ${startStr} – ${endStr} (${plannedMinutes}m)${formatScheduleFitLine(schedulerSnapshot, plannedMinutes)}${conflictMsg}`,
                    'HTML', FULL_MENU_KEYBOARD
                );
            }
            break;
        }

        case 'RESCHEDULE_SESSION': {
            const search = (payload.searchTitle as string | undefined)?.trim()?.toLowerCase();
            const startAt = payload.intendedStartAt as number | undefined;
            if (!search || !startAt) {
                await sendTelegram(formatScheduleClarification(!search && !startAt ? 'both' : !search ? 'title' : 'time'), 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            
            const { listSoftWatchCommitments, rescheduleSoftWatchCommitment } = require('./guardian-runtime') as typeof import('./guardian-runtime');
            const comms = listSoftWatchCommitments();
            const match = comms.find(c => c.targetTitle.toLowerCase().includes(search));
            if (!match) {
                await sendTelegram(formatTelegramLookupMiss('session', search), 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            rescheduleSoftWatchCommitment(match.id, startAt, payload.durationMinutes as number | undefined);
            if (replyText) {
                const dates = new Date(startAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                await sendTelegram(`✅ Rescheduled <b>${match.targetTitle}</b> to ${dates}.`, 'HTML', FULL_MENU_KEYBOARD);
            }
            break;
        }

        case 'CANCEL_SCHEDULED_SESSION': {
            const search = (payload.searchTitle as string | undefined)?.trim()?.toLowerCase();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('session', 'cancel'), 'HTML', FULL_MENU_KEYBOARD); break; }
            
            const { listSoftWatchCommitments, dismissSoftWatchCommitment } = require('./guardian-runtime') as typeof import('./guardian-runtime');
            const comms = listSoftWatchCommitments();
            const match = comms.find(c => c.targetTitle.toLowerCase().includes(search));
            if (!match) {
                await sendTelegram(formatTelegramLookupMiss('session', search), 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            dismissSoftWatchCommitment(match.id);
            if (replyText) {
                await sendTelegram(`🗑️ Cancelled scheduled session: <b>${match.targetTitle}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            }
            break;
        }

        case 'UPDATE_GOAL': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('goal', 'update'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const goal = db.prepare(`SELECT id, title, deadline, active FROM goals WHERE LOWER(title) LIKE ? AND archived = 0 LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string; deadline: string | null; active: number } | undefined;
            if (!goal) { await sendTelegram(formatTelegramLookupMiss('goal', search), 'HTML', FULL_MENU_KEYBOARD); break; }

            const sets: string[] = [];
            const vals: (string | number)[] = [];

            if (payload.deadline !== undefined) {
                sets.push('deadline = ?');
                vals.push(payload.deadline as string | null ?? '');
            }
            if (payload.active !== undefined) {
                sets.push('active = ?');
                vals.push(Number(payload.active) ? 1 : 0);
            }

            if (sets.length > 0) {
                vals.push(goal.id);
                db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
                if (replyText) await sendTelegram(`✅ Updated goal: <b>${goal.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            } else {
                if (replyText) await sendTelegram(formatTelegramActionRepair('goal_no_changes', goal.title), 'HTML', FULL_MENU_KEYBOARD);
            }
            break;
        } case 'START_SESSION': {
            if (session) {
                await sendTelegram(
                    formatActiveSessionConflict(session),
                    'HTML', SESSION_START_KEYBOARD
                );
                break;
            }
            const title = (payload.targetTitle as string | undefined) || 'General Focus';
            const duration = getAdaptiveSessionMinutes(payload.durationMinutes);
            const moodRaw = payload.mood as string | undefined;
            const mood = (moodRaw === 'high' || moodRaw === 'medium' || moodRaw === 'low') ? moodRaw : undefined;
            startGuardianSession({ topic: title, durationMinutes: duration, mood, source: 'api' });
            await sendTelegram(`🛡️ ${replyText || `Session started: <b>${title}</b> for ${duration}m`}`, 'HTML', SESSION_START_KEYBOARD);
            break;
        }

        case 'ADJUST_SESSION': {
            if (!session) {
                const snapshot = buildPersonalizationSnapshot({ surface: 'telegram', maxInsights: 2, includeMemoryFacts: 4 });
                await sendTelegram(formatNoActiveTelegramSession(snapshot, 'adjust'), 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            const newDuration = Number(payload.durationMinutes);
            if (!newDuration || newDuration < 1) {
                const focusScore = session.focusScoreHistory.at(-1) ?? null;
                const snapshot = buildPersonalizationSnapshot({
                    surface: 'telegram',
                    maxInsights: 2,
                    includeMemoryFacts: 4,
                    activeSession: {
                        sessionId: session.sessionId,
                        targetTitle: session.targetTitle,
                        focusScore,
                        elapsedMinutes: Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)),
                    },
                });
                await sendTelegram(formatAdjustDurationPrompt(snapshot), 'HTML', SESSION_START_KEYBOARD);
                break;
            }
            const { adjustGuardianSessionDuration } = require('./guardian-runtime') as typeof import('./guardian-runtime');
            const adjusted = adjustGuardianSessionDuration(session.sessionId, newDuration);
            if (!adjusted) {
                await sendTelegram(formatTelegramActionRepair('adjust_missing'), 'HTML', FULL_MENU_KEYBOARD);
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
                const snapshot = buildPersonalizationSnapshot({ surface: 'telegram', maxInsights: 2, includeMemoryFacts: 4 });
                await sendTelegram(formatNoActiveTelegramSession(snapshot, 'end'), 'HTML', FULL_MENU_KEYBOARD);
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
            if (!title) { await sendTelegram(formatTelegramLookupPrompt('habit', 'log'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
            try {
                const habit = db.prepare(`SELECT id FROM habits WHERE archived = 0 AND LOWER(name) LIKE ? LIMIT 1`).get(`%${title.toLowerCase()}%`) as { id: number } | undefined;
                if (!habit) { await sendTelegram(formatTelegramLookupMiss('habit', title), 'HTML', FULL_MENU_KEYBOARD); break; }
                const checkin = recordAdaptiveHabitCheckin({
                    habitId: habit.id,
                    date: today,
                    source: 'telegram',
                    forceComplete: true,
                });
                await sendTelegram(`✅ ${replyText || `Logged: ${title}`}\n${checkin.value}/${checkin.adaptiveTarget} · ${checkin.adaptiveReason ?? 'adaptive habit target'}`, 'HTML', FULL_MENU_KEYBOARD);
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
                const result = await processSessionFeedback(sessionId, feedbackText, {
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

        case 'NEXT_DAY_PLAN': {
            const { getNextDayPlan } = require('./next-day-planner') as typeof import('./next-day-planner');
            let plan = getNextDayPlan(nextIsoDate());
            if (!plan.plan || plan.sessions.length === 0) {
                plan = await generateNextDayPlan({
                    planDate: nextIsoDate(),
                    syncCalendar: false,
                    regenerate: true,
                });
            }
            await sendTelegram(formatNextDayPlanSummary(plan), 'HTML', FULL_MENU_KEYBOARD);
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
            if (!data) { await sendTelegram(formatTelegramActionRepair('standup_failed'), 'HTML', FULL_MENU_KEYBOARD); break; }
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
            const focusScore = session?.focusScoreHistory?.at(-1) ?? null;
            const personalization = buildPersonalizationSnapshot({
                surface: 'telegram',
                maxInsights: 2,
                includeMemoryFacts: 4,
                activeSession: session ? {
                    sessionId: session.sessionId,
                    targetTitle: session.targetTitle,
                    focusScore,
                    elapsedMinutes: Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)),
                } : null,
            });
            const lines: string[] = [];

            if (session) {
                const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
                const remaining = Math.max(0, session.durationMinutes - elapsed);
                const liveFocusScore = focusScore ?? 100;
                lines.push(`${focusStatusIcon(liveFocusScore)} <b>Session active</b>`);
                lines.push(`📚 ${session.targetTitle}`);
                lines.push(`⏱️ ${elapsed}m elapsed · ${remaining}m left`);
                lines.push(`🎯 Focus ${liveFocusScore}/100 · ${session.blockedCount} block${session.blockedCount === 1 ? '' : 's'}`);
                lines.push(`<i>${formatCommandMomentLine(personalization)}</i>`);
            } else {
                const standup = fetchStandupData();
                const energyLine = standup?.energy ? `\n${standup.energy.band === 'high' ? '🟢' : standup.energy.band === 'medium' ? '🟡' : '🔴'} Energy: ${standup.energy.band} (${Math.round(standup.energy.composite)}/100)` : '';
                lines.push(`${formatNoActiveTelegramSession(personalization, 'status')}${energyLine}`);
                lines.push(`🧭 <b>${formatCommandMomentLine(personalization)}</b>`);
                lines.push(`⏱️ Suggested session: <b>${getAdaptiveSessionMinutes()}m</b>`);
                if (personalization.userState.nextBestFocusWindow) {
                    lines.push(`⚡ Best window: <b>${personalization.userState.nextBestFocusWindow}</b>`);
                }
            }
            lines.push(`📈 Trend: ${personalization.userState.focusTrend} · Style: ${personalization.userState.coachingStyle}`);
            await sendTelegram(lines.join('\n'), 'HTML', session ? SESSION_START_KEYBOARD : FULL_MENU_KEYBOARD);
            break;
        }

        case 'CREATE_TASK': {
            const title = (payload.title as string | undefined)?.trim();
            if (!title) { await sendTelegram(formatTelegramTitlePrompt('task'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const safeStatus = ['todo', 'doing'].includes(payload.status as string) ? (payload.status as string) : 'todo';
            const safeType = ['task', 'assignment', 'exam'].includes(payload.task_type as string) ? (payload.task_type as string) : 'task';
            const personalization = buildPersonalizationSnapshot({ surface: 'telegram', maxInsights: 2, includeMemoryFacts: 4 });
            const defaults = buildAdaptiveTaskDefaults({
                title,
                taskType: safeType,
                course: (payload.course as string | undefined) || null,
                dueDate: (payload.due_date as string | undefined) || null,
                explicitPriority: payload.priority,
                explicitEstimateMinutes: payload.estimated_minutes ?? payload.durationMinutes,
                explicitEnergyRequired: payload.energy_required,
                snapshot: personalization,
            });
            const result = db.prepare(
                `INSERT INTO tasks (title, status, priority, task_type, due_date, due_time, course, estimated_minutes, energy_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                title,
                safeStatus,
                defaults.priority,
                safeType,
                (payload.due_date as string | undefined) || null,
                (payload.due_time as string | undefined) || null,
                (payload.course as string | undefined) || null,
                defaults.estimatedMinutes,
                defaults.energyRequired,
            );
            const taskId = Number(result.lastInsertRowid);
            // Fire-and-forget: auto-link + prioritize
            try { const { autoLinkTaskToGoal } = require('./task-auto-linker') as typeof import('./task-auto-linker'); autoLinkTaskToGoal(taskId).catch(console.error); } catch { /* non-fatal */ }
            try { const { triggerPrioritize } = require('./task-priority-ranker') as typeof import('./task-priority-ranker'); triggerPrioritize(); } catch { /* non-fatal */ }
            const typeLabel = safeType === 'exam' ? ' (exam)' : safeType === 'assignment' ? ' (assignment)' : '';
            const courseLabel = payload.course ? ` [${payload.course}]` : '';
            const dueLabel = payload.due_date ? ` · due ${payload.due_date}` : '';
            await sendTelegram(`✅ Task created: <b>${title}</b>${typeLabel}${courseLabel}${dueLabel}\n${defaults.priority} · ${defaults.estimatedMinutes}m · ${defaults.energyRequired} energy\n${defaults.reason}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'UPDATE_TASK': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('task', 'update'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const task = db.prepare(`SELECT id, title FROM tasks WHERE LOWER(title) LIKE ? AND status != 'done' LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!task) { await sendTelegram(formatTelegramLookupMiss('task', search), 'HTML', FULL_MENU_KEYBOARD); break; }
            const sets: string[] = [];
            const vals: (string | number)[] = [];
            if (payload.title) { sets.push('title = ?'); vals.push(payload.title as string); }
            if (payload.status) {
                const nextStatus = ['todo', 'doing', 'done'].includes(payload.status as string) ? payload.status as string : null;
                if (nextStatus === 'done') {
                    const progress = getTaskTimeProgress(task.id);
                    if (progress.targetMinutes === null) {
                        await sendTelegram('That task needs a time target before it can complete. Add a target, then complete linked focus sessions against it.', 'HTML', FULL_MENU_KEYBOARD);
                        break;
                    }
                    if (progress.creditedMinutes < progress.targetMinutes) {
                        await sendTelegram(`Task stays active: ${progress.remainingMinutes}m more linked focus time needed (${progress.creditedMinutes}/${progress.targetMinutes}m).`, 'HTML', FULL_MENU_KEYBOARD);
                        break;
                    }
                    sets.push("status = 'done'");
                    sets.push("completed_at = datetime('now')");
                } else if (nextStatus) {
                    sets.push('status = ?');
                    vals.push(nextStatus);
                    if (nextStatus !== 'done') sets.push('completed_at = NULL');
                }
            }
            if (payload.priority) { sets.push('priority = ?'); vals.push(payload.priority as string); }
            if (sets.length === 0) { await sendTelegram(formatTelegramActionRepair('task_no_changes'), 'HTML', FULL_MENU_KEYBOARD); break; }
            vals.push(task.id);
            db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
            await sendTelegram(`✅ Updated task: <b>${(payload.title as string) || task.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_TASK': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('task', 'delete'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const task = db.prepare(`SELECT id, title FROM tasks WHERE LOWER(title) LIKE ? LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!task) { await sendTelegram(formatTelegramLookupMiss('task', search), 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`DELETE FROM tasks WHERE id = ?`).run(task.id);
            await sendTelegram(`🗑️ Deleted task: <b>${task.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'CREATE_GOAL': {
            const title = (payload.title as string | undefined)?.trim();
            if (!title) { await sendTelegram(formatTelegramTitlePrompt('goal'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const type = (payload.type as string | undefined)?.trim();
            if (!type || !['build_feature', 'learn_skill', 'launch_project', 'general'].includes(type)) {
                await sendTelegram(formatTelegramActionRepair('goal_type', title), 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            const db = getDb();
            db.prepare(`INSERT INTO goals (title, type, category, deadline) VALUES (?, ?, ?, ?)`).run(
                title,
                type,
                (payload.category as string | undefined) || 'productivity',
                (payload.deadline as string | undefined) || null
            );
            await sendTelegram(`✅ Goal created: <b>${title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_GOAL': {
            const search = (payload.searchTitle as string | undefined)?.trim();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('goal', 'delete'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const goal = db.prepare(`SELECT id, title FROM goals WHERE LOWER(title) LIKE ? LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; title: string } | undefined;
            if (!goal) { await sendTelegram(formatTelegramLookupMiss('goal', search), 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`DELETE FROM goals WHERE id = ?`).run(goal.id);
            await sendTelegram(`🗑️ Deleted goal: <b>${goal.title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'CREATE_HABIT': {
            const name = (payload.name as string | undefined)?.trim();
            if (!name) { await sendTelegram(formatTelegramTitlePrompt('habit'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const habitPersonalization = buildPersonalizationSnapshot({
                surface: 'habits',
                maxInsights: 2,
                includeMemoryFacts: 4,
            });
            const habitDefaults = buildAdaptiveNewHabitDefaults(habitPersonalization);
            const goalMetric = payload.goal_metric === 'time' || payload.goal_metric === 'boolean'
                ? payload.goal_metric
                : habitDefaults.goalMetric;
            const hasExplicitTarget = payload.goal_target !== undefined && payload.goal_target !== null && payload.goal_target !== '';
            const parsedTarget = Number(payload.goal_target);
            const goalTarget = goalMetric === 'time'
                ? Math.max(1, Math.round(hasExplicitTarget && Number.isFinite(parsedTarget) ? parsedTarget : habitDefaults.timeTargetMinutes))
                : 1;
            const db = getDb();
            db.prepare(`INSERT INTO habits (name, icon, frequency, goal_metric, goal_target) VALUES (?, ?, 'daily', ?, ?)`).run(
                name,
                (payload.icon as string | undefined) || '✅',
                goalMetric,
                goalTarget
            );
            const detail = goalMetric === 'time'
                ? `${goalTarget} min ${habitDefaults.intensity} target`
                : `${habitDefaults.intensity} checkbox`;
            await sendTelegram(`✅ Habit created: <b>${name}</b>\n${detail} · ${habitDefaults.reason}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'UPDATE_HABIT': {
            const search = (payload.searchName as string | undefined)?.trim();
            const newName = (payload.newName as string | undefined)?.trim();
            if (!search || !newName) { await sendTelegram(formatTelegramActionRepair('habit_rename_missing'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const habit = db.prepare(`SELECT id, name FROM habits WHERE LOWER(name) LIKE ? AND archived = 0 LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; name: string } | undefined;
            if (!habit) { await sendTelegram(formatTelegramLookupMiss('habit', search), 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`UPDATE habits SET name = ? WHERE id = ?`).run(newName, habit.id);
            await sendTelegram(`✅ Renamed: <b>${habit.name}</b> → <b>${newName}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'DELETE_HABIT': {
            const search = (payload.searchName as string | undefined)?.trim();
            if (!search) { await sendTelegram(formatTelegramLookupPrompt('habit', 'delete'), 'HTML', FULL_MENU_KEYBOARD); break; }
            const db = getDb();
            const habit = db.prepare(`SELECT id, name FROM habits WHERE LOWER(name) LIKE ? AND archived = 0 LIMIT 1`).get(`%${search.toLowerCase()}%`) as { id: number; name: string } | undefined;
            if (!habit) { await sendTelegram(formatTelegramLookupMiss('habit', search), 'HTML', FULL_MENU_KEYBOARD); break; }
            db.prepare(`UPDATE habits SET archived = 1 WHERE id = ?`).run(habit.id);
            await sendTelegram(`🗑️ Archived habit: <b>${habit.name}</b>`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'STORE_INTENTION': {
            const intention = payload.intention as string | undefined;
            const when = (payload.when as string | undefined) || 'today';
            if (intention) {
                try {
                    await generateNextDayPlan({
                        planDate: when === 'today' ? new Date().toISOString().slice(0, 10) : nextIsoDate(),
                        tomorrowIntention: `${intention}${when ? ` (${when})` : ''}`,
                        eveningNotes: `[telegram intent] ${intention}`,
                        syncCalendar: false,
                    });
                    touchIntelligence('intention_stored');
                } catch (err) {
                    console.error('[TelegramAgent] failed to store intention through planner:', err);
                }
            }
            await sendTelegram(replyText || `Stored: ${payload.intention || 'intention'}`, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'LOG_EVENING': {
            const sleepTime = normalizeTelegramTime(payload.sleepTime);
            const wakeEstimate = normalizeTelegramTime(payload.wakeEstimate);
            const mood = normalizeTelegramSignalLevel(payload.mood);
            const energy = normalizeTelegramSignalLevel(payload.energy);
            const tomorrowIntention = payload.tomorrowIntention as string | null ?? null;
            const recap = payload.recap as string | undefined;
            try {
                await generateNextDayPlan({
                    sleepTime,
                    wakeEstimate,
                    mood,
                    energy,
                    tomorrowIntention,
                    eveningNotes: recap ?? null,
                    syncCalendar: false,
                });
                touchIntelligence('evening_checkin');
            } catch (err) {
                console.error('[TelegramAgent] failed to log evening through planner:', err);
            }
            const details = [
                wakeEstimate ? `wake ${wakeEstimate}` : null,
                mood ? `${mood} mood` : null,
                energy ? `${energy} energy` : null,
            ].filter(Boolean).join(' · ');
            await sendTelegram(replyText || `Evening logged${details ? `: ${details}` : ''}.`, 'HTML', FULL_MENU_KEYBOARD);
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
