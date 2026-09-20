#!/usr/bin/env node

import process from 'node:process';
import { startTelegramPolling } from './lib/telegram-update-forwarder.mjs';

const APP_URL = process.env.LIFEOS_APP_URL || 'http://127.0.0.1:3000';
const PING_INTERVAL_MS = Number(process.env.LIFEOSD_PING_MS || '300000'); // 5 min default
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALERT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const startedAt = new Date().toISOString();

// Sends a plain-text Telegram alert using the configured bot + chat ID.
// Silent no-op if either is missing.
async function sendAlert(text) {
  if (!BOT_TOKEN || !ALERT_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALERT_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* non-fatal — don't let alert failure crash the daemon */ }
}

console.log(`[lifeosd] starting at ${startedAt}`);
console.log(`[lifeosd] appUrl=${APP_URL} pingIntervalMs=${PING_INTERVAL_MS}`);
console.log(`[lifeosd] whisper=${process.env.WHISPER_CPP_URL ? 'configured' : 'stub'} voice=${process.env.VOICE_MODE || 'local'}`);
console.log(`[lifeosd] telegram=${BOT_TOKEN ? 'configured' : 'not configured'}`);

// ─── Guardian ping ───────────────────────────────────────────────────────────

let appWasDown = false;
let lastHeapAlertAt = 0;
let telegramCommandsRegistered = false;
const HEAP_ALERT_THRESHOLD_MB = Number(process.env.LIFEOSD_HEAP_ALERT_MB || '400');
const HEAP_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // max one heap alert per hour

async function pingGuardian(attempt = 0) {
  try {
    // Primary ping via soft-watch (also starts the checker)
    const pingRes = await fetch(`${APP_URL}/api/guardian/soft-watch`, { signal: AbortSignal.timeout(8000) });
    if (!pingRes.ok) {
      console.error(`[lifeosd] soft-watch ping failed: HTTP ${pingRes.status}`);
      return;
    }
    const pingData = await pingRes.json();
    const pending = (pingData.commitments ?? []).filter(c => c.status === 'pending').length;

    if (BOT_TOKEN && !telegramCommandsRegistered) {
      try {
        const commandsRes = await fetch(`${APP_URL}/api/telegram/register-commands`, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
        });
        telegramCommandsRegistered = commandsRes.ok;
        if (!commandsRes.ok) console.error(`[telegram] command registration failed: HTTP ${commandsRes.status}`);
      } catch (error) {
        console.error('[telegram] command registration unavailable; retrying on the next health cycle:', String(error));
      }
    }

    // Health check — fetch telemetry every ping
    let health = null;
    try {
      const healthRes = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (healthRes.ok) health = await healthRes.json();
    } catch { /* non-fatal — health endpoint may not exist on older builds */ }

    const heapMb = health?.process?.heapUsedMb ?? 0;
    const memPct = health?.os?.memUsedPct ?? 0;
    const dbMb   = health?.db?.sizeMb ?? 0;
    const uptime = health?.uptime?.human ?? '—';
    const status = health?.status ?? 'unknown';

    console.log(
      `[lifeosd] ${new Date().toISOString()} ok | ` +
      `uptime=${uptime} heap=${heapMb}MB mem=${memPct}% db=${dbMb}MB ` +
      `pending=${pending} status=${status}`
    );

    // Recovery alert
    if (appWasDown) {
      appWasDown = false;
      await sendAlert(
        `✅ <b>LifeOS is back online</b>\n\n` +
        `Uptime: ${uptime} | Heap: ${heapMb}MB | DB: ${dbMb}MB`
      );
    }

    // Heap alert — fires if heap exceeds threshold, at most once per hour
    if (heapMb > HEAP_ALERT_THRESHOLD_MB && Date.now() - lastHeapAlertAt > HEAP_ALERT_COOLDOWN_MS) {
      lastHeapAlertAt = Date.now();
      await sendAlert(
        `⚠️ <b>LifeOS high memory</b>\n\n` +
        `Heap: <b>${heapMb}MB</b> (threshold ${HEAP_ALERT_THRESHOLD_MB}MB)\n` +
        `OS mem used: ${memPct}%\n\n` +
        `Consider restarting: <code>launchctl unload ~/Library/LaunchAgents/com.lifeos.server.plist && launchctl load ~/Library/LaunchAgents/com.lifeos.server.plist</code>`
      );
    }

    // DB size alert — warn if over 500 MB
    if (dbMb > 500) {
      console.warn(`[lifeosd] DB size ${dbMb}MB — consider running a backup and archive cycle`);
    }

  } catch (err) {
    if (attempt < 5) {
      const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
      console.log(`[lifeosd] app not reachable (attempt ${attempt + 1}), retrying in ${delay / 1000}s…`);
      setTimeout(() => pingGuardian(attempt + 1), delay);
    } else {
      console.error(`[lifeosd] could not reach app after ${attempt} attempts: ${String(err)}`);
      if (!appWasDown) {
        appWasDown = true;
        await sendAlert(
          `⚠️ <b>LifeOS is unreachable</b>\n\n` +
          `Failed to connect to <code>${APP_URL}</code> after ${attempt} attempts.\n\n` +
          `Check: <code>launchctl list | grep lifeos</code>`
        );
      }
    }
  }
}

