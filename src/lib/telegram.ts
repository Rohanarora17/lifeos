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
  [
    { text: '🚫 Override', callback_data: 'action:override_info' },
    { text: '📋 Tasks', callback_data: 'action:tasks' },
  ],
];

export const SESSION_END_KEYBOARD: InlineKeyboard = [
  [
    { text: '✅ Session Review', callback_data: 'action:review' },
    { text: '📝 Add Feedback', callback_data: 'action:feedback_prompt' },
  ],
  [
    { text: '🔁 New Session', callback_data: 'action:new_session' },
    { text: '📊 Status', callback_data: 'action:status' },
  ],
];

export const MORNING_BRIEF_KEYBOARD: InlineKeyboard = [
  [
    { text: '🎯 Start Session', callback_data: 'action:new_session' },
    { text: '📋 Today\'s Tasks', callback_data: 'action:tasks' },
  ],
  [
    { text: '✅ Habits', callback_data: 'action:habits' },
    { text: '🧠 Standup', callback_data: 'action:standup' },
  ],
  [
    { text: '🗓 Weekly Plan', callback_data: 'action:weekly_plan' },
    { text: '🎯 Goals', callback_data: 'action:goals' },
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
  [
    { text: '🗓 Weekly Plan', callback_data: 'action:weekly_plan' },
    { text: '✅ Review Queue', callback_data: 'action:review' },
  ],
];

export const FULL_MENU_KEYBOARD: InlineKeyboard = [
  [
    { text: '🎯 Start Session', callback_data: 'action:new_session' },
    { text: '📊 Status', callback_data: 'action:status' },
  ],
  [
    { text: '📋 Tasks', callback_data: 'action:tasks' },
    { text: '✅ Habits', callback_data: 'action:habits' },
  ],
  [
    { text: '🗓 Weekly Plan', callback_data: 'action:weekly_plan' },
    { text: '🎯 Goals', callback_data: 'action:goals' },
  ],
  [
    { text: '🧠 Standup', callback_data: 'action:standup' },
    { text: '📝 Review', callback_data: 'action:review' },
  ],
  [
    { text: '📈 Report', callback_data: 'action:report' },
    { text: '🔬 Calibration', callback_data: 'action:calibration' },
  ],
];

/** Build a dynamic per-completion review keyboard. IDs limited to stay under 64B. */
export function buildReviewKeyboard(completionId: number): InlineKeyboard {
  return [
    [
      { text: '✅ Done', callback_data: `review:done:${completionId}` },
      { text: '🚫 Blocked', callback_data: `review:blocked:${completionId}` },
      { text: '⏭ Skip', callback_data: `review:skip:${completionId}` },
    ],
    [{ text: '📝 More Reviews', callback_data: 'action:review' }],
  ];
}

/**
 * Build a per-activity classification review keyboard.
 * c = confirm (AI was right), f = flip (AI was wrong), s = skip.
 * Callback format: classify:ACTID:c|f|s
 */
export function buildClassifyKeyboard(actId: number): InlineKeyboard {
  return [
    [
      { text: '✅ Correct', callback_data: `classify:${actId}:c` },
      { text: '❌ Wrong', callback_data: `classify:${actId}:f` },
      { text: '⏭ Skip', callback_data: `classify:${actId}:s` },
    ],
  ];
}

/** Build a keyboard with up to 3 task-start chips. */
export function buildTaskChipsKeyboard(tasks: Array<{ id: number; title: string }>): InlineKeyboard {
  const chips = tasks.slice(0, 3).map(t => ({
    text: t.title.length > 20 ? t.title.slice(0, 18) + '…' : t.title,
    callback_data: `task:start:${t.id}`,
  }));
  return [
    chips,
    [
      { text: '🎯 Custom Topic', callback_data: 'action:new_session' },
      { text: '📊 Status', callback_data: 'action:status' },
    ],
  ];
}

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
  deadlines?: Array<{ title: string; due_date: string; due_time: string | null; task_type: string; course: string | null; daysLeft: number }>;
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

  // Deadlines this week
  if (data.deadlines && data.deadlines.length > 0) {
    lines.push(``, `⏰ <b>DEADLINES THIS WEEK</b>`);
    for (const d of data.deadlines) {
      const courseTag = d.course ? `[${d.course}] ` : '';
      const timeTag = d.due_time ? ` ${d.due_time}` : '';
      const urgency = d.daysLeft <= 0 ? '🔴 OVERDUE:' : d.daysLeft === 1 ? '🔴' : '⚠️';
      const countdown = d.daysLeft < 0 ? `(${Math.abs(d.daysLeft)}d overdue)` : d.daysLeft === 0 ? 'due TODAY' : `in ${d.daysLeft}d`;
      lines.push(`${urgency} ${courseTag}${d.title} — ${countdown}${timeTag}`);
    }
  }

  lines.push(
    ``,
    `📅 <b>Today's calendar:</b>`,
    events,
    ``,
    `Let's make it count.`,
  );

  return lines.join('\n');
}

