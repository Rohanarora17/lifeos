# Phase A: Inside-Out Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the subjective data layer — morning check-ins, evening reflections, and post-override follow-ups — so the guardian knows what Rohan thinks about what he does, not just what he does.

**Architecture:** New DB tables (`daily_checkins`) store structured check-in data. The scheduler fires Telegram messages at 8am and 9:30pm. A pending-state flag in the `settings` table lets the webhook router know when an incoming message is a check-in response vs. a regular command. Memory extractor processes check-in answers into `mem_facts`.

**Tech Stack:** TypeScript, Next.js API routes, SQLite (better-sqlite3), Telegram Bot API, Gemini Flash (`src/lib/ai.ts`)

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `src/lib/db.ts` | Add `daily_checkins` table DDL |
| Modify | `src/lib/scheduler.ts` | Add morning check-in (08:00) and evening reflection (21:30) jobs |
| Modify | `src/app/api/telegram/webhook/route.ts` | Route incoming text to check-in handler when state flag is set |
| Create | `src/lib/checkin.ts` | All check-in logic: send questions, parse response, save to DB, extract memory |
| Modify | `src/lib/memory-extractor.ts` | Add `extractMemoryFromCheckin()` function |
| Modify | `src/lib/guardian-runtime.ts` | On override approval, write `override_follow_up_at` to DB |
| Modify | `src/lib/db.ts` | Add `override_follow_ups` table |
| Modify | `src/lib/scheduler.ts` | Add 5-min interval job that checks for due override follow-ups |

---

## Task 1: Add `daily_checkins` and `override_follow_ups` DB Tables

**Files:**
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Find the last table definition in db.ts**

```bash
grep -n "CREATE TABLE IF NOT EXISTS" src/lib/db.ts | tail -5
```

Expected: shows lines near end of file. Note the line number of the last table.

- [ ] **Step 2: Add `daily_checkins` table after the last existing table**

Find the section in `src/lib/db.ts` where tables are created and add:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_date TEXT NOT NULL,
      checkin_type TEXT NOT NULL CHECK(checkin_type IN ('morning','evening')),
      commitment TEXT,
      likelihood_score INTEGER,
      avoidance_honest TEXT,
      postponed_item TEXT,
      tomorrow_score INTEGER,
      tomorrow_reason TEXT,
      raw_transcript TEXT,
      memory_extracted INTEGER DEFAULT 0,
      received_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS override_follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      override_url TEXT NOT NULL,
      override_reason TEXT,
      follow_up_at TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      response TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
```

- [ ] **Step 3: Verify tables exist after server restart**

```bash
cd /Users/rohan/.gemini/antigravity/scratch/lifeos && node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_checkins','override_follow_ups')\").all();
console.log(tables);
"
```

Expected: `[ { name: 'daily_checkins' }, { name: 'override_follow_ups' } ]`

- [ ] **Step 4: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(db): add daily_checkins and override_follow_ups tables"
```

---

## Task 2: Create `src/lib/checkin.ts`

This file owns all check-in logic: sending questions, parsing responses, and saving to DB.

**Files:**
- Create: `src/lib/checkin.ts`

- [ ] **Step 1: Create the file with sending functions**

```typescript
// src/lib/checkin.ts
// Check-in pipeline: morning questions, evening reflection, response parsing, memory extraction

import { getDb, setSetting, getSetting } from './db';
import { sendTelegram } from './telegram';
import { extractMemoryFromCheckin } from './memory-extractor';

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
    `Three questions. Answer honestly.\n`,
    `1. <b>What did you avoid today</b>, and what's the honest reason — not the reason you'd tell someone else, the actual reason?`,
    `2. <b>What are you postponing</b> that you keep telling yourself is for tomorrow?`,
    `3. <b>How do you feel about showing up tomorrow, 1–10?</b> Why that number?`,
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

  // The rest is the commitment (text minus the number)
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

  // Simple acknowledgment — the real response comes from memory extraction
  await sendTelegram(`Got it. I'll think about what you said tonight.`, 'HTML');

  // Deep analysis: run memory extraction with full day context
  void extractMemoryFromCheckin({ type: 'evening', rawTranscript: text, tomorrowScore, date: today });

  console.log(`[Checkin] Evening reflection recorded. Tomorrow score: ${tomorrowScore}`);
}

