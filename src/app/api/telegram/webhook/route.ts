import { NextResponse } from 'next/server';
import { getSetting, setSetting, getDb } from '@/lib/db';
import {
    sendTelegram,
    SESSION_START_KEYBOARD,
    FULL_MENU_KEYBOARD,
    buildReviewKeyboard,
    buildClassifyKeyboard,
    formatPendingReviews,
    formatNextDayPlanSummary,
    formatWeeklyPlanSummary,
} from '@/lib/telegram';
import { handleTelegramCommand, executeAction } from '@/lib/telegram-agent';
import { parseScreenTimeReport, storeScreenTimeReport, formatPhoneScreenTimeSummary } from '@/lib/phone-screen-time';
import {
    startGuardianSession,
    endGuardianSession,
    getActiveGuardianSession,
    applyUserClassificationFeedback,
    dismissCurrentSoftWatchCommitment,
    snoozeCurrentSoftWatchCommitment,
} from '@/lib/guardian-runtime';
import { learnMemory } from '@/lib/behavior';
import { getPendingCheckinType, handleMorningCheckinResponse, handleEveningReflectionResponse, getRecentUnansweredFollowUp, handleOverrideFollowupResponse } from '@/lib/checkin';
import { handleWeeklyReckoningResponse } from '@/lib/weekly-reckoning';
import { downloadTelegramVoice, transcribeAudio } from '@/lib/stt';
import { getAdaptiveSessionMinutes } from '@/lib/adaptive-command-defaults';
import { getAdaptiveBands } from '@/lib/adaptive-bands';
import { getTaskTimeProgress } from '@/lib/task-time-sessions';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

function tomorrowIsoDate(): string {
    return new Date(Date.now() + 19800000 + 86400_000).toISOString().slice(0, 10);
}

