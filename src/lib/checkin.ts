// src/lib/checkin.ts
// Check-in pipeline: morning questions, evening reflection, response parsing, memory extraction

import { getDb, setSetting, getSetting } from './db';
import { sendTelegram } from './telegram';
import { extractMemoryFromCheckin } from './memory-extractor';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';

// ─── State Keys (stored in settings table) ──────────────────────────────────

export const PENDING_CHECKIN_KEY = 'pending_checkin_type'; // 'morning' | 'evening' | ''
export const PENDING_CHECKIN_DATE_KEY = 'pending_checkin_date'; // ISO date string

// ─── Send Functions ──────────────────────────────────────────────────────────

export async function sendMorningCheckin(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // Don't send if already sent today
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM daily_checkins WHERE checkin_date = ? AND checkin_type = 'morning'"
  ).get(today) as { id: number } | undefined;
  if (existing) {
    console.log('[Checkin] Morning check-in already sent today, skipping.');
    return;
  }

  const message = `Good morning. What's your one commitment today?\n\nAnd honestly — how likely are you to actually do it, 1–10?`;
  const sent = await sendTelegram(message, 'HTML');
  if (sent) {
    setSetting(PENDING_CHECKIN_KEY, 'morning');
    setSetting(PENDING_CHECKIN_DATE_KEY, today);
    console.log('[Checkin] Morning check-in sent.');
  }
}

export async function sendEveningReflection(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // Don't send if already sent today
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM daily_checkins WHERE checkin_date = ? AND checkin_type = 'evening'"
  ).get(today) as { id: number } | undefined;
  if (existing) {
    console.log('[Checkin] Evening reflection already sent today, skipping.');
    return;
  }

  const message = [
    `End-of-day check-in. Answer honestly.\n`,
    `1. <b>What did you avoid today</b>, and what's the honest reason — not the reason you'd tell someone else, the actual reason?`,
    `2. <b>What are you postponing</b> that you keep telling yourself is for tomorrow?`,
    `3. <b>How do you feel about showing up tomorrow, 1–10?</b> Why that number?`,
    `4. <b>What time are you sleeping tonight</b>, and what's the one thing you want to accomplish tomorrow?`,
    `\nVoice note or text — doesn't matter.`,
  ].join('\n');

  const sent = await sendTelegram(message, 'HTML');
  if (sent) {
    setSetting(PENDING_CHECKIN_KEY, 'evening');
    setSetting(PENDING_CHECKIN_DATE_KEY, today);
    console.log('[Checkin] Evening reflection sent.');
  }
}

// ─── Response Handlers ───────────────────────────────────────────────────────

export async function handleMorningCheckinResponse(text: string): Promise<void> {
  const today = getSetting(PENDING_CHECKIN_DATE_KEY) || new Date().toISOString().slice(0, 10);

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

  // Respond based on likelihood score
  let response: string;
  if (likelihoodScore !== null && likelihoodScore <= 4) {
    response = `You said ${likelihoodScore}/10. Let's make it stupidly small. One tab open, 20 minutes, that's it. What time are you starting?`;
  } else if (likelihoodScore !== null && likelihoodScore >= 8) {
    response = `${likelihoodScore}/10. Good. I'll hold you to it.`;
  } else {
    response = `Noted. I'll be watching.`;
  }

  await sendTelegram(response, 'HTML');

  // Extract memory in background
  void extractMemoryFromCheckin({ type: 'morning', commitment, likelihoodScore, rawTranscript: text, date: today });

  console.log(`[Checkin] Morning check-in recorded. Score: ${likelihoodScore}, commitment: ${commitment?.slice(0, 50)}`);
}

export async function handleEveningReflectionResponse(text: string): Promise<void> {
  const today = getSetting(PENDING_CHECKIN_DATE_KEY) || new Date().toISOString().slice(0, 10);

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

  // Simple acknowledgment
  await sendTelegram(`Got it. I'll think about what you said tonight.`, 'HTML');

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
  if (val === 'morning') return 'morning';
  if (val === 'evening') return 'evening';
  return null;
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
