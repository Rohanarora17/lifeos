import { getSetting, setSetting } from './db';
import { classifyAccuracy, getAdaptiveBands } from './adaptive-bands';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

type TelegramMomentMode = PersonalizationSnapshot['moment']['mode'];

const MODE_LABEL: Record<TelegramMomentMode, string> = {
  protect_focus: 'Protect focus',
  deadline_pressure: 'Deadline pressure',
  recovery: 'Recovery',
  planning: 'Planning',
  normal: 'Balanced',
};

function token(): string {
  return BOT_TOKEN || getSetting('telegram_bot_token');
}

function chatId(): string {
  return process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id');
}

function getTelegramSnapshot(): PersonalizationSnapshot | null {
  try {
    return buildPersonalizationSnapshot({
      surface: 'telegram',
      maxInsights: 2,
      includeMemoryFacts: 4,
    });
  } catch {
    return null;
  }
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function modeLine(snapshot: PersonalizationSnapshot | null): string | null {
  if (!snapshot) return null;
  const guidance = escapeTelegramHtml(String(snapshot.moment.guidance || ''));
  return `<i>${MODE_LABEL[snapshot.moment.mode]} · ${snapshot.userState.energy} energy · ${guidance}</i>`;
}

function scoreEmoji(score: number, snapshot: PersonalizationSnapshot | null, kind: 'focus' | 'day'): string {
  const bands = getAdaptiveBands();
  const excellent = kind === 'focus' ? bands.focusExcellent : snapshot?.moment.mode === 'recovery' ? 78 : 85;
  const good = kind === 'focus' ? bands.focusGood : snapshot?.moment.mode === 'recovery' ? 62 : 70;
  const neutral = kind === 'focus' ? bands.focusNeutral : snapshot?.moment.mode === 'recovery' ? 45 : 50;

  if (score >= excellent) return '🔥';
  if (score >= good) return '✅';
  if (score >= neutral) return '🟡';
  return '🔴';
}

function closingLine(snapshot: PersonalizationSnapshot | null, surface: 'morning' | 'daily' | 'session'): string {
  const mode = snapshot?.moment.mode ?? 'normal';
  if (surface === 'morning') {
    if (mode === 'recovery') return 'Make today smaller on purpose: one low-friction win first.';
    if (mode === 'deadline_pressure') return 'Start with the deadline path before opening optional work.';
    if (mode === 'protect_focus') return 'Protect the first clean focus block; defer low-value pings.';
    if (mode === 'planning') return 'Use today to set up the next clear move.';
    return 'Pick the next useful action and keep the loop tight.';
  }
  if (surface === 'daily') {
    if (mode === 'recovery') return 'Read this as recovery data, not a verdict. Choose one easier reset for tomorrow.';
    if (mode === 'deadline_pressure') return 'Tomorrow starts with the smallest action that reduces deadline risk.';
    if (mode === 'protect_focus') return 'Keep the momentum path narrow; do not add extra work just because the score looks good.';
    if (mode === 'planning') return 'Use this review to pre-decide the first block for tomorrow.';
    return 'Use the pattern, not the score alone, to choose tomorrow morning.';
  }
  if (mode === 'recovery') return 'Good enough counts today; log what helped and keep the next step light.';
  if (mode === 'deadline_pressure') return 'Capture the next deadline-relief step while it is still clear.';
  if (mode === 'protect_focus') return 'You had useful momentum; resume from the same thread if possible.';
  if (mode === 'planning') return 'Turn this into one setup action for the next block.';
  return 'Carry forward the clearest next action.';
}

function emptySignalLine(snapshot: PersonalizationSnapshot | null, surface: 'habits' | 'goals' | 'tomorrow' | 'calibration'): string {
  const mode = snapshot?.moment.mode ?? 'normal';
  if (surface === 'habits') {
    if (mode === 'recovery' || snapshot?.userState.energy === 'low' || snapshot?.userState.mood === 'low') {
      return 'Add one low-friction habit that still works on a rough day.';
    }
    if (mode === 'planning') return 'Add a habit that makes tomorrow easier to start.';
    return 'Add one habit with a measurable trigger so sessions and check-ins can learn from it.';
  }
  if (surface === 'goals') {
    if (mode === 'deadline_pressure') return 'Add the goal tied to the nearest deadline so tasks can rank around it.';
    if (mode === 'recovery') return 'Add only goals that can shrink to minimum viable progress today.';
    if (mode === 'planning') return 'Add tomorrow-facing goals before generating the next-day plan.';
    return 'Add an active goal so tasks, habits, rewards, and sessions can share the same anchor.';
  }
  if (surface === 'tomorrow') {
    if (mode === 'recovery') return 'Send sleep/wake, mood, and the one must-do so tomorrow starts lighter.';
    if (mode === 'deadline_pressure') return 'Send the deadline target, available window, and minimum acceptable progress.';
    if (mode === 'planning') return 'Send tomorrow intention, fixed calendar constraints, and preferred first block.';
    return 'Send sleep/wake, mood, and what you want protected tomorrow.';
  }
  if (mode === 'recovery') return 'Submit short feedback about energy fit; that matters more than a long review today.';
  if (mode === 'deadline_pressure') return 'Submit feedback on whether sessions reduced deadline pressure.';
  if (mode === 'planning') return 'Submit feedback on what the next plan should inherit or avoid.';
  return 'Submit session feedback to calibrate timing, energy, and intervention strength.';
}

function emptyTasksLine(snapshot: PersonalizationSnapshot | null): string {
  if (!snapshot) return 'No tasks found. Add one time-target task so focus sessions have something measurable to complete.';
  if (snapshot.today.plannedFocus.nextTitle) {
    return `No tasks found. Current planned focus is <b>${snapshot.today.plannedFocus.nextTitle}</b>; add its time target if it should count.`;
  }
  if (snapshot.userState.standupGoal) {
    return `No tasks found. Turn today's anchor into one measurable task: <b>${snapshot.userState.standupGoal}</b>.`;
  }
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return 'No tasks found. Add one small recovery-safe time target if today still needs a win.';
  }
  if (snapshot.moment.mode === 'deadline_pressure') return 'No tasks found. Add the nearest deadline-relief task first.';
  if (snapshot.moment.mode === 'planning') return 'No tasks found. Add tomorrow’s first measurable focus target.';
  return `No tasks found. Add the next task that fits ${snapshot.moment.mode.replace(/_/g, ' ')} mode.`;
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
    { text: '🗓 Tomorrow Plan', callback_data: 'action:next_day_plan' },
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
    { text: '⏰ Snooze', callback_data: 'action:snooze' },
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
    { text: '🗓 Tomorrow Plan', callback_data: 'action:next_day_plan' },
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
    { text: '🗓 Tomorrow Plan', callback_data: 'action:next_day_plan' },
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

export function formatTelegramSetupConfirmation(): string {
  const snapshot = getTelegramSnapshot();
  const mode = snapshot ? MODE_LABEL[snapshot.moment.mode] : 'Adaptive';
  const focusLine = snapshot?.today.plannedFocus.nextTitle
    ? `\n\nNext planned focus: <b>${snapshot.today.plannedFocus.nextTitle}</b>`
    : '';
  const fatigueLine = snapshot?.feedback.alertFatigueLevel === 'high'
    ? '\n\nAlert volume is high, so routine reminders will stay quieter unless something urgent needs attention.'
    : '';
  const guidanceLine = snapshot ? `\n\n<i>${snapshot.moment.guidance}</i>` : '';

  return `✅ <b>LifeOS connected</b>\n\nTelegram reminders will use your current day context instead of one fixed cadence.\n\nMode: <b>${mode}</b> · Energy: <b>${snapshot?.userState.energy ?? 'learning'}</b>${focusLine}${fatigueLine}${guidanceLine}`;
}

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
  // Telegram rejects keyboards that contain an empty row — never push [] as a row.
  const chips = tasks.slice(0, 3).map(t => ({
    text: (t.title.length > 20 ? t.title.slice(0, 18) + '…' : t.title).slice(0, 64),
    callback_data: `task:start:${t.id}`,
  }));
  const rows: InlineKeyboard = [];
  if (chips.length > 0) rows.push(chips);
  rows.push([
    { text: '🎯 Custom Topic', callback_data: 'action:new_session' },
    { text: '📊 Status', callback_data: 'action:status' },
  ]);
  return rows;
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

export function formatSessionStart(targetTitle: string, durationMinutes: number, mood: string, durationReason?: string): string {
  const snapshot = getTelegramSnapshot();
  const moodEmoji = mood === 'high' ? '⚡' : mood === 'low' ? '😴' : '🎯';
  return [
    `🛡️ <b>Guardian Session Started</b>`,
    ``,
    `📚 <b>Topic:</b> ${targetTitle}`,
    `⏱️ <b>Duration:</b> ${durationMinutes} min`,
    durationReason ? `🧠 <b>Why:</b> ${durationReason}` : null,
    `${moodEmoji} <b>Mood:</b> ${mood}`,
    modeLine(snapshot),
    ``,
    snapshot?.moment.mode === 'recovery'
      ? `Keep the scope small; I will favor gentle checks.`
      : snapshot?.moment.mode === 'deadline_pressure'
        ? `I will prioritize deadline relief and block drift sooner.`
        : snapshot?.moment.mode === 'protect_focus'
          ? `I will stay quiet unless the focus thread is at risk.`
          : `I will watch for the next useful adjustment.`,
  ].filter(Boolean).join('\n');
}

export function formatSessionEnd(
  targetTitle: string,
  elapsedMinutes: number,
  focusScore: number,
  blockedCount: number,
  reflection?: string,
  breakdown?: string,
): string {
  const snapshot = getTelegramSnapshot();
  const focusEmoji = scoreEmoji(focusScore, snapshot, 'focus');
  const lines = [
    `🏁 <b>Session Complete</b>`,
    ``,
    `📚 <b>${targetTitle}</b>`,
    `⏱️ <b>Elapsed:</b> ${elapsedMinutes} min`,
    `${focusEmoji} <b>Focus score:</b> ${focusScore}/100`,
    modeLine(snapshot),
    breakdown ? `<i>${breakdown}</i>` : null,
    `🚫 <b>Blocks fired:</b> ${blockedCount}`,
  ].filter(Boolean);
  if (reflection) {
    lines.push(``, `💬 <i>${reflection}</i>`);
  }
  lines.push(``, closingLine(snapshot, 'session'));
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
  const snapshot = getTelegramSnapshot();
  const dayScoreEmoji = scoreEmoji(data.score, snapshot, 'day');
  const ph = Math.floor(data.productiveMinutes / 60);
  const pm = data.productiveMinutes % 60;
  const dh = Math.floor(data.distractionMinutes / 60);
  const dm = data.distractionMinutes % 60;

  return [
    `📊 <b>Daily Report — ${data.date}</b>`,
    ``,
    `${dayScoreEmoji} <b>Score:</b> ${data.score}/100  |  <b>XP:</b> +${data.xp}`,
    modeLine(snapshot),
    ``,
    `⏱️ <b>Productive:</b> ${ph}h ${pm}m`,
    `😈 <b>Distracted:</b> ${dh}h ${dm}m`,
    `📋 <b>Tasks:</b> ${data.tasksCompleted}/${data.totalTasks} done`,
    `🔥 <b>Habits:</b> ${data.habitsCompleted}/${data.totalHabits} checked`,
    `🛡️ <b>Sessions:</b> ${data.sessionsToday}`,
    ``,
    closingLine(snapshot, 'daily'),
  ].filter(Boolean).join('\n');
}

export function formatMorningBrief(data: {
  date: string;
  pendingTasks: number;
  habitsToday: number;
  upcomingEvents: string[];
  streak: number;
  peakHoursLine?: string | null;
  adaptiveLine?: string | null;
  deadlines?: Array<{ title: string; due_date: string; due_time: string | null; task_type: string; course: string | null; daysLeft: number }>;
}): string {
  const snapshot = getTelegramSnapshot();
  const events = data.upcomingEvents.length
    ? data.upcomingEvents.slice(0, 3).map(e => `  • ${e}`).join('\n')
    : '  • No meetings today';

  const lines = [
    `🌅 <b>Morning Brief — ${data.date}</b>`,
    ``,
    `🔥 <b>Streak:</b> ${data.streak} days`,
    `📋 <b>Tasks pending:</b> ${data.pendingTasks}`,
    `💪 <b>Habits to check:</b> ${data.habitsToday}`,
    modeLine(snapshot),
  ];

  if (data.peakHoursLine) {
    lines.push(data.peakHoursLine);
  }
  if (data.adaptiveLine) {
    lines.push(data.adaptiveLine);
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
    closingLine(snapshot, 'morning'),
  );

  return lines.join('\n');
}

export function formatAlert(type: string, message: string, severity: string, context: { adaptiveReason?: string | null } = {}): string {
  const emoji = severity === 'urgent' ? '🚨' : '⚠️';
  const label = type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const snapshot = getTelegramSnapshot();
  const reasonLine = context.adaptiveReason ? `\n\n<i>Why now: ${context.adaptiveReason}</i>` : '';
  const mode = snapshot ? `\n<i>${MODE_LABEL[snapshot.moment.mode]} · ${snapshot.userState.energy} energy</i>` : '';
  return `${emoji} <b>${label}</b>${mode}\n\n${message}${reasonLine}`;
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
  const snapshot = getTelegramSnapshot();
  if (habits.length === 0) return [`💪 <b>Habits</b>`, ``, modeLine(snapshot), emptySignalLine(snapshot, 'habits')].filter(Boolean).join('\n');
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

export function formatNextDayPlanSummary(plan: {
  plan: { plan_date: string; generated_summary: string | null; sleep_time: string | null; wake_estimate: string | null; energy: string | null; mood: string | null } | null;
  sessions: Array<{ title: string; planned_start: string; duration_minutes: number; reward_xp: number; reward_coins: number; calendar_status: string; status: string }>;
  suggestedInputs?: { reason?: string };
  calendarConfigured?: boolean;
}): string {
  const snapshot = getTelegramSnapshot();
  const date = plan.plan?.plan_date ?? 'tomorrow';
  const summary = plan.plan?.generated_summary ?? plan.suggestedInputs?.reason ?? emptySignalLine(snapshot, 'tomorrow');
  const lines = [`🗓 <b>Tomorrow Plan</b>`, `<i>${date} · ${summary}</i>`, ``];
  if (plan.plan?.sleep_time || plan.plan?.wake_estimate || plan.plan?.energy || plan.plan?.mood) {
    lines.push([
      plan.plan.wake_estimate ? `wake ${plan.plan.wake_estimate}` : null,
      plan.plan.sleep_time ? `sleep ${plan.plan.sleep_time}` : null,
      plan.plan.energy ? `${plan.plan.energy} energy` : null,
      plan.plan.mood ? `${plan.plan.mood} mood` : null,
    ].filter(Boolean).join(' · '));
    lines.push('');
  }
  if (plan.sessions.length === 0) {
    lines.push(`No focus blocks scheduled yet. ${emptySignalLine(snapshot, 'tomorrow')}`);
  } else {
    for (const session of plan.sessions.slice(0, 6)) {
      const time = new Date(session.planned_start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const calendar = plan.calendarConfigured ? ` · calendar ${session.calendar_status}` : '';
      lines.push(`• <b>${time}</b> ${session.title} — ${session.duration_minutes}m, ${session.reward_xp} XP / ${session.reward_coins} coins${calendar}`);
    }
    if (plan.sessions.length > 6) lines.push(`<i>+${plan.sessions.length - 6} more focus block${plan.sessions.length - 6 === 1 ? '' : 's'}</i>`);
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
  const snapshot = getTelegramSnapshot();
  if (goals.length === 0) return [`🎯 <b>Goals</b>`, ``, modeLine(snapshot), emptySignalLine(snapshot, 'goals')].filter(Boolean).join('\n');
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
  focus_score: number | null;
  mood: string | null;
}>): string {
  const snapshot = getTelegramSnapshot();
  if (reviews.length === 0) {
    return [`📝 <b>Review Queue</b>`, ``, modeLine(snapshot), `No pending reviews right now.`].filter(Boolean).join('\n');
  }
  const r = reviews[0];
  const name = r.task_title ?? r.target_title ?? 'Session';
  const score = r.focus_score != null ? `${Math.round(r.focus_score)}/100` : '—';
  const mins = r.elapsed_minutes != null ? `${r.elapsed_minutes}m` : '—';
  const mood = r.mood ? ` · ${r.mood} energy` : '';
  const remaining = reviews.length > 1 ? `\n<i>${reviews.length - 1} more in queue</i>` : '';
  return [
    `📝 <b>Session Review</b>`,
    ``,
    `📚 <b>${name}</b>`,
    `⏱️ ${mins} · Focus: ${score}${mood}`,
    modeLine(snapshot),
    ``,
    snapshot?.moment.mode === 'recovery'
      ? `Mark only what you clearly remember; skip noisy reviews.${remaining}`
      : snapshot?.moment.mode === 'deadline_pressure'
        ? `Confirm anything that changes the next deadline step.${remaining}`
        : `Mark this session:${remaining}`,
  ].filter(Boolean).join('\n');
}

export function formatCalibrationStatus(data: {
  accuracy: number | null;
  sessions_count: number;
  recent_adjustments: Array<{ component: string; new_value: number; previous_value: number; reason: string }>;
}): string {
  const acc = data.accuracy !== null ? `${Math.round(data.accuracy * 100)}%` : 'Not yet calibrated';
  const accEmoji = data.accuracy === null ? '⬜' : ({ high: '🟢', medium: '🟡', low: '🔴' }[classifyAccuracy(data.accuracy)]);
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
    const snapshot = getTelegramSnapshot();
    lines.push(``, modeLine(snapshot) ?? '', `<i>${emptySignalLine(snapshot, 'calibration')}</i>`);
  }
  return lines.join('\n');
}

export interface SoftWatchReminderContext {
  tone?: 'gentle' | 'normal' | 'direct';
  reason?: string;
  plannedMinutes?: number;
  followThroughRate?: number | null;
}

function formatFollowThrough(rate?: number | null): string | null {
  if (rate === null || rate === undefined) return null;
  if (rate < 0.45) return `Recent follow-through is ${Math.round(rate * 100)}%, so keep the start friction low.`;
  if (rate > 0.75) return `Recent follow-through is ${Math.round(rate * 100)}%, so this can stay a clean lock-in cue.`;
  return `Recent follow-through is ${Math.round(rate * 100)}%, so confirm the plan before the day drifts.`;
}

function upcomingSessionCue(minutesUntil: number, context: SoftWatchReminderContext): string {
  if (context.tone === 'gentle') {
    return minutesUntil <= 5
      ? 'Start with the smallest useful version, or adjust the plan before it becomes noise.'
      : 'Keep the ramp light: clear the first tab, then start small.';
  }
  if (context.tone === 'direct') {
    return minutesUntil <= 5
      ? 'Be decisive: start, shrink, or reschedule so the plan stays honest.'
      : 'Use the remaining minutes to close distractions and make the first action obvious.';
  }
  if (context.followThroughRate !== null && context.followThroughRate !== undefined && context.followThroughRate < 0.45) {
    return 'Lower the start friction now: open the material and commit to the first tiny step.';
  }
  if (context.plannedMinutes && context.plannedMinutes >= 60) {
    return 'Set up the workspace now so the long block starts cleanly.';
  }
  return 'Use this window to make the first action specific.';
}

export function formatSoftWatchReminder(targetTitle: string, minutesUntil: number, context: SoftWatchReminderContext = {}): string {
  const durationLine = context.plannedMinutes ? `\n\nPlanned block: <b>${context.plannedMinutes} min</b>` : '';
  const followThroughLine = formatFollowThrough(context.followThroughRate);
  const reasonLine = context.reason ? `\n\n<i>${context.reason}</i>` : '';
  const learningLine = followThroughLine ? `\n${followThroughLine}` : '';

  if (minutesUntil <= 0) {
    if (context.tone === 'gentle') {
      return `⏰ <b>Soft start window</b>\n\n<b>${targetTitle}</b> is ready now.${durationLine}\n\nStart with the smallest version or adjust it before it becomes noise.${learningLine}${reasonLine}`;
    }

    if (context.tone === 'direct') {
      return `⏰ <b>Lock in now</b>\n\nYou planned <b>${targetTitle}</b> for this window.${durationLine}\n\nStart, shrink, or reschedule it so the plan stays honest.${learningLine}${reasonLine}`;
    }

    return `⏰ <b>Session time!</b>\n\nYou planned to study <b>${targetTitle}</b> right now.${durationLine}\n\nOpen LifeOS to lock in.${learningLine}${reasonLine}`;
  }
  return `⏰ <b>Upcoming session in ${minutesUntil} min</b>\n\n📚 ${targetTitle}${durationLine}\n\n${upcomingSessionCue(minutesUntil, context)}${learningLine}${reasonLine}`;
}

export function formatSoftWatchCheckIn(targetTitle: string, delayMinutes: number, context: SoftWatchReminderContext = {}): string {
  const durationLine = context.plannedMinutes ? `\n\nPlanned block: <b>${context.plannedMinutes} min</b>` : '';
  const followThroughLine = formatFollowThrough(context.followThroughRate);
  const learningLine = followThroughLine ? `\n${followThroughLine}` : '';
  const reasonLine = context.reason ? `\n\n<i>${context.reason}</i>` : '';

  if (context.tone === 'gentle') {
    return `⏰ <b>Still holding this softly</b>\n\n<b>${targetTitle}</b> has been waiting about ${delayMinutes} min.${durationLine}\n\nShrink it, move it, or let it go without adding guilt.${learningLine}${reasonLine}`;
  }
  if (context.tone === 'direct') {
    return `⏰ <b>Decision needed</b>\n\n<b>${targetTitle}</b> has been pending about ${delayMinutes} min.${durationLine}\n\nStart the deadline block now, shrink it, or reschedule before this window leaks away.${learningLine}${reasonLine}`;
  }
  if (context.followThroughRate !== null && context.followThroughRate !== undefined && context.followThroughRate < 0.45) {
    return `⏰ <b>Make the plan real</b>\n\n<b>${targetTitle}</b> has been waiting about ${delayMinutes} min.${durationLine}\n\nPick the lowest-friction version you will actually start, or reschedule honestly.${learningLine}${reasonLine}`;
  }
  return `⏰ <b>Still pending</b>\n\nYou committed to <b>${targetTitle}</b> about ${delayMinutes} min ago.${durationLine}\n\nLock in, shrink it, or reschedule?${learningLine}${reasonLine}`;
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
  const snapshot = getTelegramSnapshot();
  if (tasks.length === 0) {
    return [emptyTasksLine(snapshot), modeLine(snapshot)].filter(Boolean).join('\n');
  }

  const ist = Date.now() + 19800000;
  const today = new Date(ist).toISOString().slice(0, 10);

  const lines = [
    modeLine(snapshot),
    snapshot?.moment.mode === 'recovery'
      ? '<i>Showing the order that best fits low-friction progress.</i>'
      : snapshot?.moment.mode === 'deadline_pressure'
        ? '<i>Showing deadline-relief work first.</i>'
        : snapshot?.moment.mode === 'protect_focus'
          ? '<i>Showing tasks that preserve the current focus thread first.</i>'
          : null,
    '',
    ...tasks.slice(0, maxItems).map((t, i) => {
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
    const reasonRaw = t.priority_reason || (t as { reason?: string }).reason;
    const reasonTag = reasonRaw ? `\n   <i>${escapeTelegramHtml(String(reasonRaw))}</i>` : '';
    const safeTitle = escapeTelegramHtml(String(t.title || 'Untitled'));
    const safeCourse = t.course ? `[${escapeTelegramHtml(String(t.course))}] ` : '';
    return `${rankTag}${safeCourse}${safeTitle}${typeTag}${dueBadge}${reasonTag}`;
    }),
  ].filter(line => line !== null) as string[];

  return lines.join('\n');
}
