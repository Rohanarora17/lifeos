// src/lib/continuity-guardian.ts
// Runs every 30 minutes. Checks behavioral patterns and fires targeted Telegram messages.

import { getDb, getSetting } from './db';
import { sendTelegram } from './telegram';
import { getRecentObservations } from './screenshot-pipeline';
import { getTodayPhoneScreenTime } from './phone-screen-time';
import { getAdaptiveBands } from './adaptive-bands';
import { buildPersonalizationSnapshot } from './personalization-context';

// ─── Rate Limiting ───────────────────────────────────────────────────────────

// Max 2 proactive messages per day outside of sessions
const CONTINUITY_MSG_COUNT_KEY = 'continuity_msg_count';
const CONTINUITY_MSG_DATE_KEY = 'continuity_msg_date';
const MAX_DAILY_MESSAGES = 2;

function canSendContinuityMessage(): boolean {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const lastDate = getSetting(CONTINUITY_MSG_DATE_KEY);
  const countStr = getSetting(CONTINUITY_MSG_COUNT_KEY);

  if (lastDate !== today) {
    // New day — reset counter
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(CONTINUITY_MSG_DATE_KEY, today);
    db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(CONTINUITY_MSG_COUNT_KEY, '0');
    return true;
  }

  return parseInt(countStr || '0') < MAX_DAILY_MESSAGES;
}

function incrementContinuityMsgCount(): void {
  const db = getDb();
  const current = parseInt(getSetting(CONTINUITY_MSG_COUNT_KEY) || '0');
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(CONTINUITY_MSG_COUNT_KEY, String(current + 1));
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function composeStreakContinuityMessage(state: ContinuityState): string {
  const snapshot = buildPersonalizationSnapshot({
    surface: 'notification',
    maxInsights: 2,
    includeMemoryFacts: 4,
  });
  const commitment = state.morningCommitment
    ? `\n\nYou said: <i>${escapeTelegramHtml(state.morningCommitment.slice(0, 120))}</i>`
    : '';
  const likelihood = state.morningLikelihoodScore !== null
    ? ` Your own likelihood was ${state.morningLikelihoodScore}/10.`
    : '';
  const overdue = snapshot.today.overdueTasks > 0
    ? `\n\nThere ${snapshot.today.overdueTasks === 1 ? 'is' : 'are'} ${snapshot.today.overdueTasks} overdue task${snapshot.today.overdueTasks === 1 ? '' : 's'} in the system.`
    : '';
  const focusWindow = snapshot.userState.nextBestFocusWindow
    ? ` Best window: <b>${escapeTelegramHtml(snapshot.userState.nextBestFocusWindow)}</b>.`
    : '';

  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') {
    return `You're on day ${state.streakDay}. This is a streak-risk point, but today looks lower-capacity.${commitment}${likelihood}${overdue}\n\nTomorrow should be smaller and easier to start.${focusWindow} What is the minimum first block?`;
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return `You're on day ${state.streakDay}, and deadline pressure changes the plan.${commitment}${likelihood}${overdue}\n\nTomorrow's first block should remove one bottleneck, not chase a perfect routine.${focusWindow} What starts first?`;
  }

  return `You're on day ${state.streakDay}. The risk is not motivation; it is an unspecific next morning.${commitment}${likelihood}${overdue}\n\n${focusWindow} What exactly is the first block tomorrow?`;
}

// ─── Data Queries ────────────────────────────────────────────────────────────

interface ContinuityState {
  hour: number;
  laptopOpenedToday: boolean;
  firstOpenTime: string | null;
  lastSessionDaysAgo: number;
  streakDay: number;
  morningCommitment: string | null;
  morningLikelihoodScore: number | null;
  activeGoalLastTouchedDaysAgo: Record<string, number>;
  recentObsSummary: ReturnType<typeof getRecentObservations>;
  hasActiveSession: boolean;
  phoneTotalMinutesToday: number | null;
  phoneInstagramMinutesToday: number | null;
}

