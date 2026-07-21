// src/lib/checkin.ts
// Check-in pipeline: morning questions, evening reflection, response parsing, memory extraction

import { getDb, setSetting, getSetting } from './db';
import { sendTelegram } from './telegram';
import { extractMemoryFromCheckin } from './memory-extractor';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { getIntelligenceContext, getIntelligenceProfile } from './intelligence';
import { generateNextDayPlan } from './next-day-planner';
import { getFeedbackLearningSummary } from './feedback-learning';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';
import { buildSelfModel, selectSelfModelQuestion, type SelfModelGapQuestion } from './self-model';

// ─── State Keys (stored in settings table) ──────────────────────────────────

export const PENDING_CHECKIN_KEY = 'pending_checkin_type'; // 'morning' | 'evening' | ''
export const PENDING_CHECKIN_DATE_KEY = 'pending_checkin_date'; // ISO date string
export const PENDING_CHECKIN_SENT_AT_KEY = 'pending_checkin_sent_at'; // epoch ms string

const IST_OFFSET_MS = 19_800_000;

function todayIst(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function sleepHour(value: string | null | undefined): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const hour = Number.parseInt(value.slice(0, 2), 10);
  return Number.isFinite(hour) ? hour : null;
}

export function resolvePlanDateFromEveningCheckin(input: {
  checkinDate?: string | null;
  sleepTime?: string | null;
  now?: Date;
} = {}): string {
  const localNow = new Date((input.now?.getTime() ?? Date.now()) + IST_OFFSET_MS);
  const checkinDate = input.checkinDate || localNow.toISOString().slice(0, 10);
  const hourNow = localNow.getUTCHours();
  const sleep = sleepHour(input.sleepTime);
  const isPostMidnightLateNight = hourNow < 4 && sleep !== null && sleep < 12;
  return isPostMidnightLateNight ? checkinDate : addDays(checkinDate, 1);
}

function getAdaptiveCheckinQuestion(surface: 'morning_checkin' | 'evening_checkin'): SelfModelGapQuestion | null {
  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'checkin',
      maxInsights: 3,
      includeThresholds: true,
      includeMemoryFacts: 6,
    });
    const profile = getIntelligenceProfile();
    const feedbackFacts = getFeedbackLearningSummary(12);
    const selfModel = buildSelfModel({ snapshot, profile, feedbackFacts });
    return selectSelfModelQuestion(selfModel, surface);
  } catch (err) {
    console.warn('[Checkin] adaptive question unavailable:', err);
    return null;
  }
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInlineList(items: string[], limit = 3): string {
  const visible = items.map(item => escapeTelegramHtml(item.trim())).filter(Boolean).slice(0, limit);
  if (visible.length === 0) return '';
  const suffix = items.length > visible.length ? ` +${items.length - visible.length} more` : '';
  return `${visible.join(', ')}${suffix}`;
}

