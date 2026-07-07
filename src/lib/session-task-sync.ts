/**
 * session-task-sync.ts
 * Handles automatic task status transitions tied to Guardian sessions.
 * Tasks are time targets: linked focus sessions accumulate minutes, and the
 * task completes when credited minutes reach its estimated_minutes target.
 */

import { sendTelegram, FULL_MENU_KEYBOARD } from './telegram';
import { activateTimeTasksForSession, creditSessionTimeToTasks } from './task-time-sessions';

// ─── Session START ────────────────────────────────────────────────────────────

/**
 * Find tasks that match the session topic and move them to 'doing'.
 * Uses keyword overlap so it's fast and synchronous-safe when called at session start.
 * Returns the list of task IDs that were activated.
 */
export function activateTasksForSession(topic: string, goalId?: string | null): number[] {
  return activateTimeTasksForSession(topic, goalId);
}

// ─── Session END ──────────────────────────────────────────────────────────────

/**
 * After a session ends, credit the session's elapsed minutes to matching time-target tasks.
 * No completion guesswork: a task is done only when accumulated linked minutes reach its target.
 */
export async function evaluateSessionTaskCompletion(
  sessionId: string,
  topic: string,
  elapsedMinutes: number,
  avgFocusScore: number,
): Promise<void> {
  const credits = creditSessionTimeToTasks({ sessionId, topic, elapsedMinutes, avgFocusScore });
  if (credits.length === 0) return;

  // Send Telegram summary
  const lines: string[] = [];
  const completed = credits.filter(credit => credit.completed);
  const inProgress = credits.filter(credit => !credit.completed);

  if (completed.length > 0) {
    lines.push(`✅ <b>Time target reached (${completed.length}):</b>\n${completed.map(t => `  • ${t.title} — ${t.creditedTotalMinutes}/${t.targetMinutes}m${t.rewardCoins ? `, +${t.rewardCoins} coins` : ''}`).join('\n')}`);
  }
  if (inProgress.length > 0) {
    lines.push(`⏱️ <b>Task time credited:</b>\n${inProgress.map(t => `  • ${t.title} — ${t.creditedTotalMinutes}/${t.targetMinutes}m`).join('\n')}`);
  }
  if (lines.length > 0) {
    await sendTelegram(lines.join('\n\n'), 'HTML', FULL_MENU_KEYBOARD);
  }
}