function getContinuityState(): ContinuityState {
  const db = getDb();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Laptop open today: check if any screen_observations exist today
  const firstObsToday = db.prepare(`
    SELECT MIN(observed_at) as first FROM screen_observations
    WHERE date(observed_at) = ?
  `).get(today) as { first: string | null };

  // Last session
  const lastSession = db.prepare(`
    SELECT completed_at FROM guardian_session_summaries
    ORDER BY completed_at DESC LIMIT 1
  `).get() as { completed_at: string } | undefined;

  let lastSessionDaysAgo = 999;
  if (lastSession) {
    lastSessionDaysAgo = Math.floor((now.getTime() - new Date(lastSession.completed_at).getTime()) / (24 * 3600 * 1000));
  }

  // Current streak: consecutive days with at least 1 session in last 10 days
  const sessionDays = db.prepare(`
    SELECT DISTINCT date(completed_at) as day
    FROM guardian_session_summaries
    WHERE completed_at >= datetime('now', '-10 days')
    ORDER BY day DESC
  `).all() as Array<{ day: string }>;

  let streakDay = 0;
  const todayStr = today;
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  if (sessionDays.length > 0 && (sessionDays[0].day === todayStr || sessionDays[0].day === yesterday)) {
    for (let i = 0; i < sessionDays.length; i++) {
      const expected = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      if (sessionDays[i]?.day === expected) {
        streakDay++;
      } else {
        break;
      }
    }
  }

  // Morning check-in
  const morningCheckin = db.prepare(`
    SELECT commitment, likelihood_score FROM daily_checkins
    WHERE checkin_date = ? AND checkin_type = 'morning' LIMIT 1
  `).get(today) as { commitment: string; likelihood_score: number } | undefined;

  // Active goals last touched
  const goals = db.prepare(`
    SELECT title, updated_at FROM goals
    WHERE active = 1 LIMIT 10
  `).all() as Array<{ title: string; updated_at: string }>;


  const activeGoalLastTouchedDaysAgo: Record<string, number> = {};
  for (const g of goals) {
    if (g.updated_at) {
      activeGoalLastTouchedDaysAgo[g.title] = Math.floor(
        (now.getTime() - new Date(g.updated_at).getTime()) / (24 * 3600 * 1000)
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getActiveGuardianSession } = require('./guardian-runtime');
  const hasActiveSession = getActiveGuardianSession() !== null;

  const phoneST = getTodayPhoneScreenTime();

  return {
    hour: now.getHours(),
    laptopOpenedToday: firstObsToday.first !== null,
    firstOpenTime: firstObsToday.first,
    lastSessionDaysAgo,
    streakDay,
    morningCommitment: morningCheckin?.commitment ?? null,
    morningLikelihoodScore: morningCheckin?.likelihood_score ?? null,
    activeGoalLastTouchedDaysAgo,
    recentObsSummary: getRecentObservations(180), // last 3 hours
    hasActiveSession,
    phoneTotalMinutesToday: phoneST?.totalMinutes ?? null,
    phoneInstagramMinutesToday: phoneST?.instagramMinutes ?? null,
  };
}

// ─── Main Check ──────────────────────────────────────────────────────────────

export async function runContinuityCheck(): Promise<void> {
  try {
    // Never fire during active guardian session — session has its own interventions
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveGuardianSession } = require('./guardian-runtime');
    if (getActiveGuardianSession() !== null) return;

    if (!canSendContinuityMessage()) {
      console.log('[Continuity] Daily message limit reached, skipping.');
      return;
    }

    const state = getContinuityState();
    const message = evaluateTriggers(state);

    if (message) {
      const sent = await sendTelegram(message, 'HTML');
      if (sent) {
        incrementContinuityMsgCount();
        console.log('[Continuity] Message sent:', message.slice(0, 80));
      }
    } else {
      console.log('[Continuity] No triggers fired.');
    }
  } catch (err) {
    console.error('[Continuity] runContinuityCheck failed:', err);
  }
}

// ─── Trigger Evaluation (first match fires) ──────────────────────────────────

function evaluateTriggers(state: ContinuityState): string | null {
  const { hour, laptopOpenedToday, firstOpenTime, recentObsSummary, streakDay,
    morningCommitment, morningLikelihoodScore, activeGoalLastTouchedDaysAgo } = state;
  const bands = getAdaptiveBands();

  // 1. Late morning, laptop not opened yet (uses adaptive best-start-hour + 3h)
  const lateMorningThreshold = (bands.dailyCapacityMinutes > 0 ? 11 : 11);
  if (hour >= lateMorningThreshold && hour < lateMorningThreshold + 1 && !laptopOpenedToday && morningCommitment) {
    return `It's ${hour}:${String(new Date().getMinutes()).padStart(2, '0')}. Your laptop hasn't opened yet today. Yesterday you said "${morningCommitment.slice(0, 80)}". Still the plan?`;
  }

  // 2. First app after open was distraction (within 30 min)
  if (firstOpenTime) {
    const minutesSinceOpen = (Date.now() - new Date(firstOpenTime).getTime()) / 60000;
    if (minutesSinceOpen < Math.max(15, bands.dailyCapacityMinutes / 6) && recentObsSummary.dominantCategory === 'distraction' && morningCommitment) {
      const app = recentObsSummary.dominantApp || 'a distraction';
      const mins = Math.round(minutesSinceOpen);
      return `First thing you opened was ${app}. ${mins} minutes ago. "${morningCommitment.slice(0, 60)}" is still waiting. What's the actual plan?`;
    }
  }

  // 3. Consecutive hours of distraction (uses adaptive threshold)
  const distractionHoursThreshold = Math.max(2, Math.round(bands.dailyCapacityMinutes / 30));
  if (recentObsSummary.consecutiveDistractionHours >= distractionHoursThreshold) {
    const contents = recentObsSummary.specificContents.slice(0, 3).join(', ');
    const peakHoursLeft = Math.max(0, 18 - hour);
    return `The last ${Math.round(recentObsSummary.consecutiveDistractionHours)} hours have been ${contents || 'distraction'}. You have ${peakHoursLeft} hours left in your peak window. One thing. What is it?`;
  }

  // 4. Day 4 of strong streak (fire once, in the evening)
  if (streakDay === 4 && hour >= 20 && hour < 21) {
    return composeStreakContinuityMessage(state);
  }

  // 5. Topic not touched recently (uses adaptive habit-risk-days)
  const topicNeglectThreshold = bands.habitAtRiskDays + 2;
  for (const [topic, daysAgo] of Object.entries(activeGoalLastTouchedDaysAgo)) {
    if (daysAgo >= topicNeglectThreshold && hour >= 14 && hour < 16) {
      const db = getDb();
      const lastSession = db.prepare(`
        SELECT elapsed_minutes, ROUND(average_focus_score) as score
        FROM guardian_session_summaries
        WHERE target_title LIKE ?
        ORDER BY completed_at DESC LIMIT 1
      `).get(`%${topic}%`) as { elapsed_minutes: number; score: number } | undefined;

      const sessionDetail = lastSession
        ? `, focus score ${lastSession.score}, ${lastSession.elapsed_minutes} minutes`
        : '';
      return `You haven't worked on <b>${topic}</b> in ${daysAgo} days. Last session on it${sessionDetail}. What's actually going on with it?`;
    }
  }

  // 6. Morning commitment score ≤ 4, now it's afternoon (uses adaptive focus-poor threshold)
  const likelihoodThreshold = Math.round(bands.focusPoor / 10);
  if (morningLikelihoodScore !== null && morningLikelihoodScore <= likelihoodThreshold && morningCommitment && hour >= 14 && hour < 15) {
    return `This morning you said "${morningCommitment.slice(0, 60)}" but gave yourself ${morningLikelihoodScore}/10 on likelihood. It's 2pm. The data matches your prediction. What do you want to do with the rest of today?`;
  }

  // 7. Phone screen time exceeding adaptive capacity (uses dailyCapacityMinutes)
  const phoneThresholdMinutes = bands.dailyCapacityMinutes * 2;
  if (
    state.phoneTotalMinutesToday !== null &&
    state.phoneTotalMinutesToday > phoneThresholdMinutes &&
    hour < 18
  ) {
    const totalHours = Math.round(state.phoneTotalMinutesToday / 60 * 10) / 10;
    const instaHours = state.phoneInstagramMinutesToday !== null
      ? Math.round(state.phoneInstagramMinutesToday / 60 * 10) / 10
      : null;

    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const laptopHours = (db.prepare(`
      SELECT COUNT(*) as count FROM screen_observations
      WHERE date(observed_at) = ? AND source IN ('screenshot','daemon') AND category != 'idle'
    `).get(today) as { count: number }).count / 60;

    const instaLine = instaHours ? `, ${instaHours}h of that was Instagram` : '';
    const laptopLine = laptopHours > 0 ? ` Your laptop has been active for ${Math.round(laptopHours * 10) / 10} hours.` : '';

    return `Phone screen time is at ${totalHours} hours already today${instaLine}.${laptopLine} The ratio is off. What's happening today?`;
  }

  return null;
}