function buildEveningReflectionMessage(input: {
  snapshot: PersonalizationSnapshot;
  adaptiveQuestion: SelfModelGapQuestion | null;
}): string {
  const { snapshot, adaptiveQuestion } = input;
  const questions: string[] = [];
  const modeLabel: Record<PersonalizationSnapshot['moment']['mode'], string> = {
    protect_focus: 'protected focus',
    deadline_pressure: 'deadline pressure',
    recovery: 'recovery',
    planning: 'planning',
    normal: 'balanced',
  };

  questions.push(
    `1. <b>What actually moved today?</b> Mention wins, avoided work, and the real reason for any avoidance.`,
  );

  if (snapshot.moment.mode === 'deadline_pressure' || snapshot.today.overdueTasks > 0) {
    questions.push(
      `2. <b>What deadline or overdue item changed today?</b> What is the smallest next move for tomorrow?`,
    );
  } else if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    questions.push(
      `2. <b>What affected your body, mood, or energy today?</b> Be specific so tomorrow can be lighter or later if needed.`,
    );
  } else if (snapshot.today.recentDistractionMinutes >= 30) {
    questions.push(
      `2. <b>What pulled attention away tonight?</b> Name the trigger, not just the app.`,
    );
  } else {
    questions.push(
      `2. <b>What happened today that affected your mood, energy, or focus?</b>`,
    );
  }

  questions.push(
    `3. <b>What time are you actually sleeping tonight, and what wake time should I assume?</b> If midnight became 2am, say that.`,
  );

  const planned = formatInlineList(snapshot.today.doingTasks);
  questions.push(
    planned
      ? `4. <b>Tomorrow, should I protect time for ${planned}, or is there something higher priority?</b> Include rough hours/minutes.`
      : `4. <b>What do you want to do tomorrow, and how much time should each thing get?</b>`,
  );

  if (snapshot.today.calendarEvents.length > 0) {
    questions.push(
      `5. <b>Any calendar constraint tomorrow or tonight that should change the plan?</b> Also mention travel, errands, or fixed calls.`,
    );
  } else if (snapshot.userState.nextBestFocusWindow) {
    questions.push(
      `5. <b>Does ${escapeTelegramHtml(snapshot.userState.nextBestFocusWindow)} still look like your best focus window tomorrow?</b> If not, give the better window.`,
    );
  } else {
    questions.push(
      `5. <b>When should the first focus block happen tomorrow?</b>`,
    );
  }

  if (adaptiveQuestion) {
    questions.push(`6. <b>${escapeTelegramHtml(adaptiveQuestion.question)}</b>`);
  } else {
    questions.push(`6. <b>How likely are you to show up tomorrow, 1-10?</b> Why that number?`);
  }

  const contextBits = [
    `${modeLabel[snapshot.moment.mode]} mode`,
    `${snapshot.userState.energy} energy`,
    snapshot.userState.mood ? `${snapshot.userState.mood} mood` : null,
    snapshot.feedback.alertFatigueLevel !== 'low' ? `${snapshot.feedback.alertFatigueLevel} alert fatigue` : null,
    snapshot.today.openTasks > 0 ? `${snapshot.today.openTasks} open tasks` : null,
  ].filter(Boolean);

  return [
    `End-of-day check-in — ${contextBits.join(' · ')}.`,
    snapshot.moment.guidance ? `<i>${escapeTelegramHtml(snapshot.moment.guidance)}</i>` : '',
    '',
    ...questions,
    '',
    adaptiveQuestion ? `<i>Asking #6 because ${escapeTelegramHtml(adaptiveQuestion.reason)}</i>` : '',
    `Voice note or text is fine.`,
  ].filter(line => line !== '').join('\n');
}

function buildMorningFallbackMessage(input: {
  snapshot: PersonalizationSnapshot;
  adaptiveQuestion: SelfModelGapQuestion | null;
}): string {
  const { snapshot, adaptiveQuestion } = input;
  const question = adaptiveQuestion?.question
    ?? `What's your one commitment today, and how likely are you to actually do it, 1-10?`;
  const pressure = snapshot.today.overdueTasks > 0
    ? `${snapshot.today.overdueTasks} overdue task${snapshot.today.overdueTasks === 1 ? '' : 's'}`
    : snapshot.today.openTasks > 0
      ? `${snapshot.today.openTasks} open task${snapshot.today.openTasks === 1 ? '' : 's'}`
      : null;
  const focusWindow = snapshot.userState.nextBestFocusWindow
    ? `Best focus window: ${escapeTelegramHtml(snapshot.userState.nextBestFocusWindow)}.`
    : null;
  const modeLine: Record<PersonalizationSnapshot['moment']['mode'], string> = {
    recovery: `Good morning. Today looks lower-capacity, so make the first promise smaller than your ambition.`,
    deadline_pressure: `Good morning. There is deadline pressure today; pick the one move that actually reduces it.`,
    protect_focus: `Good morning. Your focus signal is worth protecting today; choose the block that deserves the quiet window.`,
    planning: `Good morning. Use today to turn the plan into one concrete first block.`,
    normal: `Good morning. Choose the commitment that fits today's actual shape.`,
  };
  const context = [
    `${snapshot.userState.energy} energy`,
    snapshot.userState.mood ? `${snapshot.userState.mood} mood` : null,
    pressure,
    focusWindow,
  ].filter(Boolean).join(' · ');

  return [
    modeLine[snapshot.moment.mode],
    context ? `<i>${context}</i>` : '',
    '',
    escapeTelegramHtml(question),
  ].filter(Boolean).join('\n');
}

