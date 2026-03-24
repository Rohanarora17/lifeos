import { getSetting, setSetting } from './db';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

function token(): string {
  return BOT_TOKEN || getSetting('telegram_bot_token');
}

function chatId(): string {
  return process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id');
}

// ─── Inline keyboard types ────────────────────────────────────────────────────

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

// ─── Keyboard definitions ─────────────────────────────────────────────────────

export const SESSION_START_KEYBOARD: InlineKeyboard = [
  [
    { text: '📊 Status', callback_data: 'action:status' },
    { text: '⏹ End Session', callback_data: 'action:end_session' },
  ],
];

export const SESSION_END_KEYBOARD: InlineKeyboard = [
  [
    { text: '✅ Accurate', callback_data: 'feedback:accurate' },
    { text: '📝 Add Note', callback_data: 'feedback:add_note' },
  ],
  [
    { text: '🔁 New Session', callback_data: 'action:new_session' },
  ],
];

export const MORNING_BRIEF_KEYBOARD: InlineKeyboard = [
  [
    { text: '🎯 Start Session', callback_data: 'action:new_session' },
    { text: '📋 Today\'s Tasks', callback_data: 'action:tasks' },
  ],
  [
    { text: '✅ Log Habits', callback_data: 'action:habits' },
    { text: '📊 Status', callback_data: 'action:status' },
  ],
];

export const ALERT_KEYBOARD: InlineKeyboard = [
  [
    { text: '✅ Dismiss', callback_data: 'action:dismiss_alert' },
    { text: '📊 Dashboard', callback_data: 'action:status' },
  ],
];

export const SOFT_WATCH_KEYBOARD: InlineKeyboard = [
  [
    { text: '🚀 Start Now', callback_data: 'action:new_session' },
    { text: '⏰ Snooze 15m', callback_data: 'action:snooze' },
  ],
  [
    { text: '❌ Cancel', callback_data: 'action:cancel_softwatch' },
  ],
];

export const DAILY_REPORT_KEYBOARD: InlineKeyboard = [
  [
    { text: '📊 Full Report', callback_data: 'action:report' },
    { text: '🔁 New Session', callback_data: 'action:new_session' },
  ],
];

/**
 * Send a plain-text or HTML message to the configured chat.
 * Returns true on success, false on any failure (never throws).
 */
export async function sendTelegram(
  text: string,
  parseMode: 'MarkdownV2' | 'HTML' | '' = 'HTML',
  keyboard?: InlineKeyboard
): Promise<boolean> {
  const tok = token();
  const cid = chatId();
  if (!tok || !cid) {
    console.warn('[Telegram] Not configured — bot token or chat ID missing');
    return false;
  }

  try {
    const body: Record<string, unknown> = {
      chat_id: cid,
      text,
      parse_mode: parseMode,
    };
    if (keyboard) {
      body.reply_markup = { inline_keyboard: keyboard };
    }

    const res = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Telegram] sendMessage failed:', res.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Telegram] sendMessage error:', err);
    return false;
  }
}

/**
 * Query Telegram getUpdates to capture the first chat ID that messaged the bot.
 * Call once after the user sends /start to the bot.
 */