export function formatAlert(type: string, message: string, severity: string): string {
  const emoji = severity === 'urgent' ? '🚨' : '⚠️';
  const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `${emoji} <b>${label}</b>\n\n${message}`;
}

export function formatStandupBrief(data: {
  goal: string | null;
  mood: string | null;
  energy: { composite: number; band: string } | null;
  suggestedTasks: Array<{ id: number; title: string; goal_health: string | null; reason: string }>;
  weakConcepts: Array<{ title: string; mastery: number; goalTitle: string | null }>;
}): string {
  const lines = [`🧠 <b>Standup Brief</b>`, ``];
  if (data.goal) lines.push(`🎯 <b>Today's goal:</b> ${data.goal}`);
  if (data.mood) lines.push(`${data.mood === 'high' ? '⚡' : data.mood === 'low' ? '😴' : '😐'} <b>Mood:</b> ${data.mood}`);
  if (data.energy) {
    const e = data.energy;
    const dot = e.band === 'high' ? '🟢' : e.band === 'medium' ? '🟡' : '🔴';
    lines.push(`${dot} <b>Energy:</b> ${e.band} (${Math.round(e.composite)}/100)`);
  }
  if (data.suggestedTasks.length > 0) {
    lines.push(``, `📋 <b>Suggested tasks:</b>`);
    for (const t of data.suggestedTasks.slice(0, 4)) {
      const flag = t.goal_health === 'off_track' ? ' ‼️' : t.goal_health === 'at_risk' ? ' ⚠️' : '';
      lines.push(`  • ${t.title}${flag}`);
    }
  }
  if (data.weakConcepts.length > 0) {
    lines.push(``, `🔬 <b>Weak concepts to review:</b>`);
    for (const c of data.weakConcepts.slice(0, 3)) {
      lines.push(`  • ${c.title} — ${c.mastery}% mastery`);
    }
  }
  if (!data.goal) lines.push(``, `Reply "standup: [your goal today] [mood]" to set today's goal.`);
  return lines.join('\n');
}


export function formatHabitStatus(habits: Array<{
  title: string;
  completed: boolean;
  streak: number;
  target_value: number | null;
  current_value: number | null;
  goal_metric: string;
}>): string {
  if (habits.length === 0) return `💪 <b>Habits</b>\n\nNo habits configured yet.`;
  const lines = [`💪 <b>Today's Habits</b>`, ``];
  for (const h of habits) {
    const check = h.completed ? '✅' : '⬜';
    const streak = h.streak > 1 ? ` 🔥${h.streak}` : '';
    const progress = h.goal_metric === 'time' && h.current_value != null && h.target_value != null
      ? ` (${Math.round(h.current_value)}/${h.target_value} min)`
      : '';
    lines.push(`${check} ${h.title}${streak}${progress}`);
  }
  const done = habits.filter(h => h.completed).length;
  lines.push(``, `${done}/${habits.length} complete`);
  return lines.join('\n');
}

export function formatWeeklyPlanSummary(plan: {
  week_start: string;
  days: Array<{
    date: string;
    day_name: string;
    energy_forecast: string;
    tasks: Array<{ title: string; estimated_minutes: number }>;
    total_minutes: number;
  }>;
  summary: string;
}): string {
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const lines = [`🗓 <b>Weekly Plan</b>`, `<i>${plan.summary}</i>`, ``];
  for (const day of plan.days) {
    if (day.tasks.length === 0) continue;
    const isToday = day.date === today;
    const dot = day.energy_forecast === 'high' ? '🟢' : day.energy_forecast === 'medium' ? '🟡' : '🔴';
    const marker = isToday ? ' ← today' : '';
    lines.push(`${dot} <b>${day.day_name}${marker}</b> (${day.total_minutes}m)`);
    for (const t of day.tasks.slice(0, 3)) {
      lines.push(`  • ${t.title}`);
    }
    if (day.tasks.length > 3) lines.push(`  <i>+${day.tasks.length - 3} more</i>`);
  }
  return lines.join('\n');
}

export function formatGoalHealthStatus(goals: Array<{
  title: string;
  health_status: string | null;
  actual_velocity: number | null;
  velocity_needed: number | null;
  progress_value: number | null;
  target_value: number | null;
  deadline: string | null;
}>): string {
  if (goals.length === 0) return `🎯 <b>Goals</b>\n\nNo active goals. Add goals to track progress.`;
  const lines = [`🎯 <b>Goal Health</b>`, ``];
  for (const g of goals) {
    const status = g.health_status;
    const icon = status === 'on_track' ? '✅' : status === 'at_risk' ? '⚠️' : status === 'off_track' ? '🔴' : '⬜';
    const vel = g.actual_velocity != null ? ` · ${Math.round(g.actual_velocity)}m/day` : '';
    const needed = g.velocity_needed != null ? ` (need ${Math.round(g.velocity_needed)}m/day)` : '';
    lines.push(`${icon} <b>${g.title}</b>${vel}${needed}`);
  }
  return lines.join('\n');
}

