# Phase D: Intelligence Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the delivery gap — the guardian synthesizes rich intelligence about Rohan but never delivers it directly to him. This phase makes the intelligence visible: UIL-powered session openers, post-session insight delivery, streak cliff detection on day 4, and a weekly reckoning every Sunday.

**Architecture:** Replace the 4-template `generateOpeningLine()` with a Gemini Flash call using `getIntelligenceContext()`. Add post-session insight delivery to `endGuardianSession()`. Add a day-4 streak cliff job to the scheduler. Add `weekly_reckonings` table and a Sunday 8pm reckoning job that builds the full-picture message from all data sources.

**Tech Stack:** TypeScript, `src/lib/intelligence.ts` (`getIntelligenceContext()`), `src/lib/longitudinal-engine.ts`, `src/lib/scheduler.ts`, Gemini Flash

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `src/lib/longitudinal-engine.ts` | Replace `generateOpeningLine()` with UIL-powered version |
| Modify | `src/lib/guardian-runtime.ts` | Add post-session insight delivery (after reflection) |
| Modify | `src/lib/db.ts` | Add `weekly_reckonings` table |
| Modify | `src/lib/scheduler.ts` | Add streak cliff detection + weekly reckoning + morning UIL synthesis |
| Create | `src/lib/weekly-reckoning.ts` | Build and send weekly reckoning message |

---

## Task 1: Add `weekly_reckonings` Table

**Files:**
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Add table DDL**

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_reckonings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      reckoning_text TEXT,
      open_question TEXT,
      response_text TEXT,
      response_received_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
```

- [ ] **Step 2: Verify**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
const t = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='weekly_reckonings'\").get();
console.log(t);
"
```