export async function captureChatId(): Promise<string | null> {
  const tok = token();
  if (!tok) return null;

  try {
    const res = await fetch(`https://api.telegram.org/bot${tok}/getUpdates?limit=10`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { ok: boolean; result: Array<{ message?: { chat: { id: number } } }> };
    if (!data.ok || !data.result.length) return null;

    const update = data.result.find(u => u.message?.chat?.id);
    if (!update?.message) return null;

    const id = String(update.message.chat.id);
    setSetting('telegram_chat_id', id);
    return id;
  } catch {
    return null;
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function formatSessionStart(targetTitle: string, durationMinutes: number, mood: string): string {
  const moodEmoji = mood === 'high' ? '⚡' : mood === 'low' ? '😴' : '🎯';
  return [
    `🛡️ <b>Guardian Session Started</b>`,
    ``,
    `📚 <b>Topic:</b> ${targetTitle}`,
    `⏱️ <b>Duration:</b> ${durationMinutes} min`,
    `${moodEmoji} <b>Mood:</b> ${mood}`,
    ``,
    `Good luck. I'm watching. 👁️`,
  ].join('\n');
}

export function formatSessionEnd(
  targetTitle: string,
  elapsedMinutes: number,
  avgFocusScore: number,
  blockedCount: number,
  reflection?: string
): string {
  const scoreEmoji = avgFocusScore >= 85 ? '🔥' : avgFocusScore >= 70 ? '✅' : avgFocusScore >= 55 ? '🟡' : '🔴';
  const lines = [
    `🏁 <b>Session Complete</b>`,
    ``,
    `📚 <b>${targetTitle}</b>`,
    `⏱️ <b>Elapsed:</b> ${elapsedMinutes} min`,
    `${scoreEmoji} <b>Focus score:</b> ${avgFocusScore}/100`,
    `🚫 <b>Blocks fired:</b> ${blockedCount}`,
  ];
  if (reflection) {
    lines.push(``, `💬 <i>${reflection}</i>`);
  }
  return lines.join('\n');
}

export function formatDailyReport(data: {
  date: string;
  productiveMinutes: number;
  distractionMinutes: number;
  tasksCompleted: number;
  totalTasks: number;
  habitsCompleted: number;
  totalHabits: number;
  score: number;
  xp: number;
  sessionsToday: number;
}): string {
  const scoreEmoji = data.score >= 85 ? '🔥' : data.score >= 70 ? '✅' : data.score >= 50 ? '🟡' : '🔴';
  const ph = Math.floor(data.productiveMinutes / 60);
  const pm = data.productiveMinutes % 60;
  const dh = Math.floor(data.distractionMinutes / 60);
  const dm = data.distractionMinutes % 60;

  return [
    `📊 <b>Daily Report — ${data.date}</b>`,
    ``,
    `${scoreEmoji} <b>Score:</b> ${data.score}/100  |  <b>XP:</b> +${data.xp}`,
    ``,
    `⏱️ <b>Productive:</b> ${ph}h ${pm}m`,
    `😈 <b>Distracted:</b> ${dh}h ${dm}m`,
    `📋 <b>Tasks:</b> ${data.tasksCompleted}/${data.totalTasks} done`,
    `🔥 <b>Habits:</b> ${data.habitsCompleted}/${data.totalHabits} checked`,
    `🛡️ <b>Sessions:</b> ${data.sessionsToday}`,
  ].join('\n');
}

export function formatMorningBrief(data: {
  date: string;
  pendingTasks: number;
  habitsToday: number;
  upcomingEvents: string[];
  streak: number;
  peakHoursLine?: string | null;
}): string {
  const events = data.upcomingEvents.length
    ? data.upcomingEvents.slice(0, 3).map(e => `  • ${e}`).join('\n')
    : '  • No meetings today';

  const lines = [
    `🌅 <b>Morning Brief — ${data.date}</b>`,
    ``,
    `🔥 <b>Streak:</b> ${data.streak} days`,
    `📋 <b>Tasks pending:</b> ${data.pendingTasks}`,
    `💪 <b>Habits to check:</b> ${data.habitsToday}`,
  ];

  if (data.peakHoursLine) {
    lines.push(data.peakHoursLine);
  }

  lines.push(
    ``,
    `📅 <b>Today's calendar:</b>`,
    events,
    ``,
    `Let's make it count. 🚀`,
  );

  return lines.join('\n');
}

export function formatAlert(type: string, message: string, severity: string): string {
  const emoji = severity === 'urgent' ? '🚨' : '⚠️';
  const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `${emoji} <b>${label}</b>\n\n${message}`;
}

export function formatSoftWatchReminder(targetTitle: string, minutesUntil: number): string {
  if (minutesUntil <= 0) {
    return `⏰ <b>Session time!</b>\n\nYou planned to study <b>${targetTitle}</b> right now.\n\nOpen LifeOS to lock in. 🎯`;
  }
  return `⏰ <b>Upcoming session in ${minutesUntil} min</b>\n\n📚 ${targetTitle}\n\nGet ready to focus.`;
}