// ─── State Check ─────────────────────────────────────────────────────────────

export function getPendingCheckinType(): 'morning' | 'evening' | null {
  const val = getSetting(PENDING_CHECKIN_KEY);
  if (val === 'morning') return 'morning';
  if (val === 'evening') return 'evening';
  return null;
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd /Users/rohan/.gemini/antigravity/scratch/lifeos && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (or only unrelated pre-existing errors)

- [ ] **Step 3: Commit**

```bash
git add src/lib/checkin.ts
git commit -m "feat(checkin): add morning and evening check-in send/handle functions"
```

---

## Task 3: Add `extractMemoryFromCheckin()` to `memory-extractor.ts`

**Files:**
- Modify: `src/lib/memory-extractor.ts`

- [ ] **Step 1: Read the end of memory-extractor.ts to find insertion point**

```bash
tail -30 src/lib/memory-extractor.ts
```

Note the last exported function and its closing brace.

- [ ] **Step 2: Add `extractMemoryFromCheckin()` at the end of the file**

Append to `src/lib/memory-extractor.ts`:

```typescript
// ─── Check-in Memory Extraction ─────────────────────────────────────────────

interface CheckinData {
  type: 'morning' | 'evening';
  date: string;
  commitment?: string | null;
  likelihoodScore?: number | null;
  rawTranscript: string;
  tomorrowScore?: number | null;
}

export async function extractMemoryFromCheckin(checkin: CheckinData): Promise<void> {
  try {
    const db = getDb();

    // For evening reflections: pull today's behavioral data to cross-reference
    let behavioralContext = '';
    if (checkin.type === 'evening') {
      const todayStart = `${checkin.date} 00:00:00`;
      const todayEnd = `${checkin.date} 23:59:59`;

      const sessions = db.prepare(`
        SELECT target_title, elapsed_minutes, average_focus_score, blocked_count
        FROM guardian_session_summaries
        WHERE completed_at BETWEEN ? AND ?
        ORDER BY completed_at DESC
        LIMIT 5
      `).all(todayStart, todayEnd) as Array<{ target_title: string; elapsed_minutes: number; average_focus_score: number; blocked_count: number }>;

      const screenCats = db.prepare(`
        SELECT category, COUNT(*) as count, ROUND(SUM(duration_seconds)/3600.0, 1) as hours
        FROM activities
        WHERE started_at BETWEEN ? AND ?
        GROUP BY category
        ORDER BY hours DESC
      `).all(todayStart, todayEnd) as Array<{ category: string; count: number; hours: number }>;

      const morningCheckin = db.prepare(`
        SELECT commitment, likelihood_score
        FROM daily_checkins
        WHERE checkin_date = ? AND checkin_type = 'morning'
        LIMIT 1
      `).get(checkin.date) as { commitment: string; likelihood_score: number } | undefined;

      behavioralContext = [
        sessions.length > 0 ? `Sessions today: ${sessions.map(s => `${s.target_title} (${s.elapsed_minutes}m, score ${Math.round(s.average_focus_score)})`).join(', ')}` : 'No sessions today.',
        screenCats.length > 0 ? `Screen time: ${screenCats.map(c => `${c.category} ${c.hours}h`).join(', ')}` : '',
        morningCheckin ? `Morning commitment: "${morningCheckin.commitment}" (likelihood ${morningCheckin.likelihood_score}/10)` : '',
      ].filter(Boolean).join('\n');
    }

    const prompt = checkin.type === 'morning'
      ? `Extract memory facts from this morning check-in.

Morning commitment: "${checkin.commitment}"
Self-assessed likelihood: ${checkin.likelihoodScore}/10

Extract facts about:
1. What they plan to work on today
2. Their confidence level and what it signals
3. Any implicit avoidance patterns (low scores on recurring topics)

Return JSON array of memory operations:
[{"operation": "ADD"|"UPDATE"|"NOOP", "category": "goal"|"pattern"|"mood"|"habit", "topic": "string", "content": "string", "confidence": 0.0-1.0, "importance": 0.0-1.0}]`
      : `Extract memory facts from this evening reflection. Cross-reference with behavioral data.

Evening reflection:
"${checkin.rawTranscript}"

Today's behavioral data:
${behavioralContext}

This person has documented patterns:
- Strong 4-5 day streaks followed by sudden disengagement
- Avoiding complex topics when they get hard
- Deadline-driven work
- Starting many things, not finishing them

Analyze for:
1. Signs of the cliff pattern starting
2. Topics being rationalized as avoided
3. Gap between stated intent and actual behavior
4. Emotional state behind the words
5. What they're NOT saying that matters

Extract as memory operations AND determine if guardian response is needed tonight.

Return JSON:
{
  "operations": [{"operation": "ADD"|"UPDATE"|"NOOP"|"DELETE", "category": "goal"|"pattern"|"mood"|"habit"|"preference", "topic": "string", "content": "string", "confidence": 0.0-1.0, "importance": 0.0-1.0}],
  "guardian_response_needed": true|false,
  "response_text": "string or null"
}`;

    const { generateContent } = await import('./ai');
    const result = await generateContent(prompt, { temperature: 0.2, maxOutputTokens: 1000 });
    if (!result) return;

    const jsonStr = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    if (checkin.type === 'morning') {
      const ops = JSON.parse(jsonStr) as Array<{ operation: string; category: string; topic: string; content: string; confidence: number; importance: number }>;
      await applyMemoryOperations(ops, `checkin_morning_${checkin.date}`);
    } else {
      const parsed = JSON.parse(jsonStr) as {
        operations: Array<{ operation: string; category: string; topic: string; content: string; confidence: number; importance: number }>;
        guardian_response_needed: boolean;
        response_text: string | null;
      };
      await applyMemoryOperations(parsed.operations, `checkin_evening_${checkin.date}`);

      // Send guardian response if needed
      if (parsed.guardian_response_needed && parsed.response_text) {
        const { sendTelegram } = await import('./telegram');
        setTimeout(async () => {
          await sendTelegram(parsed.response_text!, 'HTML');
        }, 5 * 60 * 1000); // 5 minute delay — let Rohan settle before guardian speaks
      }
    }

    // Mark as extracted
    db.prepare(`
      UPDATE daily_checkins SET memory_extracted = 1
      WHERE checkin_date = ? AND checkin_type = ?
    `).run(checkin.date, checkin.type);

    console.log(`[MemoryExtractor] Check-in memory extracted: ${checkin.type} ${checkin.date}`);
  } catch (err) {
    console.error('[MemoryExtractor] extractMemoryFromCheckin failed:', err);
  }
}

// Helper: apply memory operations (reuses existing pattern from extractMemoryFromSession)
async function applyMemoryOperations(
  ops: Array<{ operation: string; category: string; topic: string; content: string; confidence: number; importance: number }>,
  sourceRef: string
): Promise<void> {
  const db = getDb();
  for (const op of ops) {
    if (op.operation === 'NOOP') continue;
    if (op.operation === 'ADD' || op.operation === 'UPDATE') {
      const existing = db.prepare(
        "SELECT id, confirmed_count FROM mem_facts WHERE topic = ? AND category = ? AND status != 'superseded'"
      ).get(op.topic, op.category) as { id: number; confirmed_count: number } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE mem_facts SET content = ?, confidence = ?, importance = ?, last_confirmed = datetime('now'), confirmed_count = confirmed_count + 1, status = 'active'
          WHERE id = ?
        `).run(op.content, op.confidence, op.importance, existing.id);
      } else {
        db.prepare(`
          INSERT INTO mem_facts (category, topic, content, confidence, importance, status, source, confirmed_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).run(op.category, op.topic, op.content, op.confidence, op.importance,
          op.confidence >= 0.8 ? 'active' : 'unverified', `checkin:${sourceRef}`);
      }
    } else if (op.operation === 'DELETE') {
      db.prepare("UPDATE mem_facts SET status = 'superseded' WHERE topic = ? AND category = ?")
        .run(op.topic, op.category);
    }
  }
}
```

- [ ] **Step 3: Check `generateContent` export exists in ai.ts**

```bash
grep -n "export.*generateContent\|export async function generateContent" src/lib/ai.ts | head -5
```

If it doesn't exist, find the actual function name used for Gemini calls and use that instead. Common alternatives: `callGemini`, `generateText`, or direct `model.generateContent`.

- [ ] **Step 4: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "memory-extractor" | head -10
```

Expected: no errors for memory-extractor.ts

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory-extractor.ts
git commit -m "feat(memory): add extractMemoryFromCheckin with evening behavioral cross-reference"
```

---

## Task 4: Wire Check-ins into Telegram Webhook

The webhook currently routes all text to `handleTelegramCommand()`. We need to intercept text when a check-in response is pending.

**Files:**
- Modify: `src/app/api/telegram/webhook/route.ts`

- [ ] **Step 1: Add import at top of webhook route**

Find the imports block (lines 1-20) and add:

```typescript
import { getPendingCheckinType, handleMorningCheckinResponse, handleEveningReflectionResponse } from '@/lib/checkin';
```

- [ ] **Step 2: Modify the message handler to check pending state**

Find this block (around line 43-52):

```typescript
        // Handle standard messages
        if (body.message?.text) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) {
                await sendTelegram('Sorry, I am a private LifeOS assistant.', 'HTML');
                return NextResponse.json({ ok: true });
            }
            await handleTelegramCommand(body.message.text);
            return NextResponse.json({ ok: true });
        }
```

Replace it with:

```typescript
        // Handle standard messages
        if (body.message?.text) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) {
                await sendTelegram('Sorry, I am a private LifeOS assistant.', 'HTML');
                return NextResponse.json({ ok: true });
            }

            // Check if we're awaiting a check-in response
            const pendingType = getPendingCheckinType();
            if (pendingType === 'morning') {
                await handleMorningCheckinResponse(body.message.text);
                return NextResponse.json({ ok: true });
            } else if (pendingType === 'evening') {
                await handleEveningReflectionResponse(body.message.text);
                return NextResponse.json({ ok: true });
            }

            await handleTelegramCommand(body.message.text);
            return NextResponse.json({ ok: true });
        }
```

- [ ] **Step 3: Also handle voice notes (optional for MVP — note for later)**

Voice notes come in as `body.message?.voice`. Add a comment to handle them in Phase A v2:

```typescript
        // TODO Phase A v2: handle voice notes for evening reflection
        // if (body.message?.voice && getPendingCheckinType() === 'evening') { ... }
```

- [ ] **Step 4: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "webhook" | head -10
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/app/api/telegram/webhook/route.ts
git commit -m "feat(telegram): route incoming text to check-in handlers when state is pending"
```

---

## Task 5: Add Scheduled Check-in Jobs to Scheduler

**Files:**
- Modify: `src/lib/scheduler.ts`

- [ ] **Step 1: Add import at top of scheduler.ts**

Find the imports block and add:

```typescript
import { sendMorningCheckin, sendEveningReflection } from './checkin';
```

- [ ] **Step 2: Register morning check-in job**

Find the existing `morning_brief` job registration (around line 44). Add AFTER the morning_brief block ends:

```typescript
    // Morning check-in — personal commitment + likelihood question
    registerDailyJob('morning_checkin', '08:00', async () => {
        await sendMorningCheckin();
    });
```

Note: This fires at 08:00 — same time as `morning_brief`. Both will fire. The check-in is a different message from the brief.

- [ ] **Step 3: Register evening reflection job**

Find the `daily_summary` job (around line 91). Add after it:

```typescript
    // Evening reflection — 3-question reflection after screen time report
    registerDailyJob('evening_reflection', '21:30', async () => {
        await sendEveningReflection();
    });
```

- [ ] **Step 4: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "scheduler" | head -10
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler.ts
git commit -m "feat(scheduler): add morning check-in (08:00) and evening reflection (21:30) jobs"
```

---

## Task 6: Post-Override Follow-Up (20 minutes after approval)

When an override is approved, schedule a follow-up Telegram question. Use the `override_follow_ups` table (created in Task 1) and a polling job in the scheduler.

**Files:**
- Modify: `src/lib/guardian-runtime.ts` (override approval section)
- Modify: `src/lib/scheduler.ts`

- [ ] **Step 1: Find the override approval code in guardian-runtime.ts**

```bash
grep -n "approved.*override\|override.*approved\|ActiveOverride\|ttlMinutes" src/lib/guardian-runtime.ts | head -10
```

Note the line where `approved: true` is set and the override TTL is applied.

- [ ] **Step 2: Add follow-up record after override approval**

Find the block that creates `ActiveOverride` (around line 1497-1519 in guardian-runtime.ts). After the override is stored, add:

```typescript
    // Schedule post-override follow-up (20 min after approval)
    try {
      const db = getDb();
      const followUpAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO override_follow_ups (session_id, override_url, override_reason, follow_up_at)
        VALUES (?, ?, ?, ?)
      `).run(session.sessionId, override.url, override.reason, followUpAt);
    } catch (err) {
      console.error('[Guardian] Failed to schedule override follow-up:', err);
    }