Expected: `{ name: 'weekly_reckonings' }`

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(db): add weekly_reckonings table"
```

---

## Task 2: Replace `generateOpeningLine()` with UIL-Powered Version

**Files:**
- Modify: `src/lib/longitudinal-engine.ts`

- [ ] **Step 1: Find and read the current `generateOpeningLine()` function**

```bash
grep -n "generateOpeningLine\|export function generateOpeningLine" src/lib/longitudinal-engine.ts
```

Read the function (note its line range) to understand the current signature and what it returns.

- [ ] **Step 2: Read what `getDayBriefing()` returns and how the function is called**

```bash
grep -n "generateOpeningLine" src/lib/guardian-runtime.ts
```

Note the call site: what arguments it passes and what it does with the result.

- [ ] **Step 3: Replace the function body**

Replace the existing `generateOpeningLine()` implementation with:

```typescript
export async function generateOpeningLine(
  briefing: Pick<DayBriefing, 'avgFocusScore' | 'energyForecast' | 'coachingStyle' | 'upcomingFocusTarget'>,
  intent: { durationMinutes?: number; topic?: string; mood?: 'high' | 'medium' | 'low' | null }
): Promise<string> {
  try {
    const { getIntelligenceContext } = await import('./intelligence');
    const context = getIntelligenceContext({ maxInsights: 2, includeToday: true });

    // Build today's morning check-in data if available
    const { getDb } = await import('./db');
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const morningCheckin = db.prepare(`
      SELECT commitment, likelihood_score FROM daily_checkins
      WHERE checkin_date = ? AND checkin_type = 'morning' LIMIT 1
    `).get(today) as { commitment: string; likelihood_score: number } | undefined;

    const morningLine = morningCheckin
      ? `Today's commitment: "${morningCheckin.commitment}" (likelihood: ${morningCheckin.likelihood_score}/10)`
      : '';

    const prompt = `Given this intelligence profile about this person:
${context}

${morningLine}

Write ONE sentence to open this guardian session on "${intent.topic || 'their task'}" for ${intent.durationMinutes || 30} minutes.

Rules:
- Be specific to what you know about this person — reference actual recent patterns, not generic motivation
- Do not use filler phrases like "Let's get started" or "You've got this"
- Speak like a coach who has been watching, not an app notification
- If they said something honest in their morning check-in, reference it
- If they have a pattern of avoiding this specific topic, name it directly
- If their energy is low, suggest something smaller
- Maximum 25 words
- Return ONLY the sentence, no quotes, no explanation`;

    const { generateContent } = await import('./ai');
    const result = await generateContent(prompt, { temperature: 0.7, maxOutputTokens: 60 });

    if (result && result.trim().length > 0) {
      return result.trim().replace(/^["']|["']$/g, ''); // Strip quotes if model adds them
    }
  } catch (err) {
    console.error('[LongitudinalEngine] generateOpeningLine failed, using fallback:', err);
  }

  // Fallback to original template logic
  const { durationMinutes, topic, mood } = intent;
  const { energyForecast, coachingStyle, avgFocusScore } = briefing;

  if (mood === 'low' || energyForecast === 'low') {
    return `Energy is lower today. Keep it simple: ${durationMinutes} minutes on ${topic}.`;
  }
  if (coachingStyle === 'direct') {
    return `Starting ${durationMinutes} minutes on ${topic}. Recent average focus is ${Math.round(avgFocusScore || 74)}. Beat it.`;
  }
  return `Starting ${durationMinutes} minute focus block on ${topic}. Your recent sessions averaged ${Math.round(avgFocusScore || 74)}.`;
}
```

- [ ] **Step 4: Update call site in `guardian-runtime.ts`**

```bash
grep -n "generateOpeningLine\|openingLine\|openingMessage" src/lib/guardian-runtime.ts | head -10
```

If the call site does `const line = generateOpeningLine(briefing, intent)` (synchronous), update it to `const line = await generateOpeningLine(briefing, intent)`. The surrounding function should already be `async`.

- [ ] **Step 5: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep -E "longitudinal|guardian-runtime" | head -10
```

Expected: no errors

- [ ] **Step 6: Manual test — start a session and verify opening line**

Start a guardian session via Telegram or API. Check the TTS output and Telegram message.

Expected: the opening line references a specific pattern (e.g., "You've been avoiding ML assignment. 25 minutes — open it, read the section that confused you, write one question.") instead of a generic template.

- [ ] **Step 7: Commit**

```bash
git add src/lib/longitudinal-engine.ts src/lib/guardian-runtime.ts
git commit -m "feat(intelligence): replace generateOpeningLine() template with UIL-powered personalized opener"
```

---

## Task 3: Add Post-Session Insight Delivery

After every session ends, alongside the reflection, send the top 2 coaching insights and goal momentum changes to Telegram.

**Files:**
- Modify: `src/lib/guardian-runtime.ts`

- [ ] **Step 1: Find `endGuardianSession()` and where reflection is sent**

```bash
grep -n "endGuardianSession\|sendTelegram.*reflection\|formatSessionEnd\|reflection_text" src/lib/guardian-runtime.ts | head -15
```

Find the block that calls `sendTelegram` with `formatSessionEnd(...)`. Note the line number.

- [ ] **Step 2: Add insight delivery after the session end Telegram message**

After the existing `sendTelegram(formatSessionEnd(...))` call, add:

```typescript
    // Post-session insight delivery — top insights from UIL profile
    void (async () => {
      try {
        const { getIntelligenceProfile } = await import('./intelligence');
        const profile = getIntelligenceProfile();

        const insights: string[] = [];

        // Top 2 coaching insights
        if (profile.coachingInsights && profile.coachingInsights.length > 0) {
          const topInsights = profile.coachingInsights.slice(0, 2);
          insights.push(...topInsights.map(i => `💡 ${i}`));
        }

        // Goal momentum changes
        if (profile.goalMomentum) {
          for (const [goal, momentum] of Object.entries(profile.goalMomentum)) {
            if (momentum === 'at_risk') {
              insights.push(`⚠️ <b>${goal}</b> is at risk — low momentum`);
            } else if (momentum === 'gaining') {
              insights.push(`📈 <b>${goal}</b> — momentum building`);
            }
          }
        }

        // Avoidance patterns detected this session
        if (session.avoidancePatternsDetected && session.avoidancePatternsDetected.length > 0) {
          insights.push(`👀 Pattern: ${session.avoidancePatternsDetected[0]}`);
        }

        if (insights.length > 0) {
          const msg = insights.slice(0, 3).join('\n');
          await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay after session end
          await sendTelegram(msg, 'HTML');
        }
      } catch (err) {
        console.error('[Guardian] Post-session insight delivery failed:', err);
      }
    })();
```

Note: `session.avoidancePatternsDetected` may not exist on `GuardianState`. If it doesn't, skip that line. Check the type:

```bash
grep -n "avoidancePattern\|GuardianState" src/lib/guardian-types.ts | head -10
```

If the field doesn't exist, remove that block.

- [ ] **Step 3: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "guardian-runtime" | head -10
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/guardian-runtime.ts
git commit -m "feat(intelligence): add post-session insight delivery to Telegram (coaching insights + goal momentum)"
```

---

## Task 4: Create `src/lib/weekly-reckoning.ts`

**Files:**
- Create: `src/lib/weekly-reckoning.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/weekly-reckoning.ts
// Sunday evening weekly reckoning: honest data summary + one non-negotiable question

import { getDb, setSetting, getSetting } from './db';
import { sendTelegram } from './telegram';
import { getIntelligenceContext } from './intelligence';

export async function sendWeeklyReckoning(): Promise<void> {
  try {
    const db = getDb();
    const now = new Date();

    // Week start = last Monday
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now.getTime() - daysToMonday * 86400000).toISOString().slice(0, 10);
    const weekEnd = now.toISOString().slice(0, 10);

    // ── Pull raw data ────────────────────────────────────────────────────────

    // Sessions this week
    const sessions = db.prepare(`
      SELECT target_title, elapsed_minutes, average_focus_score, completed_at
      FROM guardian_session_summaries
      WHERE date(completed_at) >= ?
      ORDER BY completed_at ASC
    `).all(weekStart) as Array<{ target_title: string; elapsed_minutes: number; average_focus_score: number; completed_at: string }>;

    // Days laptop was opened (from screen observations)
    const laptopDays = (db.prepare(`
      SELECT COUNT(DISTINCT date(observed_at)) as count
      FROM screen_observations
      WHERE date(observed_at) >= ? AND date(observed_at) <= ?
    `).get(weekStart, weekEnd) as { count: number }).count;

    // Average first-open time
    const firstOpens = db.prepare(`
      SELECT date(observed_at) as day, MIN(time(observed_at)) as first_open
      FROM screen_observations
      WHERE date(observed_at) >= ? AND date(observed_at) <= ?
      AND source IN ('screenshot','daemon')
      GROUP BY day
    `).all(weekStart, weekEnd) as Array<{ day: string; first_open: string }>;

    const avgFirstOpenHour = firstOpens.length > 0
      ? firstOpens.reduce((sum, r) => sum + parseInt(r.first_open.slice(0, 2)), 0) / firstOpens.length
      : null;

    // Screen time categories this week
    const screenCats = db.prepare(`
      SELECT category, ROUND(SUM(duration_seconds)/3600.0, 1) as hours
      FROM activities
      WHERE date(started_at) >= ?
      GROUP BY category
      ORDER BY hours DESC
    `).all(weekStart) as Array<{ category: string; hours: number }>;

    // Phone screen time (Instagram total)
    const phoneST = db.prepare(`
      SELECT
        COALESCE(SUM(instagram_minutes), 0) as instagram_total,
        COALESCE(SUM(total_minutes), 0) as phone_total,
        COALESCE(AVG(pickup_count), 0) as avg_pickups
      FROM phone_screen_time
      WHERE report_date >= ? AND report_type = 'evening'
    `).get(weekStart) as { instagram_total: number; phone_total: number; avg_pickups: number };

    // Goal progress
    const goals = db.prepare(`
      SELECT title, health_status, progress_percentage
      FROM goals WHERE status = 'active' LIMIT 8
    `).all() as Array<{ title: string; health_status: string; progress_percentage: number }>;

    // Last week's open question (if any) — check if it was answered
    const lastReckoning = db.prepare(`
      SELECT open_question, response_text FROM weekly_reckonings
      ORDER BY created_at DESC LIMIT 1
    `).get() as { open_question: string; response_text: string | null } | undefined;

    // Evening reflections this week
    const reflections = db.prepare(`
      SELECT raw_transcript FROM daily_checkins
      WHERE checkin_date >= ? AND checkin_type = 'evening'
      ORDER BY checkin_date DESC LIMIT 7
    `).all(weekStart) as Array<{ raw_transcript: string }>;

    // ── Build data context for Gemini ────────────────────────────────────────

    const sessionsByTopic: Record<string, { sessions: number; totalMins: number; avgScore: number }> = {};
    for (const s of sessions) {
      const key = s.target_title;
      if (!sessionsByTopic[key]) sessionsByTopic[key] = { sessions: 0, totalMins: 0, avgScore: 0 };
      sessionsByTopic[key].sessions++;
      sessionsByTopic[key].totalMins += s.elapsed_minutes;
      sessionsByTopic[key].avgScore = Math.round((sessionsByTopic[key].avgScore * (sessionsByTopic[key].sessions - 1) + s.average_focus_score) / sessionsByTopic[key].sessions);
    }

    const deepWorkHours = screenCats.find(c => c.category === 'deep_work')?.hours || 0;
    const distractionHours = screenCats.find(c => c.category === 'distraction')?.hours || 0;

    const dataContext = [
      `WEEK: ${weekStart} to ${weekEnd}`,
      ``,
      `LAPTOP:`,
      `- Opened: ${laptopDays}/7 days`,
      avgFirstOpenHour ? `- Average first-open time: ${Math.floor(avgFirstOpenHour)}:${String(Math.round((avgFirstOpenHour % 1) * 60)).padStart(2, '0')} (peak window starts 9am)` : '',
      `- Deep work hours: ${deepWorkHours}h`,
      `- Distraction hours: ${distractionHours}h`,
      ``,
      `PHONE:`,
      phoneST.phone_total > 0 ? `- Instagram total: ${Math.round(phoneST.instagram_total)}m (${(phoneST.instagram_total / 7 / 60).toFixed(1)}h/day avg)` : '- No phone data this week',
      phoneST.avg_pickups > 0 ? `- Average pickups: ${Math.round(phoneST.avg_pickups)}/day` : '',
      ``,
      `GOALS:`,
      ...goals.map(g => {
        const icon = g.health_status === 'on_track' ? '✓' : g.health_status === 'at_risk' ? '⚠' : '✗';
        const topicSessions = sessionsByTopic[g.title];
        const sessionNote = topicSessions ? `, ${topicSessions.sessions} sessions` : ', 0 sessions';
        return `${icon} ${g.title}${sessionNote}`;
      }),
      ``,
      `SESSIONS THIS WEEK:`,
      ...Object.entries(sessionsByTopic).map(([topic, data]) =>
        `- ${topic}: ${data.sessions} sessions, ${data.totalMins}m total, avg score ${data.avgScore}`
      ),
      ``,
      `EVENING REFLECTIONS (excerpts):`,
      ...reflections.slice(0, 3).map(r => `"${r.raw_transcript?.slice(0, 150) || '(none)'}"`),
      ``,
      lastReckoning?.open_question ? `LAST WEEK'S OPEN QUESTION: "${lastReckoning.open_question}"` : '',
      lastReckoning?.response_text ? `ANSWER RECEIVED: "${lastReckoning.response_text?.slice(0, 200)}"` : lastReckoning?.open_question ? 'NO ANSWER RECEIVED.' : '',
    ].filter(Boolean).join('\n');

    const intelligenceContext = getIntelligenceContext({ maxInsights: 2 });

    // ── Generate reckoning with Gemini ───────────────────────────────────────

    const prompt = `You are Rohan's personal guardian writing his weekly reckoning. Be honest. Be specific. Use actual data.

Intelligence profile:
${intelligenceContext}

This week's data:
${dataContext}

Write the weekly reckoning in this EXACT format (no deviations):

WEEK OF [date range]

REALITY:
[4-6 bullet points of the hardest, most specific facts from the data. No softening. Numbers only.]

GOALS:
[one line per active goal with ✓/✗ and one specific observation]

PATTERN THIS WEEK:
[2-3 sentences identifying the most important behavioral pattern — must reference specific days, times, or events from the data]

ONE QUESTION I'M NOT MOVING ON FROM:
[One direct question about the most important unresolved pattern or avoidance. Make it specific enough that it requires a real answer, not a general one. This is the question you will follow up on next week if unanswered.]

Keep total length under 400 words. No filler. No encouragement. Facts and one honest question.`;

    const { generateContent } = await import('./ai');
    const reckoningText = await generateContent(prompt, { temperature: 0.3, maxOutputTokens: 600 });

    if (!reckoningText) {
      console.error('[WeeklyReckoning] generateContent returned null');
      return;
    }

    // Extract the open question
    const questionMatch = reckoningText.match(/ONE QUESTION.*?\n([\s\S]+?)(?:\n\n|\n\[|$)/i);
    const openQuestion = questionMatch ? questionMatch[1].trim() : null;

    // Store in DB
    db.prepare(`
      INSERT INTO weekly_reckonings (week_start, reckoning_text, open_question)
      VALUES (?, ?, ?)
    `).run(weekStart, reckoningText, openQuestion);

    // Store pending state to capture Rohan's response
    setSetting('pending_weekly_reckoning', 'true');
    setSetting('pending_weekly_reckoning_date', weekStart);

    // Send to Telegram
    await sendTelegram(reckoningText, '');

    console.log(`[WeeklyReckoning] Sent for week of ${weekStart}`);

  } catch (err) {
    console.error('[WeeklyReckoning] sendWeeklyReckoning failed:', err);
  }
}

/**
 * Handle a response to the weekly reckoning open question.
 */
export async function handleWeeklyReckoningResponse(text: string): Promise<void> {
  const db = getDb();

  const lastReckoning = db.prepare(`
    SELECT id, open_question FROM weekly_reckonings
    WHERE response_text IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get() as { id: number; open_question: string } | undefined;

  if (!lastReckoning) return;

  db.prepare(`
    UPDATE weekly_reckonings SET response_text = ?, response_received_at = datetime('now','localtime')
    WHERE id = ?
  `).run(text, lastReckoning.id);

  setSetting('pending_weekly_reckoning', '');

  await sendTelegram(`Recorded. I'll hold the thread.`, 'HTML');

  // Fire memory extraction on the response
  const { extractMemoryFromCheckin } = await import('./memory-extractor');
  void extractMemoryFromCheckin({
    type: 'evening',
    date: new Date().toISOString().slice(0, 10),
    rawTranscript: `Weekly reckoning response: ${text}`,
  });
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "weekly-reckoning" | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/weekly-reckoning.ts
git commit -m "feat(reckoning): add weekly reckoning generation with Gemini + open question tracking"
```

---

## Task 5: Wire Weekly Reckoning Response in Webhook

**Files:**
- Modify: `src/app/api/telegram/webhook/route.ts`

- [ ] **Step 1: Add import**

```typescript
import { handleWeeklyReckoningResponse } from '@/lib/weekly-reckoning';
```

- [ ] **Step 2: Add reckoning response detection**

In the message handler, add BEFORE the check-in state check:

```typescript
            // Weekly reckoning response
            if (getSetting('pending_weekly_reckoning') === 'true') {
                await handleWeeklyReckoningResponse(text);
                return NextResponse.json({ ok: true });
            }
```

- [ ] **Step 3: Compile check and commit**

```bash
npx tsc --noEmit 2>&1 | grep "webhook" | head -5
git add src/app/api/telegram/webhook/route.ts
git commit -m "feat(telegram): route incoming text to weekly reckoning response handler"
```

---

## Task 6: Add Intelligence Jobs to Scheduler

**Files:**
- Modify: `src/lib/scheduler.ts`

- [ ] **Step 1: Add imports**

```typescript
import { sendWeeklyReckoning } from './weekly-reckoning';
```

- [ ] **Step 2: Add morning UIL synthesis (7:30am)**

In `initScheduler()`, add before the existing jobs:

```typescript
    // Morning UIL synthesis — before Rohan picks up his phone
    registerDailyJob('morning_uil_synthesis', '07:30', async () => {
        await forceSynthesis('morning_7:30');
        console.log('[Scheduler] Morning UIL synthesis complete');
    });
```

- [ ] **Step 3: Add streak cliff detection (day 4, evening)**

```typescript
    // Streak cliff detection — day 4 of strong streak, fire at 20:00
    registerDailyJob('streak_cliff_detection', '20:00', async () => {
        try {
            const db = getDb();

            // Count consecutive days with sessions in last 7 days
            const sessionDays = db.prepare(`
                SELECT DISTINCT date(completed_at) as day
                FROM guardian_session_summaries
                WHERE completed_at >= datetime('now', '-7 days')
                ORDER BY day DESC
            `).all() as Array<{ day: string }>;

            let streak = 0;
            const todayStr = new Date().toISOString().slice(0, 10);
            for (let i = 0; i < sessionDays.length; i++) {
                const expected = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
                if (sessionDays[i]?.day === expected) {
                    streak++;
                } else {
                    break;
                }
            }

            // Only fire on exactly day 4
            if (streak === 4) {
                // Don't send if already sent today for streak cliff
                const today = todayStr;
                const alreadySent = getSetting('streak_cliff_sent_date') === today;
                if (!alreadySent) {
                    await sendTelegram(
                        `You're on day 4. Your strongest stretches look exactly like this. Tomorrow is historically when the slide starts — not because you decide to stop, but because you find reasons. What's the plan for tomorrow morning specifically? Not in general. The first 30 minutes.`,
                        'HTML'
                    );
                    setSetting('streak_cliff_sent_date', today);
                }
            }
        } catch (err) {
            console.error('[Scheduler] streak_cliff_detection failed:', err);
        }
    });
```

- [ ] **Step 4: Add weekly reckoning job (Sunday 20:00)**

Find the existing `weekly_review` job (line ~181) and update it to also send the reckoning:

```typescript
    // Weekly reckoning — Sunday at 20:00
    registerDailyJob('weekly_reckoning', '20:00', async () => {
        const dayOfWeek = new Date().getDay(); // 0 = Sunday
        if (dayOfWeek !== 0) return; // Only run on Sundays

        // Don't send if streak cliff also fired today (both at 20:00 — avoid double message)
        await sendWeeklyReckoning();
    });
```

Note: The existing `weekly_review` job at 21:00 fires the weekly email. The new `weekly_reckoning` at 20:00 fires the Telegram reckoning. These are separate.

- [ ] **Step 5: Add `getSetting` and `setSetting` imports if needed**

```bash
grep -n "import.*getSetting\|import.*setSetting" src/lib/scheduler.ts | head -5
```

If not imported, add to the existing db import.

- [ ] **Step 6: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "scheduler" | head -10
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduler.ts
git commit -m "feat(scheduler): add morning UIL synthesis, streak cliff detection (day 4), weekly reckoning (Sunday 20:00)"
```

---

## Task 7: End-to-End Verification

- [ ] **Step 1: Test UIL-powered opening line**

Start a session and check the Telegram session start message and TTS output.

Expected: opening line references actual data from the profile (recent sessions, commitment, patterns) — not a template.

If it falls back to template, check:
```bash
node -e "
const { getIntelligenceContext } = require('./src/lib/intelligence');
console.log(getIntelligenceContext({ maxInsights: 2, includeToday: true }).slice(0, 500));
"
```

The profile needs at least some data to be non-generic.

- [ ] **Step 2: Test post-session insight delivery**

End a session. Wait 3 seconds. Check Telegram for insight message.

Expected: message with 1-3 `💡` insights or `⚠️` goal momentum alerts.

If no insights appear, check `getIntelligenceProfile().coachingInsights` has data.

- [ ] **Step 3: Test weekly reckoning generation**

Trigger manually:

```bash
node -e "
const { sendWeeklyReckoning } = require('./src/lib/weekly-reckoning');
sendWeeklyReckoning().then(() => {
  const Database = require('better-sqlite3');
  const db = new Database('lifeos.db');
  console.log(db.prepare('SELECT id, week_start, open_question FROM weekly_reckonings ORDER BY id DESC LIMIT 1').get());
  process.exit(0);
});
"
```

Expected: Telegram receives the WEEK OF / REALITY / GOALS / PATTERN / ONE QUESTION format. DB has a row in `weekly_reckonings`.

- [ ] **Step 4: Test weekly reckoning response**

Reply to the reckoning in Telegram. Check DB:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
console.log(db.prepare('SELECT response_text, response_received_at FROM weekly_reckonings ORDER BY id DESC LIMIT 1').get());
"
```

Expected: `response_text` populated.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat(phase-d): complete intelligence delivery — UIL opener, post-session insights, streak cliff, weekly reckoning"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `generateOpeningLine()` replaced with UIL-powered version using `getIntelligenceContext()`
- ✅ Falls back to templates if Gemini call fails
- ✅ Morning check-in commitment injected into opening line prompt
- ✅ Post-session insight delivery: top 2 coaching insights + goal momentum
- ✅ Streak cliff detection fires on day 4 at 20:00 with exact message from spec
- ✅ Weekly reckoning sent Sunday 20:00 with REALITY/GOALS/PATTERN/ONE QUESTION format
- ✅ `weekly_reckonings` table stores reckoning text + open question
- ✅ Response to open question is captured and triggers memory extraction
- ✅ Morning UIL synthesis at 7:30am
- ✅ Guardian holds the thread: previous week's unanswered question is passed to Gemini prompt

**What's deferred:**
- Mid-day distraction detection UIL synthesis trigger (requires Phase B screenshot data)
- Post-weekly-response synthesis trigger (add `forceSynthesis('weekly_response')` in `handleWeeklyReckoningResponse`)
- Monthly pattern letter (Phase E)
