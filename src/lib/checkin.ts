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
import { buildPersonalizationSnapshot } from './personalization-context';
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

  const adaptiveQuestion = getAdaptiveCheckinQuestion('morning_checkin');
  let message = adaptiveQuestion
    ? `Good morning. ${adaptiveQuestion.question}`
    : `Good morning. What's your one commitment today?\n\nAnd honestly — how likely are you to actually do it, 1–10?`;

  try {
    const intelligenceContext = getIntelligenceContext({ maxInsights: 2, includeToday: true });
    const ai = getGenAI();
    if (ai) {
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: `Generate a personalized morning check-in message for this user. Be direct, specific, and brief. Reference their actual goals, patterns, or yesterday's outcomes if relevant. Maximum 45 words. End with the adaptive question below, preserving its intent.

Adaptive question to ask because ${adaptiveQuestion?.reason ?? 'the model needs a fresh daily anchor'}:
${adaptiveQuestion?.question ?? 'What is your one commitment today, and how likely are you to do it from 1-10?'}

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

  const adaptiveQuestion = getAdaptiveCheckinQuestion('evening_checkin');
  const message = [
    `End-of-day check-in. Answer honestly.\n`,
    `1. <b>What did you avoid today</b>, and what's the honest reason — not the reason you'd tell someone else, the actual reason?`,
    `2. <b>What happened today</b> that affected your mood, energy, or focus?`,
    `3. <b>What time are you sleeping tonight</b>, and what time should I assume you'll wake up?`,
    `4. <b>What do you want to do tomorrow</b>, and how much time should it get?`,
    `5. <b>${adaptiveQuestion?.question ?? 'How do you feel about showing up tomorrow, 1–10?'}</b>`,
    `6. <b>How do you feel about showing up tomorrow, 1–10?</b> Why that number?`,
    `\nVoice note or text — doesn't matter.`,
  ].join('\n');

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
      const extractPrompt = `Extract from this evening check-in. Return JSON only, no markdown.

Response: "${text}"

Return: {
  "sleepTime": "HH:MM in 24h format, or null if not mentioned",
  "wakeEstimate": "HH:MM in 24h format — derive as sleepTime + 8h if not stated, or null",
  "tomorrowIntention": "what they plan to do tomorrow in one phrase, or null"
}

Examples:
- "sleeping at 1am" → sleepTime: "01:00", wakeEstimate: "09:00"
- "bed by midnight" → sleepTime: "00:00", wakeEstimate: "08:00"
- "want to finish module 3" → tomorrowIntention: "finish module 3"
If nothing relevant, return nulls.`;

      const ai = getGenAI();
      if (!ai) throw new Error('No AI client');
      const result = await generateWithFallback(ai, {
        model: MODEL_FLASH,
        contents: extractPrompt,
        config: { temperature: 0.1, maxOutputTokens: 200 },
      });
      const raw = result.text ?? '';
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const extracted = JSON.parse(cleaned) as { sleepTime: string | null; wakeEstimate: string | null; tomorrowIntention: string | null };

      if (extracted.sleepTime || extracted.tomorrowIntention) {
        db.prepare(`
          UPDATE daily_checkins
          SET sleep_time = COALESCE(?, sleep_time),
              wake_estimate = COALESCE(?, wake_estimate),
              tomorrow_intention = COALESCE(?, tomorrow_intention)
          WHERE checkin_date = ? AND checkin_type = 'evening'
        `).run(
          extracted.sleepTime ?? null,
          extracted.wakeEstimate ?? null,
          extracted.tomorrowIntention ?? null,
          today
        );
        await generateNextDayPlan({
          planDate: resolvePlanDateFromEveningCheckin({
            checkinDate: today,
            sleepTime: extracted.sleepTime,
          }),
          sleepTime: extracted.sleepTime,
          wakeEstimate: extracted.wakeEstimate,
          tomorrowIntention: extracted.tomorrowIntention,
          eveningNotes: text,
          syncCalendar: false,
        });
        console.log(`[Checkin] Sleep/wake extracted — sleep: ${extracted.sleepTime}, wake: ${extracted.wakeEstimate}, intention: ${extracted.tomorrowIntention}`);
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