function webhookPersonalizedLine(kind: 'alert_dismissed' | 'no_active_session' | 'no_feedback_session' | 'no_softwatch' | 'review_missing' | 'session_start_failed' | 'task_missing' | 'voice_download_failed' | 'voice_transcribe_failed' | 'screentime_parse_failed'): string {
    try {
        const snapshot = buildPersonalizationSnapshot({
            surface: 'telegram',
            maxInsights: 1,
            includeMemoryFacts: 2,
        });
        if (kind === 'alert_dismissed') {
            if (snapshot.feedback.alertFatigueLevel === 'high') return '✅ Alert dismissed. I will keep routine nudges quieter while alert fatigue is high.';
            if (snapshot.moment.mode === 'deadline_pressure') return '✅ Alert dismissed. Deadline-relevant alerts will still stay visible.';
            return `✅ Alert dismissed. Current mode: ${snapshot.moment.mode.replace(/_/g, ' ')}.`;
        }
        if (kind === 'no_feedback_session') {
            if (snapshot.today.plannedFocus.nextTitle) return `No recent session to review. Next planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; feedback will matter after that block.`;
            if (snapshot.moment.mode === 'planning') return 'No recent session to review. Use this moment to set tomorrow\'s first block instead.';
            return 'No recent session to review. Start a focus block first so the model has something real to learn from.';
        }
        if (kind === 'no_active_session') {
            if (snapshot.today.plannedFocus.nextTitle) return `💤 No active session to end. Next planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>${snapshot.today.plannedFocus.nextMinutes ? ` (${snapshot.today.plannedFocus.nextMinutes}m)` : ''}.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return '💤 No active session to end. If you start one, keep it small enough for this low-capacity window.';
            if (snapshot.moment.mode === 'deadline_pressure') return '💤 No active session to end. Start the deadline-relief block before optional work.';
            if (snapshot.moment.mode === 'planning') return '💤 No active session to end. Use this window to lock tomorrow’s first block.';
            if (snapshot.userState.nextBestFocusWindow) return `💤 No active session to end. Best learned window: <b>${snapshot.userState.nextBestFocusWindow}</b>.`;
            return '💤 No active session to end. Start the next useful block when ready.';
        }
        if (kind === 'no_softwatch') {
            if (snapshot.today.plannedFocus.nextTitle) return `No pending soft watch. Next planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'No pending soft watch. Keep the next commitment small if you add one.';
            return 'No pending soft watch right now.';
        }
        if (kind === 'review_missing') {
            if (snapshot.moment.mode === 'planning') return 'Review not found. Use the current review queue or tomorrow planner instead.';
            return 'Review not found. Open the latest review queue so I can use a current completion.';
        }
        if (kind === 'session_start_failed') {
            if (snapshot.today.plannedFocus.nextTitle) return `Could not start that session. Try starting <b>${snapshot.today.plannedFocus.nextTitle}</b> from the current plan.`;
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'Could not start that session. Try a smaller title and duration for this low-capacity window.';
            return 'Could not start that session. Try again with a clear title and duration.';
        }
        if (kind === 'task_missing') {
            if (snapshot.today.plannedFocus.nextTitle) return `Task not found. Current planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; try that task from the latest list.`;
            if (snapshot.moment.mode === 'deadline_pressure') return 'Task not found. Try the deadline, course, or deliverable name.';
            return 'Task not found. Refresh tasks and try the current item.';
        }
        if (kind === 'voice_download_failed') {
            if (snapshot.moment.mode === 'deadline_pressure') return 'Could not download the voice note. Send the deadline task as text so the window is not lost.';
            if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') return 'Could not download the voice note. Send a short text version; keep it low-friction.';
            return 'Could not download the voice note. Send text or try voice again.';
        }
        if (kind === 'voice_transcribe_failed') {
            if (snapshot.today.plannedFocus.nextTitle) return `Could not transcribe that voice note. Send text for <b>${snapshot.today.plannedFocus.nextTitle}</b> and I will use the current plan.`;
            if (snapshot.moment.mode === 'planning') return 'Could not transcribe that voice note. Send tomorrow intention, sleep/wake, and fixed commitments as text.';
            return 'Could not transcribe that voice note. Try sending text instead.';
        }
        if (kind === 'screentime_parse_failed') {
            if (snapshot.moment.mode === 'recovery') return 'Could not parse the screen time report. Skip it for now unless today needs recovery evidence.';
            if (snapshot.moment.mode === 'deadline_pressure') return 'Could not parse the screen time report. Keep the deadline block moving and retry the report later.';
            return 'Could not parse the screen time report. Check the shortcut format and retry.';
        }
    } catch { /* keep fallback */ }
    if (kind === 'alert_dismissed') return '✅ Alert dismissed.';
    if (kind === 'no_active_session') return '💤 No active session to end. Start the next useful block when ready.';
    if (kind === 'no_feedback_session') return 'No recent session to give feedback on.';
    if (kind === 'no_softwatch') return 'No pending soft watch right now.';
    if (kind === 'review_missing') return 'Review not found.';
    if (kind === 'task_missing') return 'Task not found.';
    if (kind === 'voice_download_failed') return 'Could not download your voice note. Please try again.';
    if (kind === 'voice_transcribe_failed') return 'Could not transcribe your voice note. Try sending text instead.';
    if (kind === 'screentime_parse_failed') return 'Could not parse screen time report. Check format.';
    return 'Could not start session. Try again.';
}

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

        // Handle text messages
        if (body.message?.text) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) {
                await sendTelegram('Sorry, I am a private LifeOS assistant.', 'HTML');
                return NextResponse.json({ ok: true });
            }
            const text: string = body.message.text;

            // Screen time report from iOS Shortcut
            if (text.includes('SCREEN_TIME_REPORT')) {
                const report = parseScreenTimeReport(text);
                if (report) {
                    storeScreenTimeReport(report, text);
                    const summary = formatPhoneScreenTimeSummary(report);
                    await sendTelegram(summary, 'HTML');
                } else {
                    await sendTelegram(webhookPersonalizedLine('screentime_parse_failed'), 'HTML');
                }
                return NextResponse.json({ ok: true });
            }

            // Pending session context — user replied with context after being prompted
            const pendingSessionRaw = getSetting('pending_session_context');
            if (pendingSessionRaw) {
                await handlePendingSessionContext(text, pendingSessionRaw);
                return NextResponse.json({ ok: true });
            }

            // Weekly reckoning response
            if (getSetting('pending_weekly_reckoning') === 'true') {
                await handleWeeklyReckoningResponse(text);
                return NextResponse.json({ ok: true });
            }

            // Check if there's a pending check-in response or morning checkin text
            const pendingCheckin = getPendingCheckinType();
            const nowIstHour = new Date(Date.now() + 19800000).getUTCHours();
            const isMorningText = !text.startsWith('/') && (
                pendingCheckin === 'morning' || (
                    nowIstHour >= 4 && nowIstHour <= 12 &&
                    /\b(woke|slept|rate|morning|breakfast|hours|class|attending)\b/i.test(text)
                )
            );

            if (isMorningText) {
                await handleMorningCheckinResponse(body.message.text);
                return NextResponse.json({ ok: true });
            }
            if (pendingCheckin === 'evening') {
                await handleEveningReflectionResponse(body.message.text);
                return NextResponse.json({ ok: true });
            }

            // Check if user is replying to an override follow-up
            const recentFollowUp = getRecentUnansweredFollowUp();
            if (recentFollowUp) {
                await handleOverrideFollowupResponse(body.message.text, recentFollowUp.id);
                return NextResponse.json({ ok: true });
            }

            await handleTelegramCommand(body.message.text);
            return NextResponse.json({ ok: true });
        }

        // Handle voice notes (OGG/OPUS from Telegram)
        if (body.message?.voice) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) return NextResponse.json({ ok: true });

            const fileId = body.message.voice.file_id as string;
            console.log(`[Webhook] Voice note received: file_id=${fileId}, duration=${body.message.voice.duration}s`);

            // Download + transcribe
            const audioBlob = await downloadTelegramVoice(fileId);
            if (!audioBlob) {
                await sendTelegram(webhookPersonalizedLine('voice_download_failed'), 'HTML');
                return NextResponse.json({ ok: true });
            }

            const transcript = await transcribeAudio(audioBlob, 'voice.ogg');
            if (!transcript) {
                await sendTelegram(webhookPersonalizedLine('voice_transcribe_failed'), 'HTML');
                return NextResponse.json({ ok: true });
            }

            console.log(`[Webhook] Voice note transcript: "${transcript.slice(0, 100)}"`);

            // Route transcript through the same pipeline as text
            const pendingCheckin = getPendingCheckinType();
            if (pendingCheckin === 'morning') {
                await handleMorningCheckinResponse(transcript);
            } else if (pendingCheckin === 'evening') {
                await handleEveningReflectionResponse(transcript);
            } else {
                // No pending check-in — treat as a general voice command
                await handleTelegramCommand(transcript);
            }

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
    // Always acknowledge the callback first so Telegram removes the loading spinner.
    // Do this BEFORE processing to avoid Telegram's 10s timeout showing an error.
    const tok = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
    if (tok) {
        try {
            await fetch(`https://api.telegram.org/bot${tok}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackId }),
            });
        } catch (ackErr) {
            console.error('[Callback] answerCallbackQuery failed:', ackErr);
        }
    }

    if (!actionData) {
        console.warn('[Callback] Received callback with no data, callbackId:', callbackId);
        return;
    }

    const colonIdx = actionData.indexOf(':');
    if (colonIdx === -1) {
        console.warn('[Callback] Malformed callback data (no colon):', actionData);
        await sendTelegram(`Unrecognised button: ${actionData}`, '', FULL_MENU_KEYBOARD);
        return;
    }

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
            await sendTelegram(`Unknown callback type: ${type}`, '', FULL_MENU_KEYBOARD);
        }
    } catch (err) {
        console.error(`[Callback] Handler threw for "${actionData}":`, err);
        await sendTelegram(`⚠️ Something went wrong processing that button.\n<code>${String(err).slice(0, 100)}</code>`, 'HTML', FULL_MENU_KEYBOARD).catch(() => {});
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
            const learnedMinutes = getAdaptiveSessionMinutes();
            await sendTelegram(
                `🎯 <b>Start a Session</b>\n\nToday's learned default is <b>${learnedMinutes}m</b>. Reply with what to focus on, or add a duration only if you want to override it.\n<i>Example: "study zks" or "read the paper for 35m"</i>`,
                'HTML'
            );
            break;

        case 'end_session':
            if (!session) {
                await sendTelegram(webhookPersonalizedLine('no_active_session'), 'HTML', FULL_MENU_KEYBOARD);
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

        case 'next_day_plan': {
            const { generateNextDayPlan, getNextDayPlan } = await import('@/lib/next-day-planner');
            const planDate = tomorrowIsoDate();
            let plan = getNextDayPlan(planDate);
            if (!plan.plan || plan.sessions.length === 0) {
                plan = await generateNextDayPlan({
                    planDate,
                    syncCalendar: false,
                    regenerate: true,
                });
            }
            await sendTelegram(formatNextDayPlanSummary(plan), 'HTML', FULL_MENU_KEYBOARD);
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

            const focusBands = getAdaptiveBands();
            const avgFocus = Number(sessionsRow.avg_focus ?? 0);
            const scoreEmoji =
                avgFocus >= focusBands.focusExcellent ? '🔥' :
                    avgFocus >= focusBands.focusGood ? '✅' :
                        avgFocus >= focusBands.focusNeutral ? '🟡' : '🔴';
            const text = [
                `📊 <b>Daily Report — ${today}</b>`,
                ``,
                `${scoreEmoji} <b>Avg Focus:</b> ${Math.round(avgFocus)}/100`,
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
                await sendTelegram(webhookPersonalizedLine('no_feedback_session'), 'HTML', FULL_MENU_KEYBOARD);
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
            await sendTelegram(webhookPersonalizedLine('alert_dismissed'), 'HTML', FULL_MENU_KEYBOARD);
            break;

        case 'cancel_softwatch':
            {
                const commitment = dismissCurrentSoftWatchCommitment();
                await sendTelegram(
                    commitment ? `❌ Cancelled soft watch: <b>${commitment.targetTitle}</b>.` : webhookPersonalizedLine('no_softwatch'),
                    'HTML',
                    FULL_MENU_KEYBOARD
                );
            }
            break;

        case 'snooze':
            {
                const result = snoozeCurrentSoftWatchCommitment();
                await sendTelegram(
                    result.ok
                        ? `⏰ Snoozed <b>${result.targetTitle}</b> for ${result.snoozeMinutes} min.\n<i>${result.reason}</i>`
                        : webhookPersonalizedLine('no_softwatch'),
                    'HTML',
                    FULL_MENU_KEYBOARD
                );
            }
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
    if (!row) { await sendTelegram(webhookPersonalizedLine('review_missing'), 'HTML', FULL_MENU_KEYBOARD); return; }

    let msg = '';
    if (subAction === 'done') {
        db.prepare(`UPDATE session_completions SET status = 'done', actioned_at = datetime('now') WHERE id = ?`).run(id);
        if (row.task_id) {
            const progress = getTaskTimeProgress(row.task_id);
            if (progress.targetMinutes !== null && progress.creditedMinutes >= progress.targetMinutes) {
                db.prepare(`UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, datetime('now')), updated_at = datetime('now') WHERE id = ? AND status != 'done'`).run(row.task_id);
                msg = `✅ Review done. Linked task completed by focus time (${progress.creditedMinutes}/${progress.targetMinutes}m).`;
            } else if (progress.targetMinutes !== null) {
                msg = `✅ Review done. Task stays active: ${progress.remainingMinutes}m more linked focus time needed (${progress.creditedMinutes}/${progress.targetMinutes}m).`;
            } else {
                msg = '✅ Review done. Task stays active until it has a time target and linked focus minutes.';
            }
        } else {
            msg = '✅ Marked as done!';
        }
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

async function handlePendingSessionContext(reply: string, pendingRaw: string) {
    setSetting('pending_session_context', ''); // clear pending state
    try {
        const pending = JSON.parse(pendingRaw) as { topic: string; duration: number; source: string };
        const sessionContext = reply.trim().toLowerCase() === 'skip' ? undefined : reply.trim();
        const session = startGuardianSession({
            topic: pending.topic,
            durationMinutes: pending.duration,
            source: pending.source as 'api',
            sessionContext,
        });
        const contextNote = sessionContext ? `\n📝 Context noted — work mode tuned.` : '';
        await sendTelegram(
            `🛡️ <b>Session started!</b>\n📚 ${session.targetTitle}\n⏱️ ${session.durationMinutes} min${contextNote}`,
            'HTML', SESSION_START_KEYBOARD
        );
    } catch {
        await sendTelegram(webhookPersonalizedLine('session_start_failed'), 'HTML', FULL_MENU_KEYBOARD);
    }
}

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
        if (!task) { await sendTelegram(webhookPersonalizedLine('task_missing'), 'HTML', FULL_MENU_KEYBOARD); return; }
        const duration = getAdaptiveSessionMinutes(task.estimated_minutes);
        // Store pending state and ask for context before starting
        setSetting('pending_session_context', JSON.stringify({ topic: task.title, duration, source: 'api' }));
        await sendTelegram(
            `📚 <b>${task.title}</b> — ${duration} min\n\nAny context for this session? e.g. what you'll specifically be doing, tools you'll use, or just reply <b>skip</b> to start now.`,
            'HTML'
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

    if (!act) { await sendTelegram('⏰ This review has expired — the session data is no longer available. Run a new focus session to get fresh calibration prompts.', '', FULL_MENU_KEYBOARD); return; }

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
