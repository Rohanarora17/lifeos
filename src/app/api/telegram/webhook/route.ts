import { NextResponse } from 'next/server';
import { getSetting, setSetting, getDb } from '@/lib/db';
import {
    sendTelegram,
    SESSION_START_KEYBOARD,
    FULL_MENU_KEYBOARD,
    buildReviewKeyboard,
    buildTaskChipsKeyboard,
    buildClassifyKeyboard,
    formatHabitStatus,
    formatPendingReviews,
    formatWeeklyPlanSummary,
    formatGoalHealthStatus,
    formatStandupBrief,
    formatCalibrationStatus,
    formatTasksList,
} from '@/lib/telegram';
import { handleTelegramCommand, executeAction } from '@/lib/telegram-agent';
import { startGuardianSession, endGuardianSession, getActiveGuardianSession, applyUserClassificationFeedback } from '@/lib/guardian-runtime';
import { learnMemory } from '@/lib/behavior';
import { getPendingCheckinType, handleMorningCheckinResponse, handleEveningReflectionResponse } from '@/lib/checkin';

// POST: Telegram Webhook Entrypoint
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const authorizedChatId = getSetting('telegram_chat_id');

        if (!authorizedChatId) {
            console.warn('[Telegram Webhook] No configured chat ID.');
            return NextResponse.json({ ok: true });
        }

        // Handle Callback Queries (Button Clicks)
        if (body.callback_query) {
            const { id, data, message } = body.callback_query;
            const chatId = String(message?.chat?.id);
            if (chatId !== authorizedChatId) return NextResponse.json({ ok: true });

            await handleCallbackQuery(id, data);
            return NextResponse.json({ ok: true });
        }

        // Handle standard messages
        if (body.message?.text) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) {
                await sendTelegram('Sorry, I am a private LifeOS assistant.', 'HTML');
                return NextResponse.json({ ok: true });
            }
            // Check if there's a pending check-in response
            const pendingCheckin = getPendingCheckinType();
            if (pendingCheckin === 'morning') {
                await handleMorningCheckinResponse(body.message.text);
                return NextResponse.json({ ok: true });
            }
            if (pendingCheckin === 'evening') {
                await handleEveningReflectionResponse(body.message.text);
                return NextResponse.json({ ok: true });
            }

            await handleTelegramCommand(body.message.text);
            return NextResponse.json({ ok: true });
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('[Telegram Webhook] Error:', error);
        return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 });
    }
}

// ─── Callback Query Router ────────────────────────────────────────────────────

