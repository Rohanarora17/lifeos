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
import { startGuardianSession, endGuardianSession, getActiveGuardianSession } from './guardian-runtime';
import { getMemoryContext } from './memory';
import { getDb, getSetting, setSetting } from './db';

const TELEGRAM_SYSTEM_PROMPT = `You are Jarvis, the LifeOS AI guardian assistant on Telegram.
You must be concise, parse user intents into structured actions.

AVAILABLE ACTIONS:
- "START_SESSION": Start a focus session. Payload: targetTitle, durationMinutes (default 60), mood (high/medium/low).
- "END_SESSION": End the current session.
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
- "CREATE_TASK": Create a new task. Payload: title (required), status (backlog/next/this_week/today, default backlog), priority (low/medium/high/critical, default medium).
- "UPDATE_TASK": Update an existing task. Payload: searchTitle (text to find it), title (new title), status, priority.
- "DELETE_TASK": Delete a task by title. Payload: searchTitle.
- "CREATE_GOAL": Create a new goal. Payload: title (required), category (productivity/health/learning/finance/relationships/other, default productivity), deadline (YYYY-MM-DD or null).
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
    "status": "string",
    "priority": "string",
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

    return {
      goal: isToday ? goal : null,
      mood: isToday ? mood : null,
      energy: {
        composite: energy.composite_score,
        band: energy.composite_score >= 65 ? 'high' : energy.composite_score >= 35 ? 'medium' : 'low',
      },
      suggestedTasks,
      weakConcepts,
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

  // Simple slash commands
  if (text.trim() === '/start' || text.trim() === '/menu') {
    await sendTelegram(`🛡️ <b>LifeOS Guardian</b>\n\nWhat would you like to do?`, 'HTML', FULL_MENU_KEYBOARD);
    return;
  }
  if (text.trim() === '/status') {
    const active = getActiveGuardianSession();
    if (active) {
      const elapsed = Math.floor((Date.now() - active.startedAt) / 60000);
      await sendTelegram(
        `🛡️ <b>Active Session:</b> ${active.targetTitle}\n⏱️ Elapsed: ${elapsed}min\n🔴 Blocks: ${active.blockedCount}`,
        'HTML', SESSION_START_KEYBOARD
      );
    } else {
      await sendTelegram(`💤 No active session.`, 'HTML', FULL_MENU_KEYBOARD);
    }
    return;
  }

  const ai = getGenAI();
  if (!ai) {
    await sendTelegram('❌ LLM not configured. Use /menu for quick actions.', 'HTML', FULL_MENU_KEYBOARD);
    return;
  }

  const memoryCtx = getMemoryContext(3);
  const activeSession = getActiveGuardianSession();
  const contextBlock = `
--- CURRENT STATE ---
ACTIVE SESSION: ${activeSession ? `YES (${activeSession.targetTitle}, ${Math.floor((Date.now() - activeSession.startedAt) / 60000)}m elapsed)` : 'NO'}
USER MEMORY: ${memoryCtx || 'None'}
---------------------`;

  try {
    const response = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: `${TELEGRAM_SYSTEM_PROMPT}\n${contextBlock}\n\nUSER: "${text}"`,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse((response.text || '{}').trim()) as {
      action: string;
      replyText: string;
      payload?: Record<string, unknown>;
    };

    await executeAction(parsed.action, parsed.replyText, parsed.payload ?? {}, activeSession);

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
        await sendTelegram(`⚠️ Already in session: <b>${session.targetTitle}</b>. End it first.`, 'HTML', SESSION_START_KEYBOARD);
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
        const habit = db.prepare(`SELECT id FROM habits WHERE archived = 0 AND LOWER(title) LIKE ? LIMIT 1`).get(`%${title.toLowerCase()}%`) as { id: number } | undefined;
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
      const result = db.prepare(
        `INSERT INTO tasks (title, status, priority) VALUES (?, ?, ?)`
      ).run(title, (payload.status as string | undefined) || 'backlog', (payload.priority as string | undefined) || 'medium');
      await sendTelegram(`✅ Task created: <b>${title}</b>`, 'HTML', FULL_MENU_KEYBOARD);
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

    case 'MENU':
      await sendTelegram(replyText || `🛡️ <b>Guardian Menu</b>`, 'HTML', FULL_MENU_KEYBOARD);
      break;

    case 'CHAT':
    default:
      await sendTelegram(replyText || 'OK', 'HTML', session ? SESSION_START_KEYBOARD : FULL_MENU_KEYBOARD);
      break;
  }
}