// ─── Send Functions ──────────────────────────────────────────────────────────

export async function sendMorningCheckin(): Promise<void> {
  const today = todayIst();

  // Check 1: already sent today (pending state) — user hasn't replied yet
  const pendingDate = getSetting(PENDING_CHECKIN_DATE_KEY);
  if (pendingDate === today) {
    console.log('[Checkin] Morning check-in already sent today (pending), skipping.');
    return;
  }

  // Check 2: already answered today (DB record)
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM daily_checkins WHERE checkin_date = ? AND checkin_type = 'morning'"
  ).get(today) as { id: number } | undefined;
  if (existing) {
    console.log('[Checkin] Morning check-in already completed today, skipping.');
    return;
  }

  // Claim the slot BEFORE the async LLM call — prevents concurrent restarts from both firing
  setSetting(PENDING_CHECKIN_DATE_KEY, today);

  const snapshot = buildPersonalizationSnapshot({
    surface: 'checkin',
    maxInsights: 3,
    includeThresholds: true,
    includeMemoryFacts: 6,
  });
  const adaptiveQuestion = getAdaptiveCheckinQuestion('morning_checkin');
  let message = buildMorningFallbackMessage({ snapshot, adaptiveQuestion });

  try {
    const intelligenceContext = getIntelligenceContext({ maxInsights: 2, includeToday: true });
    const ai = getGenAI();
    if (ai) {
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: `Generate a personalized morning check-in message for this user. Be direct, specific, and brief. Reference their actual goals, patterns, or yesterday's outcomes if relevant. Maximum 45 words. End with the adaptive question below, preserving its intent. Do not use a fixed good-morning template; adapt to today's mode, energy, workload, and likely focus window.

Adaptive question to ask because ${adaptiveQuestion?.reason ?? 'the model needs a fresh daily anchor'}:
${adaptiveQuestion?.question ?? 'What is your one commitment today, and how likely are you to do it from 1-10?'}

Today context:
Mode: ${snapshot.moment.mode}
Energy: ${snapshot.userState.energy}
Mood: ${snapshot.userState.mood ?? 'unknown'}
Open tasks: ${snapshot.today.openTasks}
Overdue tasks: ${snapshot.today.overdueTasks}
Best focus window: ${snapshot.userState.nextBestFocusWindow}

User context:
${intelligenceContext}

Return ONLY the message text. No quotes.`,
        config: { temperature: 0.7, maxOutputTokens: 80 },
      });
      const generated = result.text?.trim();
      if (generated && generated.length > 20) message = generated;
    }
  } catch { /* non-fatal — use default */ }

  const sent = await sendTelegram(message, 'HTML');
  if (sent) {
    setSetting(PENDING_CHECKIN_KEY, 'morning');
    setSetting(PENDING_CHECKIN_SENT_AT_KEY, Date.now().toString());
    console.log('[Checkin] Morning check-in sent.');
  } else {
    // Send failed — clear the claim so it can retry
    setSetting(PENDING_CHECKIN_DATE_KEY, '');
  }
}

export async function sendEveningReflection(): Promise<void> {
  const today = todayIst();

  // Don't send if already sent today
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM daily_checkins WHERE checkin_date = ? AND checkin_type = 'evening'"
  ).get(today) as { id: number } | undefined;
  if (existing) {
    console.log('[Checkin] Evening reflection already sent today, skipping.');
    return;
  }

  const snapshot = buildPersonalizationSnapshot({
    surface: 'checkin',
    maxInsights: 3,
    includeThresholds: true,
    includeMemoryFacts: 6,
  });
  const adaptiveQuestion = getAdaptiveCheckinQuestion('evening_checkin');
  const message = buildEveningReflectionMessage({ snapshot, adaptiveQuestion });

  const sent = await sendTelegram(message, 'HTML');
  if (sent) {
    setSetting(PENDING_CHECKIN_KEY, 'evening');
    setSetting(PENDING_CHECKIN_DATE_KEY, today);
    setSetting(PENDING_CHECKIN_SENT_AT_KEY, Date.now().toString());
    console.log('[Checkin] Evening reflection sent.');
  }
}