async function handleCallbackQuery(callbackId: string, actionData: string) {
    const colonIdx = actionData.indexOf(':');
    const type = actionData.slice(0, colonIdx);
    const rest = actionData.slice(colonIdx + 1);

    try {
        if (type === 'action') {
            await handleActionCallback(rest);
        } else if (type === 'review') {
            await handleReviewCallback(rest);
        } else if (type === 'task') {
            await handleTaskCallback(rest);
        } else if (type === 'feedback') {
            await handleFeedbackCallback(rest);
        } else if (type === 'session') {
            await handleSessionCallback(rest);
        } else if (type === 'classify') {
            await handleClassifyCallback(rest);
        } else {
            await sendTelegram(`Unknown callback: ${actionData}`, '');
        }
    } finally {
        // Acknowledge the callback so Telegram removes the loading spinner
        const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
        if (tok) {
            fetch(`https://api.telegram.org/bot${tok}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackId }),
            }).catch(console.error);
        }
    }
}

// ─── action: callbacks ────────────────────────────────────────────────────────

async function handleActionCallback(payload: string) {
    const session = getActiveGuardianSession();

    switch (payload) {

        case 'status':
            await executeAction('STATUS', '', {}, session);
            break;

        case 'new_session':
            await sendTelegram(
                `🎯 <b>Start a Session</b>\n\nReply with what to focus on, e.g.:\n<i>"Lock in on React for 60m"</i>`,
                'HTML'
            );
            break;

        case 'end_session':
            if (!session) {
                await sendTelegram('💤 No active session.', 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            endGuardianSession(session.sessionId);
            setSetting('telegram_awaiting_feedback_session', session.sessionId);
            await sendTelegram(
                `🏁 <b>Session ended.</b>\n\n💬 How did it feel? Reply with a short reflection to calibrate your model.\n<i>(or send anything else to skip)</i>`,
                'HTML'
            );
            break;

        case 'tasks': {
            await executeAction('SHOW_TASKS', '', {});
            break;
        }

        case 'habits': {
            await executeAction('SHOW_HABITS', '', {});
            break;
        }

        case 'standup': {
            await executeAction('STANDUP', '', {});
            break;
        }

        case 'weekly_plan': {
            const { loadActiveWeeklyPlan, generateWeeklyPlan, saveWeeklyPlan } = await import('@/lib/weekly-planner');
            let plan = loadActiveWeeklyPlan();
            if (!plan) { plan = generateWeeklyPlan(); saveWeeklyPlan(plan); }
            await sendTelegram(formatWeeklyPlanSummary(plan), 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'goals': {
            await executeAction('GOAL_STATUS', '', {});
            break;
        }

        case 'review': {
            const db = getDb();
            const reviews = db.prepare(`
        SELECT sc.id, sc.session_id, sc.task_id,
               t.title as task_title,
               gss.target_title, gss.elapsed_minutes, gss.average_focus_score, gss.mood
        FROM session_completions sc
        LEFT JOIN tasks t ON t.id = sc.task_id
        LEFT JOIN guardian_session_summaries gss ON gss.session_id = sc.session_id
        WHERE sc.status = 'pending'
        ORDER BY sc.created_at DESC LIMIT 5
      `).all() as Array<{
                id: number; session_id: string; task_id: number | null;
                task_title: string | null; target_title: string | null;
                elapsed_minutes: number | null; average_focus_score: number | null; mood: string | null;
            }>;
            if (reviews.length === 0) {
                await sendTelegram(`📝 <b>Review Queue</b>\n\nAll caught up! 🎉`, 'HTML', FULL_MENU_KEYBOARD);
                break;
            }
            await sendTelegram(formatPendingReviews(reviews), 'HTML', buildReviewKeyboard(reviews[0].id));
            break;
        }

        case 'report': {
            const db = getDb();
            const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

            const sessionsRow = db.prepare(`
        SELECT COUNT(*) as count,
               COALESCE(AVG(average_focus_score), 0) as avg_focus,
               COALESCE(SUM(elapsed_minutes), 0) as total_minutes
        FROM guardian_session_summaries
        WHERE date(completed_at, 'localtime') = ?
      `).get(today) as { count: number; avg_focus: number; total_minutes: number };

            const tasksRow = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks WHERE status IN ('done', 'todo', 'doing')
      `).get() as { total: number; done: number };

            const habitsRow = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN hc.completed = 1 THEN 1 ELSE 0 END) as done
        FROM habits h
        LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
        WHERE h.archived = 0
      `).get(today) as { total: number; done: number };

            const scoreEmoji = sessionsRow.avg_focus >= 85 ? '🔥' : sessionsRow.avg_focus >= 70 ? '✅' : sessionsRow.avg_focus >= 50 ? '🟡' : '🔴';
            const text = [
                `📊 <b>Daily Report — ${today}</b>`,
                ``,
                `${scoreEmoji} <b>Avg Focus:</b> ${Math.round(sessionsRow.avg_focus)}/100`,
                `🛡️ <b>Sessions:</b> ${sessionsRow.count} (${sessionsRow.total_minutes}m total)`,
                `📋 <b>Tasks:</b> ${tasksRow.done}/${tasksRow.total} done`,
                `💪 <b>Habits:</b> ${habitsRow.done}/${habitsRow.total} checked`,
            ].join('\n');

            await sendTelegram(text, 'HTML', FULL_MENU_KEYBOARD);
            break;
        }

        case 'calibration': {
            await executeAction('CALIBRATION', '', {});
            break;
        }

        case 'feedback_prompt': {
            // Ask for feedback on most recent session
            const db = getDb();
            const lastSession = db.prepare(`
        SELECT session_id FROM guardian_session_summaries ORDER BY completed_at DESC LIMIT 1
      `).get() as { session_id: string } | undefined;
            if (lastSession) {
                setSetting('telegram_awaiting_feedback_session', lastSession.session_id);
                await sendTelegram(
                    `💬 <b>Session Feedback</b>\n\nHow did your last session feel?\n<i>Energy accurate? Distractions? Length?</i>`,
                    'HTML'
                );
            } else {
                await sendTelegram('No recent session to give feedback on.', '', FULL_MENU_KEYBOARD);
            }
            break;
        }

        case 'override_info': {
            await sendTelegram(
                `🚫 <b>Override Request</b>\n\nTo request an override, reply:\n<i>"Override [url or site] because [reason]"</i>\n\nOverrides are time-limited and AI-adjudicated.`,
                'HTML'
            );
            break;
        }

        case 'dismiss_alert':
            await sendTelegram('✅ Alert dismissed.', '', FULL_MENU_KEYBOARD);
            break;

        case 'cancel_softwatch':
            await sendTelegram('❌ Soft watch cancelled.', '', FULL_MENU_KEYBOARD);
            break;

        case 'snooze':
            await sendTelegram('⏰ Snoozed 15 minutes.', '', FULL_MENU_KEYBOARD);
            break;

        default:
            await sendTelegram(`Unknown action: ${payload}`, '', FULL_MENU_KEYBOARD);
    }
}

// ─── review: callbacks ────────────────────────────────────────────────────────

async function handleReviewCallback(rest: string) {
    // rest = "done:42", "blocked:42", "skip:42"
    const colonIdx = rest.indexOf(':');
    const subAction = rest.slice(0, colonIdx);
    const id = parseInt(rest.slice(colonIdx + 1), 10);
    if (isNaN(id)) { await sendTelegram('Invalid review ID.', ''); return; }

    const db = getDb();
    const row = db.prepare(`SELECT id, task_id FROM session_completions WHERE id = ?`).get(id) as { id: number; task_id: number | null } | undefined;
    if (!row) { await sendTelegram('Review not found.', '', FULL_MENU_KEYBOARD); return; }

    let msg = '';
    if (subAction === 'done') {
        db.prepare(`UPDATE session_completions SET status = 'done', actioned_at = datetime('now') WHERE id = ?`).run(id);
        if (row.task_id) {
            db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(row.task_id);
        }
        msg = '✅ Marked as done!';
    } else if (subAction === 'blocked') {
        db.prepare(`UPDATE session_completions SET status = 'blocked', actioned_at = datetime('now') WHERE id = ?`).run(id);
        if (row.task_id) {
            db.prepare(`UPDATE tasks SET blocked_since = date('now', 'localtime') WHERE id = ?`).run(row.task_id);
        }
        msg = '🚫 Marked as blocked.';
    } else if (subAction === 'skip') {
        db.prepare(`UPDATE session_completions SET status = 'skipped', actioned_at = datetime('now') WHERE id = ?`).run(id);
        msg = '⏭ Skipped.';
    }

    // Show next pending review if any
    const next = db.prepare(`
    SELECT sc.id, sc.session_id, sc.task_id,
           t.title as task_title,
           gss.target_title, gss.elapsed_minutes, gss.average_focus_score, gss.mood
    FROM session_completions sc
    LEFT JOIN tasks t ON t.id = sc.task_id
    LEFT JOIN guardian_session_summaries gss ON gss.session_id = sc.session_id
    WHERE sc.status = 'pending' AND sc.id != ?
    ORDER BY sc.created_at DESC LIMIT 1
  `).get(id) as { id: number; session_id: string; task_id: number | null; task_title: string | null; target_title: string | null; elapsed_minutes: number | null; average_focus_score: number | null; mood: string | null } | undefined;

    if (next) {
        await sendTelegram(`${msg}\n\n` + formatPendingReviews([next]), 'HTML', buildReviewKeyboard(next.id));
    } else {
        await sendTelegram(`${msg} All reviews complete! 🎉`, 'HTML', FULL_MENU_KEYBOARD);
    }
}

// ─── task: callbacks ──────────────────────────────────────────────────────────

async function handleTaskCallback(rest: string) {
    // rest = "start:42"
    const colonIdx = rest.indexOf(':');
    const subAction = rest.slice(0, colonIdx);
    const id = parseInt(rest.slice(colonIdx + 1), 10);

    if (subAction === 'start' && !isNaN(id)) {
        const session = getActiveGuardianSession();
        if (session) {
            await sendTelegram(`⚠️ Already in session: <b>${session.targetTitle}</b>. End it first.`, 'HTML', SESSION_START_KEYBOARD);
            return;
        }
        const db = getDb();
        const task = db.prepare(`SELECT title, estimated_minutes FROM tasks WHERE id = ?`).get(id) as { title: string; estimated_minutes: number | null } | undefined;
        if (!task) { await sendTelegram('Task not found.', '', FULL_MENU_KEYBOARD); return; }
        const duration = task.estimated_minutes ?? 60;
        startGuardianSession({ topic: task.title, durationMinutes: duration, source: 'api' });
        await sendTelegram(
            `🛡️ <b>Session started!</b>\n📚 ${task.title}\n⏱️ ${duration} min`,
            'HTML', SESSION_START_KEYBOARD
        );
    }
}

async function handleSessionCallback(payload: string) {
    // payload is typically just the duration, e.g. '60' or '25'
    const duration = parseInt(payload, 10);
    if (isNaN(duration)) {
        await sendTelegram('Invalid session duration.', 'HTML');
        return;
    }

    // Create a synthetic command to trigger the intent engine
    const syntheticCommand = `Lock in for ${duration}m`;
    await handleTelegramCommand(syntheticCommand);
}

// ─── feedback: callbacks ──────────────────────────────────────────────────────


async function handleFeedbackCallback(payload: string) {
    if (payload === 'accurate') {
        await sendTelegram('✅ Noted — factored into calibration.', '', FULL_MENU_KEYBOARD);
    } else if (payload === 'add_note') {
        const db = getDb();
        const lastSession = db.prepare(`SELECT session_id FROM guardian_session_summaries ORDER BY completed_at DESC LIMIT 1`).get() as { session_id: string } | undefined;
        if (lastSession) {
            setSetting('telegram_awaiting_feedback_session', lastSession.session_id);
        }
        await sendTelegram('💬 Reply with your reflection for this session.', '');
    }
}

// ─── classify: callbacks ──────────────────────────────────────────────────────

/**
 * Handles classification review from post-session calibration prompts.
 * payload = "ACTID:c" (confirm), "ACTID:f" (flip), or "ACTID:s" (skip).
 *
 * Learning signal design:
 * - Confirm: reinforce domain_categories + any matching behavioral_memory rule.
 * - Flip (session-specific): write behavioral_memory context rule only — do NOT
 *   write a general domain_categories entry, because a session-specific correction
 *   (github.com = distraction during ZK Proofs) must not affect all-time classification.
 * - Flip (no session context): write behavioral_memory + update domain_categories
 *   as a general override.
 * - All flips: call applyUserClassificationFeedback() to update live session cache.
 */
async function handleClassifyCallback(payload: string) {
    const colonIdx = payload.lastIndexOf(':');
    if (colonIdx === -1) { await sendTelegram('Invalid classify callback.', ''); return; }
    const actId = parseInt(payload.slice(0, colonIdx), 10);
    const action = payload.slice(colonIdx + 1); // 'c', 'f', or 's'
    if (isNaN(actId)) { await sendTelegram('Invalid activity ID.', ''); return; }

    const db = getDb();
    const act = db.prepare(`
        SELECT id, domain, category, subcategory, ai_classification, classification_confidence
        FROM activities WHERE id = ?
    `).get(actId) as {
        id: number;
        domain: string;
        category: string;
        subcategory: string;
        ai_classification: string;
        classification_confidence: string;
    } | undefined;

    if (!act) { await sendTelegram('Activity not found.', '', FULL_MENU_KEYBOARD); return; }

    // Parse sessionTarget from the stored ai_classification JSON
    let sessionTarget: string | null = null;
    try {
        const parsed = JSON.parse(act.ai_classification);
        sessionTarget = parsed.sessionTarget ?? null;
    } catch { /* ignore */ }

    // Mark as reviewed regardless of action
    db.prepare(`UPDATE activities SET classification_reviewed = 1 WHERE id = ?`).run(actId);

    let feedbackMsg = '';

    if (action === 'c') {
        // ── CONFIRM ────────────────────────────────────────────────────────────
        // AI was right. Reinforce:
        // 1. domain_categories — bump confidence so it's served from cache sooner.
        //    Use 'user confirmed' reasoning so AI cache writes can't overwrite it.
        // 2. Any matching behavioral_memory rule — call learnMemory() to reinforce
        //    (increments reinforcement_count, grows confidence logarithmically).
        feedbackMsg = `✅ Got it — <b>${act.domain}</b> = ${act.category}. Noted.`;
        try {
            db.prepare(`
                INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                VALUES (?, ?, ?, 0.95, 'user confirmed')
                ON CONFLICT(domain) DO UPDATE SET
                    category = excluded.category,
                    subcategory = excluded.subcategory,
                    confidence = MIN(0.99, confidence + 0.05),
                    ai_reasoning = 'user confirmed',
                    updated_at = datetime('now')
                    WHERE ai_reasoning NOT LIKE 'user correct%'
            `).run(act.domain, act.category, act.subcategory);
        } catch { /* non-fatal */ }

        // Reinforce matching behavioral memory rules via learnMemory (reinforcement counting)
        try {
            const today = new Date().toISOString().slice(0, 10);
            if (sessionTarget) {
                learnMemory('categorization_rule',
                    `${act.domain} during "${sessionTarget}" sessions = ${act.category} (user confirmed ${today})`,
                    'user_feedback', 0.95);
            }
        } catch { /* non-fatal */ }

    } else if (action === 'f') {
        // ── FLIP ───────────────────────────────────────────────────────────────
        const flippedCategory = act.category === 'productive' ? 'distraction'
            : act.category === 'distraction' ? 'productive'
            : act.category;

        db.prepare(`UPDATE activities SET category = ?, classification_reviewed = 1 WHERE id = ?`)
            .run(flippedCategory, actId);

        const today = new Date().toISOString().slice(0, 10);

        if (sessionTarget) {
            // SESSION-SPECIFIC CORRECTION
            // Write context-specific behavioral_memory rule via learnMemory()
            // (gets reinforcement counting if the same correction appears again).
            // Do NOT write a general domain_categories entry — this correction only
            // applies when studying this specific topic.
            learnMemory('categorization_rule',
                `${act.domain} during "${sessionTarget}" sessions = ${flippedCategory} (user corrected ${today})`,
                'user_feedback', 0.95);
        } else {
            // GENERAL CORRECTION (no session context)
            // Write both behavioral_memory and domain_categories.
            learnMemory('categorization_rule',
                `${act.domain} = ${flippedCategory} (user corrected ${today})`,
                'user_feedback', 0.95);
            try {
                db.prepare(`
                    INSERT INTO domain_categories (domain, category, subcategory, confidence, ai_reasoning)
                    VALUES (?, ?, ?, 0.9, 'user corrected')
                    ON CONFLICT(domain) DO UPDATE SET
                        category = excluded.category,
                        subcategory = excluded.subcategory,
                        confidence = 0.9,
                        ai_reasoning = 'user corrected',
                        updated_at = datetime('now')
                `).run(act.domain, flippedCategory, act.subcategory);
            } catch { /* non-fatal */ }
        }

        // Update live session cache immediately so guardian blocking reacts now
        applyUserClassificationFeedback(act.domain,
            flippedCategory === 'productive' ? 'on_topic' : flippedCategory === 'distraction' ? 'distraction' : 'unknown');

        feedbackMsg = `🔄 Corrected — <b>${act.domain}</b> = ${flippedCategory}. I'll remember this.`;

    } else {
        // ── SKIP ───────────────────────────────────────────────────────────────
        feedbackMsg = `⏭ Skipped.`;
    }

    // Find next unreviewed low/medium confidence activity
    const next = db.prepare(`
        SELECT id, domain, title, category, classification_confidence
        FROM activities
        WHERE classification_confidence IN ('low', 'medium')
          AND classification_reviewed = 0
          AND duration_seconds >= 30
          AND started_at >= datetime('now', '-4 hours')
        GROUP BY domain
        ORDER BY classification_confidence ASC, duration_seconds DESC
        LIMIT 1
    `).get() as { id: number; domain: string; title: string; category: string; classification_confidence: string } | undefined;

    if (next) {
        const confLabel = next.classification_confidence === 'low' ? '🟡 not sure' : '🟠 unsure';
        const catLabel = next.category === 'productive' ? '✅ productive' : next.category === 'distraction' ? '❌ distraction' : '⚪ neutral';
        await sendTelegram(
            `${feedbackMsg}\n\n` +
            `🤔 Next: <b>${next.domain}</b> → ${catLabel} (${confLabel})\n` +
            (next.title ? `📄 <i>${next.title.slice(0, 60)}</i>\n` : '') +
            `\nWas I right?`,
            'HTML',
            buildClassifyKeyboard(next.id)
        );
    } else {
        await sendTelegram(`${feedbackMsg}\n\n🎓 All done! Calibration complete.`, 'HTML', FULL_MENU_KEYBOARD);
    }
}