export function formatPendingReviews(reviews: Array<{
  id: number;
  task_title: string | null;
  target_title: string | null;
  session_id: string;
  elapsed_minutes: number | null;
  average_focus_score: number | null;
  mood: string | null;
}>): string {
  if (reviews.length === 0) return `📝 <b>Review Queue</b>\n\nNo pending reviews — you're all caught up!`;
  const r = reviews[0];
  const name = r.task_title ?? r.target_title ?? 'Session';
  const score = r.average_focus_score != null ? `${Math.round(r.average_focus_score)}/100` : '—';
  const mins = r.elapsed_minutes != null ? `${r.elapsed_minutes}m` : '—';
  const mood = r.mood ? ` · ${r.mood} energy` : '';
  const remaining = reviews.length > 1 ? `\n<i>${reviews.length - 1} more in queue</i>` : '';
  return [
    `📝 <b>Session Review</b>`,
    ``,
    `📚 <b>${name}</b>`,
    `⏱️ ${mins} · Focus: ${score}${mood}`,
    ``,
    `Mark this session:${remaining}`,
  ].join('\n');
}

export function formatCalibrationStatus(data: {
  accuracy: number | null;
  sessions_count: number;
  recent_adjustments: Array<{ component: string; new_value: number; previous_value: number; reason: string }>;
}): string {
  const acc = data.accuracy !== null ? `${Math.round(data.accuracy * 100)}%` : 'Not yet calibrated';
  const accEmoji = data.accuracy === null ? '⬜' : data.accuracy >= 0.7 ? '🟢' : data.accuracy >= 0.5 ? '🟡' : '🔴';
  const lines = [
    `🔬 <b>Model Calibration</b>`,
    ``,
    `${accEmoji} <b>Accuracy:</b> ${acc}`,
    `📊 <b>Sessions with feedback:</b> ${data.sessions_count}`,
  ];
  if (data.recent_adjustments.length > 0) {
    lines.push(``, `<b>Recent weight adjustments:</b>`);
    for (const a of data.recent_adjustments.slice(0, 4)) {
      const delta = a.new_value - a.previous_value;
      const label = a.component.replace(/^(energy|focus)_weight_/, '').replace(/_/g, ' ');
      lines.push(`  ${delta > 0 ? '▲' : '▼'} ${label}: ${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`);
    }
  } else {
    lines.push(``, `<i>Submit session feedback to start calibration.</i>`);
  }
  return lines.join('\n');
}

export function formatSoftWatchReminder(targetTitle: string, minutesUntil: number): string {
  if (minutesUntil <= 0) {
    return `⏰ <b>Session time!</b>\n\nYou planned to study <b>${targetTitle}</b> right now.\n\nOpen LifeOS to lock in.`;
  }
  return `⏰ <b>Upcoming session in ${minutesUntil} min</b>\n\n📚 ${targetTitle}\n\nGet ready to focus.`;
}

// ─── Task List Formatter ─────────────────────────────────────────────────────

export function formatTasksList(
  tasks: Array<{
    id: number;
    title: string;
    task_type?: string;
    course?: string | null;
    due_date?: string | null;
    due_time?: string | null;
    priority_rank?: number | null;
    priority_reason?: string | null;
    status: string;
  }>,
  maxItems = 7
): string {
  if (tasks.length === 0) return 'No tasks found.';

  const ist = Date.now() + 19800000;
  const today = new Date(ist).toISOString().slice(0, 10);

  const lines = tasks.slice(0, maxItems).map((t, i) => {
    const rankTag = t.priority_rank ? `<b>#${t.priority_rank}</b> ` : `${i + 1}. `;
    const courseTag = t.course ? `[${t.course}] ` : '';
    const typeTag = t.task_type === 'exam' ? ' 📊' : t.task_type === 'assignment' ? ' 📝' : '';

    let dueBadge = '';
    if (t.due_date) {
      const todayD = new Date(today + 'T00:00:00');
      const dueD = new Date(t.due_date + 'T00:00:00');
      const days = Math.round((dueD.getTime() - todayD.getTime()) / 86400000);
      if (days < 0) dueBadge = ` 🔴 overdue`;
      else if (days === 0) dueBadge = ` 🔴 due today${t.due_time ? ' ' + t.due_time : ''}`;
      else if (days === 1) dueBadge = ` ⚠️ due tomorrow`;
      else if (days <= 3) dueBadge = ` ⚠️ in ${days}d`;
      else dueBadge = ` · in ${days}d`;
    }
    const reasonTag = t.priority_reason ? `\n   <i>${t.priority_reason}</i>` : '';
    return `${rankTag}${courseTag}${t.title}${typeTag}${dueBadge}${reasonTag}`;
  });

  return lines.join('\n');
}