// ─── Response Handlers ───────────────────────────────────────────────────────

function buildFallbackCheckinResponse(likelihoodScore: number | null): string {
  if (likelihoodScore !== null && likelihoodScore <= 4) {
    return `You said ${likelihoodScore}/10. Let's make it stupidly small. One tab open, 20 minutes, that's it. What time are you starting?`;
  } else if (likelihoodScore !== null && likelihoodScore >= 8) {
    return `${likelihoodScore}/10. Good. I'll hold you to it.`;
  }
  return `Noted. I'll be watching.`;
}

type CheckinSignalLevel = 'low' | 'medium' | 'high';

interface EveningCheckinSignals {
  sleepTime: string | null;
  wakeEstimate: string | null;
  tomorrowIntention: string | null;
  mood: CheckinSignalLevel | null;
  energy: CheckinSignalLevel | null;
  dayEvents: string | null;
}

function normalizeSignalLevel(value: unknown): CheckinSignalLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  if (['bad', 'sad', 'down', 'drained', 'tired', 'exhausted', 'sick'].includes(normalized)) return 'low';
  if (['ok', 'okay', 'fine', 'normal', 'average', 'neutral'].includes(normalized)) return 'medium';
  if (['good', 'great', 'happy', 'energized', 'fresh', 'strong'].includes(normalized)) return 'high';
  return null;
}

function normalizeExtractedTime(value: unknown): string | null {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

function normalizeShortText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function parseEveningCheckinSignals(raw: string): EveningCheckinSignals {
  const parsed = JSON.parse(raw) as Partial<Record<keyof EveningCheckinSignals, unknown>>;
  return {
    sleepTime: normalizeExtractedTime(parsed.sleepTime),
    wakeEstimate: normalizeExtractedTime(parsed.wakeEstimate),
    tomorrowIntention: normalizeShortText(parsed.tomorrowIntention),
    mood: normalizeSignalLevel(parsed.mood),
    energy: normalizeSignalLevel(parsed.energy),
    dayEvents: normalizeShortText(parsed.dayEvents),
  };
}

export async function handleMorningCheckinResponse(text: string): Promise<void> {
  const today = getSetting(PENDING_CHECKIN_DATE_KEY) || todayIst();

  // Parse: look for a number 1-10 in the text for likelihood score
  const scoreMatch = text.match(/\b([1-9]|10)\b/);
  const likelihoodScore = scoreMatch ? parseInt(scoreMatch[1]) : null;

  // The rest is the commitment (full text)
  const commitment = text.trim();

  const db = getDb();
  db.prepare(`
    INSERT INTO daily_checkins (checkin_date, checkin_type, commitment, likelihood_score, raw_transcript)
    VALUES (?, 'morning', ?, ?, ?)
  `).run(today, commitment, likelihoodScore, text);

  // Clear pending state
  setSetting(PENDING_CHECKIN_KEY, '');
  setSetting(PENDING_CHECKIN_DATE_KEY, '');
  setSetting(PENDING_CHECKIN_SENT_AT_KEY, '');

  let response: string;
  try {
    const ai = getGenAI();
    const intelligenceContext = getIntelligenceContext({ maxInsights: 1, includeToday: true });
    if (ai) {
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: `The user just answered their morning check-in. They said: "${text}" (likelihood: ${likelihoodScore ?? 'unknown'}/10). Respond in 1-2 short sentences as a focus coach. Be specific to their commitment. If likelihood is low (<=4), suggest making it smaller. If high (>=8), hold them accountable. If medium, acknowledge and set a time. Reference their goals if possible.

${intelligenceContext}

Return ONLY the response. No quotes.`,
        config: { temperature: 0.7, maxOutputTokens: 60 },
      });
      const generated = result.text?.trim();
      if (generated && generated.length > 5) response = generated;
      else response = buildFallbackCheckinResponse(likelihoodScore);
    } else {
      response = buildFallbackCheckinResponse(likelihoodScore);
    }
  } catch {
    response = buildFallbackCheckinResponse(likelihoodScore);
  }

  await sendTelegram(response, 'HTML');

  // Extract memory in background
  void extractMemoryFromCheckin({ type: 'morning', commitment, likelihoodScore, rawTranscript: text, date: today });

  console.log(`[Checkin] Morning check-in recorded. Score: ${likelihoodScore}, commitment: ${commitment?.slice(0, 50)}`);
}