void pingGuardian(0);
setInterval(() => void pingGuardian(), PING_INTERVAL_MS);

// ─── Telegram long-polling ───────────────────────────────────────────────────

if (!BOT_TOKEN) {
  console.log('[telegram] BOT_TOKEN not set — polling disabled');
} else if (process.env.LIFEOS_ENABLE_LEGACY_TELEGRAM_POLLER === '1') {
  let offset = 0;
  let knownChatId = null;

  // Conversation state machine for multi-turn flows
  // chatId → { mode: 'standup' | 'session_note', sessionTitle?: string, step?: string }
  const conversationState = new Map();

  // ─── Telegram helpers ────────────────────────────────────────────────────

  async function tgSend(chatId, text, keyboard = null) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  }

  async function answerCallbackQuery(callbackQueryId, text = '') {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* non-fatal */ }
  }

  // ─── Inline keyboards ────────────────────────────────────────────────────

  const STATUS_KEYBOARD = [
    [
      { text: '⏹ End Session', callback_data: 'action:end_session' },
      { text: '🔁 Refresh', callback_data: 'action:status' },
    ],
  ];

  const HELP_KEYBOARD = [
    [
      { text: '📊 Status', callback_data: 'action:status' },
      { text: '📋 Report', callback_data: 'action:report' },
    ],
    [
      { text: '🎯 Start Session', callback_data: 'action:new_session' },
      { text: '🌅 Stand-up', callback_data: 'action:standup' },
    ],
  ];

  const SESSIONS_KEYBOARD = [
    [
      { text: '🔁 New Session', callback_data: 'action:new_session' },
      { text: '📊 Status', callback_data: 'action:status' },
    ],
  ];

  const NEW_SESSION_KEYBOARD = [
    [
      { text: '⚡ 30 min', callback_data: 'session:30' },
      { text: '🎯 60 min', callback_data: 'session:60' },
      { text: '🔥 90 min', callback_data: 'session:90' },
    ],
    [
      { text: '💡 120 min', callback_data: 'session:120' },
      { text: '❌ Cancel', callback_data: 'action:cancel' },
    ],
  ];

  const STANDUP_DONE_KEYBOARD = [
    [
      { text: '🎯 Start Session Now', callback_data: 'action:new_session' },
      { text: '📋 View Tasks', callback_data: 'action:tasks' },
    ],
  ];

  // ─── Command handlers ────────────────────────────────────────────────────

  async function handleCommand(chatId, text) {
    const cmd = text.trim().toLowerCase().split('@')[0]; // strip @botname suffix

    if (cmd === '/start' || cmd === '/help') {
      try {
        await fetch(`${APP_URL}/api/telegram/setup`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      } catch { /* app may not be up yet */ }
      await tgSend(chatId,
        '✅ <b>LifeOS Guardian connected!</b>\n\n' +
        'Available commands:\n' +
        '/status — active session status\n' +
        '/report — today\'s focus summary\n' +
        '/sessions — recent guardian sessions\n' +
        '/end — end current session\n' +
        '/standup — morning stand-up check-in\n' +
        '/weekly — trigger weekly email report\n' +
        '/help — show this message',
        HELP_KEYBOARD
      );
      return;
    }

    if (cmd === '/status') {
      await handleStatusAction(chatId);
      return;
    }

    if (cmd === '/report') {
      await handleReportAction(chatId);
      return;
    }

    if (cmd === '/sessions') {
      await handleSessionsAction(chatId);
      return;
    }

    if (cmd === '/end') {
      await handleEndSession(chatId);
      return;
    }

    if (cmd === '/standup') {
      await handleStandup(chatId);
      return;
    }

    if (cmd === '/weekly') {
      await tgSend(chatId, '⏳ Generating weekly report email…');
      try {
        const res = await fetch(`${APP_URL}/api/weekly`, { method: 'POST', signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          await tgSend(chatId, '✅ Weekly report sent to your email!');
        } else {
          await tgSend(chatId, '⚠️ Weekly report generation failed. Check server logs.');
        }
      } catch (err) {
        await tgSend(chatId, `⚠️ Error: ${String(err)}`);
      }
      return;
    }

    // Unknown command — forward to Next.js for full command handling (habits, tasks, goals, etc.)
    try {
      await fetch(`${APP_URL}/api/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { text, chat: { id: parseInt(chatId, 10) } } }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      await tgSend(chatId, `Unknown command. Send /help to see available commands.`);
    }
  }

  // ─── Action handlers (used by both commands and callback queries) ─────────

  async function handleStatusAction(chatId) {
    try {
      const sessRes = await fetch(`${APP_URL}/api/extension/session`, { signal: AbortSignal.timeout(5000) });
      const data = await sessRes.json();
      if (data.activeSession) {
        const s = data.activeSession;
        const elapsed = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000);
        const score = s.focusScoreHistory?.slice(-1)[0] ?? '—';
        await tgSend(chatId,
          `🛡️ <b>Session Active</b>\n\n` +
          `📚 ${s.targetTitle}\n` +
          `⏱️ Elapsed: ${elapsed} min\n` +
          `🎯 Focus score: ${score}/100`,
          STATUS_KEYBOARD
        );
      } else {
        await tgSend(chatId, '😴 No active session right now.', [
          [
            { text: '🎯 Start Session', callback_data: 'action:new_session' },
            { text: '📊 Report', callback_data: 'action:report' },
          ],
        ]);
      }
    } catch (err) {
      await tgSend(chatId, `⚠️ Could not reach LifeOS app. Is it running?\n<code>${String(err)}</code>`);
    }
  }

  async function handleReportAction(chatId) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(`${APP_URL}/api/summary?type=daily&date=${today}`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      const rawSummary = data.summary || data.report;
      const summary = typeof rawSummary === 'string' ? rawSummary : 'No report generated yet for today.';
      await tgSend(chatId, summary.slice(0, 4000), [
        [{ text: '🔁 New Session', callback_data: 'action:new_session' }],
      ]);
    } catch (err) {
      await tgSend(chatId, `⚠️ Failed to fetch report: ${String(err)}`);
    }
  }

  async function handleSessionsAction(chatId) {
    try {
      const summaryRes = await fetch(`${APP_URL}/api/sessions?limit=5`, { signal: AbortSignal.timeout(5000) });
      const data = await summaryRes.json();
      const sessions = data.sessions ?? data ?? [];
      if (!sessions.length) {
        await tgSend(chatId, '📭 No sessions recorded yet.', [
          [{ text: '🎯 Start Your First Session', callback_data: 'action:new_session' }],
        ]);
        return;
      }
      const lines = sessions.slice(0, 5).map((s, i) =>
        `${i + 1}. <b>${s.target_title || s.targetTitle}</b> — ${s.elapsed_minutes || s.elapsedMinutes} min, score ${Math.round(s.average_focus_score || s.averageFocusScore || 0)}/100`
      );
      await tgSend(chatId, `📋 <b>Recent Sessions</b>\n\n${lines.join('\n')}`, SESSIONS_KEYBOARD);
    } catch (err) {
      await tgSend(chatId, `⚠️ Failed to fetch sessions: ${String(err)}`);
    }
  }

  async function handleEndSession(chatId) {
    try {
      const sessRes = await fetch(`${APP_URL}/api/extension/session`, { signal: AbortSignal.timeout(5000) });
      const data = await sessRes.json();
      if (!data.activeSession) {
        await tgSend(chatId, '😴 No active session to end.');
        return;
      }
      const endRes = await fetch(`${APP_URL}/api/guardian/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: data.activeSession.sessionId }),
        signal: AbortSignal.timeout(8000),
      });
      if (endRes.ok) {
        await tgSend(chatId, '✅ Session ended. Report coming shortly.');
      } else {
        await tgSend(chatId, '⚠️ Failed to end session.');
      }
    } catch (err) {
      await tgSend(chatId, `⚠️ Error: ${String(err)}`);
    }
  }

  async function handleStandup(chatId) {
    const now = new Date(Date.now() + 19800000); // IST
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    conversationState.set(chatId, { mode: 'standup', step: 'awaiting_goal' });

    await tgSend(chatId,
      `🌅 <b>${greeting}! Daily Stand-up</b>\n\n` +
      `What's your <b>main focus goal</b> for today?\n\n` +
      `<i>e.g. "Finish ZK proofs chapter" or "Complete 3 DSA problems"</i>`
    );
  }

  async function handleNewSessionPrompt(chatId) {
    await tgSend(chatId,
      `🎯 <b>Start a Guardian Session</b>\n\nHow long do you want to focus?`,
      NEW_SESSION_KEYBOARD
    );
  }

  async function startSessionWithDuration(chatId, durationMinutes, topic = null) {
    try {
      const body = { durationMinutes, source: 'telegram' };
      if (topic) body.topic = topic;

      const res = await fetch(`${APP_URL}/api/guardian/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        await tgSend(chatId, '⚠️ Failed to start session. Is the app running?');
        return;
      }

      const data = await res.json();

      if (data.calendarWarning) {
        await tgSend(chatId, `⚠️ <b>Calendar conflict detected</b>\n\n${data.calendarWarning}\n\n✅ Session started anyway — consider ending early.`, [
          [{ text: '⏹ End Session', callback_data: 'action:end_session' }],
        ]);
      } else {
        const topic = data.session?.targetTitle || 'Deep Work';
        await tgSend(chatId,
          `🛡️ <b>Guardian session started!</b>\n\n📚 ${topic}\n⏱️ ${durationMinutes} min\n\nLock in. I'm watching. 👁️`,
          [
            [
              { text: '📊 Status', callback_data: 'action:status' },
              { text: '⏹ End Session', callback_data: 'action:end_session' },
            ],
          ]
        );
      }
    } catch (err) {
      await tgSend(chatId, `⚠️ Error starting session: ${String(err)}`);
    }
  }

  // ─── Morning stand-up reply processor ───────────────────────────────────

  async function processStandupReply(chatId, text, state) {
    if (state.step === 'awaiting_goal') {
      // Persist the day context via the app API
      try {
        await fetch(`${APP_URL}/api/guardian/standup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: text, chatId }),
          signal: AbortSignal.timeout(8000),
        });
      } catch { /* non-fatal if API isn't ready */ }

      conversationState.set(chatId, { mode: 'standup', step: 'awaiting_energy', goal: text });

      await tgSend(chatId,
        `✅ Got it: <b>"${text}"</b>\n\n` +
        `How's your <b>energy level</b> today?\n\n` +
        `Reply with: high / medium / low`
      );
      return;
    }

    if (state.step === 'awaiting_energy') {
      const raw = text.trim().toLowerCase();
      const mood = raw.includes('high') ? 'high' : raw.includes('low') ? 'low' : 'medium';
      const moodEmoji = mood === 'high' ? '⚡' : mood === 'low' ? '😴' : '🎯';

      conversationState.delete(chatId);

      const goal = state.goal || 'your goal';
      await tgSend(chatId,
        `${moodEmoji} <b>Stand-up complete!</b>\n\n` +
        `📌 Goal: <b>${goal}</b>\n` +
        `Energy: <b>${mood}</b>\n\n` +
        `Guardian will adapt session intensity to your energy. Ready when you are!`,
        STANDUP_DONE_KEYBOARD
      );
      return;
    }

    // Unknown standup state — clear it
    conversationState.delete(chatId);
  }

  // ─── Session feedback handler ────────────────────────────────────────────

  async function processSessionNote(chatId, text, state) {
    try {
      if (state.sessionId) {
        await fetch(`${APP_URL}/api/guardian/reflection/note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId, note: text }),
          signal: AbortSignal.timeout(8000),
        });
      }
    } catch { /* non-fatal */ }

    conversationState.delete(chatId);
    await tgSend(chatId, `📝 Note saved to your session reflection. Thanks for the feedback!`, [
      [{ text: '🔁 New Session', callback_data: 'action:new_session' }],
    ]);
  }

  // ─── Callback query handler ──────────────────────────────────────────────

  async function handleCallbackQuery(query) {
    const chatId = String(query.message.chat.id);
    const data = query.data;
    const queryId = query.id;

    // Dismiss the loading spinner immediately
    await answerCallbackQuery(queryId);

    if (data === 'action:status') {
      await handleStatusAction(chatId);
      return;
    }

    if (data === 'action:report') {
      await handleReportAction(chatId);
      return;
    }

    if (data === 'action:tasks') {
      try {
        const res = await fetch(`${APP_URL}/api/tasks?status=today&limit=10`, { signal: AbortSignal.timeout(5000) });
        const d = await res.json();
        const tasks = d.tasks ?? d ?? [];
        if (!tasks.length) {
          await tgSend(chatId, '📭 No tasks for today.');
          return;
        }
        const lines = tasks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`);
        await tgSend(chatId, `📋 <b>Today's Tasks</b>\n\n${lines.join('\n')}`, [
          [{ text: '🎯 Start Session', callback_data: 'action:new_session' }],
        ]);
      } catch (err) {
        await tgSend(chatId, `⚠️ Failed to fetch tasks: ${String(err)}`);
      }
      return;
    }

    if (data === 'action:habits') {
      try {
        const res = await fetch(`${APP_URL}/api/habits?today=1`, { signal: AbortSignal.timeout(5000) });
        const d = await res.json();
        const habits = d.habits ?? d ?? [];
        if (!habits.length) {
          await tgSend(chatId, '📭 No habits configured.');
          return;
        }
        const lines = habits.slice(0, 10).map(h => `${h.completed ? '✅' : '⬜'} ${h.icon || ''} ${h.name}`);
        await tgSend(chatId, `💪 <b>Today's Habits</b>\n\n${lines.join('\n')}`, [
          [{ text: '📊 Status', callback_data: 'action:status' }],
        ]);
      } catch (err) {
        await tgSend(chatId, `⚠️ Failed to fetch habits: ${String(err)}`);
      }
      return;
    }

    if (data === 'action:end_session') {
      await handleEndSession(chatId);
      return;
    }

    if (data === 'action:new_session') {
      await handleNewSessionPrompt(chatId);
      return;
    }

    if (data === 'action:standup') {
      await handleStandup(chatId);
      return;
    }

    if (data === 'action:snooze') {
      await tgSend(chatId, '⏰ Snoozed 15 minutes. I\'ll remind you again soon.');
      return;
    }

    if (data === 'action:cancel_softwatch') {
      await tgSend(chatId, '❌ Soft-watch commitment cancelled. Stay intentional! 💪');
      return;
    }

    if (data === 'action:dismiss_alert') {
      await tgSend(chatId, '✅ Alert dismissed.');
      return;
    }

    if (data === 'action:cancel') {
      await tgSend(chatId, '❌ Cancelled.');
      return;
    }

    if (data.startsWith('session:')) {
      const minutes = parseInt(data.split(':')[1], 10);
      if (!isNaN(minutes)) {
        await startSessionWithDuration(chatId, minutes);
      }
      return;
    }

    if (data === 'feedback:accurate') {
      await tgSend(chatId, '✅ Great — reflection marked as accurate. Logged to your profile!');
      return;
    }

    if (data === 'feedback:add_note') {
      // Get the session ID from recent sessions to attach the note to
      let sessionId = null;
      try {
        const res = await fetch(`${APP_URL}/api/sessions?limit=1`, { signal: AbortSignal.timeout(5000) });
        const d = await res.json();
        const sessions = d.sessions ?? d ?? [];
        sessionId = sessions[0]?.id ?? sessions[0]?.session_id ?? null;
      } catch { /* non-fatal */ }

      conversationState.set(chatId, { mode: 'session_note', sessionId });
      await tgSend(chatId, '📝 What would you like to add to the session reflection?\n\nJust type your note:');
      return;
    }

    // Unknown callback
    await tgSend(chatId, `⚠️ Unknown action: ${data}`);
  }

  // ─── Polling loop ────────────────────────────────────────────────────────

  async function pollTelegram() {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!res.ok) {
        console.error(`[telegram] getUpdates failed: ${res.status}`);
        return;
      }
      const data = await res.json();
      if (!data.ok || !data.result.length) return;

      for (const update of data.result) {
        offset = update.update_id + 1;

        // ── Callback query (button tap) ─────────────────────────────────────
        if (update.callback_query) {
          const query = update.callback_query;
          const chatId = String(query.message?.chat?.id);
          if (chatId) {
            console.log(`[telegram] Callback from ${chatId}: ${query.data}`);
            await handleCallbackQuery(query);
          }
          continue;
        }

        // ── Regular message ─────────────────────────────────────────────────
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Auto-register chat ID on first contact
        if (!knownChatId) {
          knownChatId = chatId;
          console.log(`[telegram] Chat ID captured: ${chatId}`);
          try {
            await fetch(`${APP_URL}/api/telegram/setup`, { method: 'POST', signal: AbortSignal.timeout(5000) });
          } catch { /* non-fatal */ }
        }

        if (msg.text.startsWith('/')) {
          console.log(`[telegram] Command from ${chatId}: ${msg.text}`);
          await handleCommand(chatId, msg.text);
        } else {
          // Check if we're in a local conversation state first
          const state = conversationState.get(chatId);
          if (state?.mode === 'standup') {
            await processStandupReply(chatId, msg.text, state);
          } else if (state?.mode === 'session_note') {
            await processSessionNote(chatId, msg.text, state);
          } else {
            // Forward natural language to Next.js for LLM handling
            try {
              await fetch(`${APP_URL}/api/telegram/webhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: { text: msg.text, chat: { id: parseInt(chatId, 10) } } }),
                signal: AbortSignal.timeout(30000),
              });
            } catch { /* non-fatal — app may be restarting */ }
          }
        }
      }
    } catch (err) {
      // Timeout is normal for long-polling, anything else log it
      if (!String(err).includes('TimeoutError') && !String(err).includes('AbortError')) {
        console.error('[telegram] poll error:', err);
      }
    }
  }

  // Long-poll loop — runs back-to-back (25s server timeout + instant restart)
  async function startPolling() {
    console.log('[telegram] Starting long-poll loop…');
    while (true) {
      await pollTelegram();
    }
  }

  void startPolling();
} else {
  void startTelegramPolling({ appUrl: APP_URL, botToken: BOT_TOKEN });
}