```

- [ ] **Step 3: Add `getDb` import if not already imported in guardian-runtime.ts**

```bash
grep -n "import.*getDb\|from.*db" src/lib/guardian-runtime.ts | head -5
```

If `getDb` isn't imported, add it to the existing db import line.

- [ ] **Step 4: Add override follow-up polling job in scheduler.ts**

In the `initScheduler` function, add a 5-minute interval job:

```typescript
    // Override follow-up check — polls every 5 minutes for due follow-ups
    registerIntervalJob('override_followup', 5 * 60 * 1000, async () => {
        try {
            const db = getDb();
            const due = db.prepare(`
                SELECT id, session_id, override_url, override_reason
                FROM override_follow_ups
                WHERE sent = 0 AND follow_up_at <= datetime('now','localtime')
                LIMIT 5
            `).all() as Array<{ id: number; session_id: string; override_url: string; override_reason: string }>;

            for (const followUp of due) {
                const url = new URL(followUp.override_url.startsWith('http') ? followUp.override_url : `https://${followUp.override_url}`);
                const domain = url.hostname.replace('www.', '');

                await sendTelegram(
                    `You overrode the block for <b>${domain}</b> 20 minutes ago.\n\nDid it actually serve your session, or did it spiral?`,
                    'HTML',
                    {
                        inline_keyboard: [[
                            { text: '✅ Helped', callback_data: `override_followup:helped:${followUp.id}` },
                            { text: '🌀 Spiraled', callback_data: `override_followup:spiraled:${followUp.id}` },
                            { text: '🤷 Mixed', callback_data: `override_followup:mixed:${followUp.id}` },
                        ]],
                    }
                );

                db.prepare(`UPDATE override_follow_ups SET sent = 1, sent_at = datetime('now','localtime') WHERE id = ?`)
                  .run(followUp.id);
            }
        } catch (err) {
            console.error('[Scheduler] override_followup failed:', err);
        }
    });