export async function handleEveningReflectionResponse(text: string): Promise<void> {
  const today = getSetting(PENDING_CHECKIN_DATE_KEY) || todayIst();

  // Look for tomorrow score (1-10) at the end of the response
  const scoreMatch = text.match(/\b([1-9]|10)\b[^\d]*$/);
  const tomorrowScore = scoreMatch ? parseInt(scoreMatch[1]) : null;

  const db = getDb();
  db.prepare(`
    INSERT INTO daily_checkins (checkin_date, checkin_type, raw_transcript, tomorrow_score)
    VALUES (?, 'evening', ?, ?)
  `).run(today, text, tomorrowScore);

  // Clear pending state
  setSetting(PENDING_CHECKIN_KEY, '');
  setSetting(PENDING_CHECKIN_DATE_KEY, '');
  setSetting(PENDING_CHECKIN_SENT_AT_KEY, '');

  // Acknowledge with context-aware response
  let ackMessage = `Got it. I'll think about what you said tonight.`;
  try {
    const ai = getGenAI();
    if (ai) {
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: `The user just shared their evening reflection. Respond in one short sentence acknowledging what they shared. Be warm but direct. Maximum 20 words. No generic phrases.

Their reflection: "${text.slice(0, 200)}"

Return ONLY the response. No quotes.`,
        config: { temperature: 0.7, maxOutputTokens: 40 },
      });
      const generated = result.text?.trim();
      if (generated && generated.length > 5) ackMessage = generated;
    }
  } catch { /* non-fatal */ }

  await sendTelegram(ackMessage, 'HTML');

  // Extract sleep/wake/intention non-blocking
  void (async () => {
    try {
      const extractPrompt = `Extract adaptive planning signals from this evening check-in. Return JSON only, no markdown.

Response: "${text}"

Return: {
  "sleepTime": "HH:MM in 24h format, or null if not mentioned",
  "wakeEstimate": "HH:MM in 24h format — derive as sleepTime + 8h if not stated, or null",
  "tomorrowIntention": "what they plan to do tomorrow in one phrase, or null",
  "mood": "low, medium, high, or null",
  "energy": "low, medium, high, or null",
  "dayEvents": "specific things that happened today that affected focus, mood, body, schedule, or work, or null"
}

Examples:
- "sleeping at 1am, drained after family work" -> sleepTime: "01:00", wakeEstimate: "09:00", energy: "low", dayEvents: "family work drained energy"
- "bed by midnight, mood was good" -> sleepTime: "00:00", wakeEstimate: "08:00", mood: "high"
- "want to finish module 3" -> tomorrowIntention: "finish module 3"
If nothing relevant for a field, return null for that field.`;

      const ai = getGenAI();
      if (!ai) throw new Error('No AI client');
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: extractPrompt,
        config: { temperature: 0.1, maxOutputTokens: 200 },
      });
      const raw = result.text ?? '';
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const extracted = parseEveningCheckinSignals(cleaned);

      if (
        extracted.sleepTime ||
        extracted.wakeEstimate ||
        extracted.tomorrowIntention ||
        extracted.mood ||
        extracted.energy ||
        extracted.dayEvents
      ) {
        db.prepare(`
          UPDATE daily_checkins
          SET sleep_time = COALESCE(?, sleep_time),
              wake_estimate = COALESCE(?, wake_estimate),
              tomorrow_intention = COALESCE(?, tomorrow_intention),
              mood = COALESCE(?, mood),
              energy = COALESCE(?, energy),
              day_events = COALESCE(?, day_events)
          WHERE checkin_date = ? AND checkin_type = 'evening'
        `).run(
          extracted.sleepTime ?? null,
          extracted.wakeEstimate ?? null,
          extracted.tomorrowIntention ?? null,
          extracted.mood ?? null,
          extracted.energy ?? null,
          extracted.dayEvents ?? null,
          today
        );
        await generateNextDayPlan({
          planDate: resolvePlanDateFromEveningCheckin({
            checkinDate: today,
            sleepTime: extracted.sleepTime,
          }),
          sleepTime: extracted.sleepTime,
          wakeEstimate: extracted.wakeEstimate,
          mood: extracted.mood,
          energy: extracted.energy,
          tomorrowIntention: extracted.tomorrowIntention,
          eveningNotes: extracted.dayEvents ? `${extracted.dayEvents}\n\n${text}` : text,
          syncCalendar: false,
        });
        console.log(`[Checkin] Evening signals extracted — sleep: ${extracted.sleepTime}, wake: ${extracted.wakeEstimate}, mood: ${extracted.mood}, energy: ${extracted.energy}, intention: ${extracted.tomorrowIntention}`);
      }
    } catch (err) {
      console.error('[Checkin] sleep/wake extraction failed (non-blocking):', err);
    }
  })();

  // Deep analysis: run memory extraction with full day context
  void extractMemoryFromCheckin({ type: 'evening', rawTranscript: text, tomorrowScore, date: today });

  console.log(`[Checkin] Evening reflection recorded. Tomorrow score: ${tomorrowScore}`);
}

// ─── Wake Estimate ────────────────────────────────────────────────────────────

/**
 * Returns the most recent wake_estimate from evening check-ins.
 * Used by the scheduler to fire morning check-in at the right time.
 */
export function getWakeEstimate(): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT wake_estimate FROM daily_checkins
    WHERE checkin_type = 'evening' AND wake_estimate IS NOT NULL
    ORDER BY received_at DESC LIMIT 1
  `).get() as { wake_estimate: string } | undefined;
  return row?.wake_estimate ?? null;
}

// ─── State Check ─────────────────────────────────────────────────────────────

export function getPendingCheckinType(): 'morning' | 'evening' | null {
  const val = getSetting(PENDING_CHECKIN_KEY);
  if (val !== 'morning' && val !== 'evening') return null;

  // Auto-expire after 3 hours — prevents stale state intercepting later messages
  const sentAt = getSetting(PENDING_CHECKIN_SENT_AT_KEY);
  if (sentAt) {
    const ageMs = Date.now() - parseInt(sentAt, 10);
    if (ageMs > 3 * 60 * 60 * 1000) {
      setSetting(PENDING_CHECKIN_KEY, '');
      setSetting(PENDING_CHECKIN_DATE_KEY, '');
      setSetting(PENDING_CHECKIN_SENT_AT_KEY, '');
      return null;
    }
  }

  return val;
}

// ─── Override Follow-Up ───────────────────────────────────────────────────────

interface FollowUpRow {
  id: number;
  session_id: string;
  override_url: string;
  override_reason: string;
}

/**
 * Returns the most recent sent follow-up that hasn't been answered yet (within last 30 min).
 */
export function getRecentUnansweredFollowUp(): FollowUpRow | null {
  const db = getDb();
  const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT id, session_id, override_url, override_reason
    FROM override_follow_ups
    WHERE sent = 1 AND response IS NULL AND sent_at >= ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(thirtyMinsAgo) as FollowUpRow | null;
}

/**
 * Record a user's response to an override follow-up.
 */
export async function handleOverrideFollowupResponse(text: string, followUpId: number): Promise<void> {
  const db = getDb();
  db.prepare(`UPDATE override_follow_ups SET response = ? WHERE id = ?`).run(text, followUpId);
  await sendTelegram('Got it. Noted.');
  console.log(`[Checkin] Override follow-up ${followUpId} response recorded: "${text}"`);
}