```

- [ ] **Step 5: Add override follow-up callback handler in webhook route**

In `src/app/api/telegram/webhook/route.ts`, in the `handleCallbackQuery` function, add:

```typescript
        } else if (type === 'override_followup') {
            await handleOverrideFollowupCallback(rest);
```

Then add the handler function near the other handlers:

```typescript
async function handleOverrideFollowupCallback(payload: string) {
    // payload: "helped:42" | "spiraled:42" | "mixed:42"
    const parts = payload.split(':');
    const outcome = parts[0]; // helped | spiraled | mixed
    const followUpId = parseInt(parts[1]);

    const db = getDb();
    db.prepare(`UPDATE override_follow_ups SET response = ? WHERE id = ?`).run(outcome, followUpId);

    const responses: Record<string, string> = {
        helped: `Good. I'll factor that in.`,
        spiraled: `Noted. That override pattern goes into the record.`,
        mixed: `Understood. I'll track the ratio over time.`,
    };

    await sendTelegram(responses[outcome] || 'Got it.', 'HTML');
}
```

- [ ] **Step 6: Compile check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/guardian-runtime.ts src/lib/scheduler.ts src/app/api/telegram/webhook/route.ts
git commit -m "feat(override): schedule 20-min follow-up after override approval, track outcome"
```

---

## Task 7: End-to-End Verification

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected: server starts on port 3000, scheduler initializes and logs job registrations including `morning_checkin` and `evening_reflection`.

- [ ] **Step 2: Manual trigger — morning check-in**

```bash
# Trigger the morning check-in directly via fetch (bypass scheduler timing)
curl -X POST http://localhost:3000/api/telegram/webhook \
  -H "Content-Type: application/json" \
  -d '{"message":{"chat":{"id":"YOUR_CHAT_ID"},"text":"/test_morning_checkin"}}'
```

Or add a temporary test route. Easier: call `sendMorningCheckin()` directly from a test script:

```bash
node -e "
const { sendMorningCheckin } = require('./src/lib/checkin');
sendMorningCheckin().then(() => { console.log('done'); process.exit(0); });
" 2>&1
```

Expected: Telegram message arrives: "Good morning. What's your one commitment today?..."

- [ ] **Step 3: Reply to the morning check-in in Telegram**

Type something like: "Work on ML assignment, 7/10"

Expected: Guardian responds "7/10. Good. I'll hold you to it."
Check DB:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
console.log(db.prepare('SELECT * FROM daily_checkins ORDER BY id DESC LIMIT 3').all());
"
```

Expected: row with `checkin_type='morning'`, `likelihood_score=7`, `commitment='Work on ML assignment, 7/10'`

- [ ] **Step 4: Verify evening reflection flow**

Send `sendEveningReflection()` the same way. Reply with a multi-sentence answer. Check DB for evening row.

- [ ] **Step 5: Verify override follow-up**

Start a guardian session, trigger an override, check `override_follow_ups` table has a row with `follow_up_at` 20 minutes from now. Manually advance the time or wait 20 minutes for the poll job to fire.

- [ ] **Step 6: Final commit if all works**

```bash
git add .
git commit -m "feat(phase-a): complete inside-out layer — morning check-in, evening reflection, override follow-up"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Morning check-in at 8am with 1-10 likelihood score
- ✅ Evening reflection 3 questions at 9:30pm
- ✅ Response saved to `daily_checkins` table
- ✅ Low score (≤4) gets scaffolding response
- ✅ Memory extraction runs on both check-in types
- ✅ Evening reflection cross-references behavioral data (sessions, screen time, morning commitment)
- ✅ Guardian response sent after 5-min delay if evening analysis shows it's needed
- ✅ Post-override follow-up at 20 minutes
- ✅ Follow-up outcome (helped/spiraled/mixed) recorded

**What's deferred (Phase A v2):**
- Voice note handling for evening reflections (needs Whisper transcription, same infra as push-to-talk)
- Mid-day screen time report (Phase C — requires phone)
- `phone_screen_time` data in evening behavioral context (Phase C)
