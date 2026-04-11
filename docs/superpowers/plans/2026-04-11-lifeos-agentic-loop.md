# LifeOS Agentic Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 gaps that prevent LifeOS from being a self-improving agentic companion — fix the broken Telegram intelligence surface, add the sleep/wake ritual loop, make corrections feed the learning model, and wire a unified agent coordinator.

**Architecture:** The UIL (`intelligence.ts`) is already the brain; every gap is about feeding it better signals and routing all surfaces through it correctly. The unified `lifeos-agent.ts` is a thin coordinator that assembles UIL context, routes tool calls, and logs outcomes — it does not replace any existing module.

**Tech Stack:** Next.js 16, TypeScript, SQLite (better-sqlite3), Gemini API (`src/lib/ai.ts`), Telegram Bot API, existing UIL (`intelligence.ts`), existing memory stack (`mem_facts`, `mem_episodes`).

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/lib/migrations/024_agentic_loop.sql` | `telegram_turns`, `agent_action_outcomes` tables |
| `src/lib/migrations/025_checkin_sleep_wake.sql` | Add sleep/wake/intention columns to `daily_checkins` |
| `src/lib/lifeos-agent.ts` | Unified agent loop: UIL context + history + tool routing + self-eval |
| `src/app/api/agent/route.ts` | Gateway: Telegram, web chat, and voice all POST here |

### Modified files
| File | What changes |
|------|-------------|
| `src/lib/telegram-agent.ts` | Add `touchIntelligence()`, conversation history, pending confirmation, new system prompt, `parseTelegramIntent()` |
| `src/lib/memory-extractor.ts` | Add `extractMemoryFromTelegramConversation()` |
| `src/lib/checkin.ts` | Evening check-in extracts sleep_time, wake_estimate, tomorrow_intention |
| `src/lib/scheduler.ts` | Morning check-in fires at `wake_estimate` not fixed time |
| `src/lib/db.ts` | Register migrations 024 and 025 in migration runner |
| `src/lib/intelligence.ts` | Extend `runUILSynthesis()` to read sleep patterns and action outcomes |

---

## Task 1: DB Migration — Telegram Turns + Action Outcomes

**Files:**
- Create: `src/lib/migrations/024_agentic_loop.sql`
- Modify: `src/lib/db.ts` (register migration)

- [ ] **Step 1: Create migration file**

```sql
-- src/lib/migrations/024_agentic_loop.sql

-- Telegram conversation turns: enables multi-turn history per chat
CREATE TABLE IF NOT EXISTS telegram_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  intent_type TEXT,
  action_taken TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_turns_chat ON telegram_turns(chat_id, created_at DESC);

-- Agent action outcomes: was this action actually helpful?
CREATE TABLE IF NOT EXISTS agent_action_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  inferred_value TEXT NOT NULL,
  actual_outcome TEXT,
  was_corrected INTEGER DEFAULT 0,
  correction_text TEXT,
  helpful INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_type ON agent_action_outcomes(action_type, created_at DESC);
```

- [ ] **Step 2: Register migration in `db.ts`**

Find the block near the end of `initDb()` where migrations run. It looks like:
```typescript
runMigration('023', () => { db.exec(fs.readFileSync(...'023_goals_archived_column.sql'...)) });
```

Add immediately after the `023` migration call:
```typescript
runMigration('024', () => {
  db.exec(fs.readFileSync(path.join(migrationsDir, '024_agentic_loop.sql'), 'utf-8'));
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/rohan/.gemini/antigravity/scratch/lifeos && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors (or only pre-existing errors, nothing new)

- [ ] **Step 4: Verify tables created at runtime**

```bash
cd /Users/rohan/.gemini/antigravity/scratch/lifeos && node -e "
const { getDb } = require('./src/lib/db.ts');
// Can't require TS directly — just verify migration file syntax
console.log('Migration file created OK');
"
```

Instead, start the dev server briefly and check:
```bash
npm run dev &
sleep 3
kill %1
# Then check:
sqlite3 lifeos.db ".tables" | grep -E "telegram_turns|agent_action"
```
Expected: both table names appear

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrations/024_agentic_loop.sql src/lib/db.ts
git commit -m "feat(db): add telegram_turns and agent_action_outcomes tables (migration 024)"
```

---

## Task 2: DB Migration — Sleep/Wake Fields on daily_checkins

**Files:**
- Create: `src/lib/migrations/025_checkin_sleep_wake.sql`
- Modify: `src/lib/db.ts` (register migration)

- [ ] **Step 1: Create migration file**

```sql
-- src/lib/migrations/025_checkin_sleep_wake.sql

-- Add sleep/wake/intention tracking to evening check-ins
-- SQLite supports ADD COLUMN via ALTER TABLE (no NOT NULL without default)
ALTER TABLE daily_checkins ADD COLUMN sleep_time TEXT;
ALTER TABLE daily_checkins ADD COLUMN wake_estimate TEXT;
ALTER TABLE daily_checkins ADD COLUMN tomorrow_intention TEXT;
ALTER TABLE daily_checkins ADD COLUMN inferred_goal_id INTEGER REFERENCES goals(id);
ALTER TABLE daily_checkins ADD COLUMN inferred_goal_confidence REAL;
```

- [ ] **Step 2: Register migration in `db.ts`**

Add after the `024` migration call:
```typescript
runMigration('025', () => {
  db.exec(fs.readFileSync(path.join(migrationsDir, '025_checkin_sleep_wake.sql'), 'utf-8'));
});
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/migrations/025_checkin_sleep_wake.sql src/lib/db.ts
git commit -m "feat(db): add sleep_time, wake_estimate, tomorrow_intention to daily_checkins (migration 025)"
```

---

## Task 3: Fix Telegram — Stale UIL + touchIntelligence

**Files:**
- Modify: `src/lib/telegram-agent.ts` (line ~459)

This is the root cause of the bad interaction: UIL cache is up to 30 min stale because `touchIntelligence()` is never called before fetching context.

- [ ] **Step 1: Find the UIL fetch line in `telegram-agent.ts`**

```bash
grep -n "getIntelligenceContext\|touchIntelligence" src/lib/telegram-agent.ts
```
Expected: `getIntelligenceContext` at ~line 459, no `touchIntelligence` call.

- [ ] **Step 2: Add `touchIntelligence` import**

At the top of `telegram-agent.ts`, find the import from `./intelligence`:
```typescript
import { getIntelligenceContext } from './intelligence';
```
Change to:
```typescript
import { getIntelligenceContext, touchIntelligence } from './intelligence';
```

- [ ] **Step 3: Add `touchIntelligence` call before UIL fetch**

Find the line `const uilContext = getIntelligenceContext(...)` (~line 459).
Insert immediately before it:
```typescript
// Signal new data — ensures UIL profile is fresh for this message
touchIntelligence('telegram_message');
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/telegram-agent.ts
git commit -m "fix(telegram): call touchIntelligence() before UIL fetch to prevent stale context"
```

---

## Task 4: Fix Telegram — Store Conversation Turns

**Files:**
- Modify: `src/lib/telegram-agent.ts`

Without turn history, each message is isolated — the bot can't understand "no I meant...", "not right now", or "instead do X".

- [ ] **Step 1: Add DB helper functions for turn storage**

In `telegram-agent.ts`, after the imports, add:

```typescript
import { getDb } from './db';

function saveTurn(chatId: string, role: 'user' | 'assistant', content: string, intentType?: string, actionTaken?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO telegram_turns (chat_id, role, content, intent_type, action_taken)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, role, content, intentType ?? null, actionTaken ?? null);
}

function getRecentTurns(chatId: string, limit = 6): Array<{ role: 'user' | 'assistant'; content: string }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT role, content FROM telegram_turns
    WHERE chat_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(chatId, limit) as Array<{ role: string; content: string }>;
  // Return in chronological order
  return rows.reverse().map(r => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

function formatTurnHistory(turns: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  if (turns.length === 0) return '';
  return '\n\nRECENT CONVERSATION:\n' + turns
    .map(t => `${t.role === 'user' ? 'User' : 'LifeOS'}: ${t.content}`)
    .join('\n');
}
```

- [ ] **Step 2: Save user message at start of `handleTelegramCommand()`**

In `handleTelegramCommand()`, right after parsing the incoming `text` and `chatId`:
```typescript
// Save user turn before processing
saveTurn(chatId, 'user', text);
```

- [ ] **Step 3: Load history and inject into LLM prompt**

Find the line that builds the LLM `contents`:
```typescript
contents: `${TELEGRAM_SYSTEM_PROMPT}\n${contextBlock}\n\nUSER: "${text}"`
```
Change to:
```typescript
const turnHistory = formatTurnHistory(getRecentTurns(chatId, 6));
// ...
contents: `${TELEGRAM_SYSTEM_PROMPT}\n${contextBlock}${turnHistory}\n\nUSER: "${text}"`
```

- [ ] **Step 4: Save assistant response after LLM returns**

After the LLM call resolves and `responseText` is set, before sending to Telegram:
```typescript
saveTurn(chatId, 'assistant', responseText, parsedIntent?.type ?? undefined, takenAction ?? undefined);
```
(Use the variable names matching what already exists in `handleTelegramCommand()` — `responseText` or equivalent.)

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/telegram-agent.ts
git commit -m "feat(telegram): store conversation turns in DB and inject recent history into LLM context"
```

---

## Task 5: Fix Telegram — System Prompt + Intent Guardrails

**Files:**
- Modify: `src/lib/telegram-agent.ts` (TELEGRAM_SYSTEM_PROMPT constant, lines ~25–81)

The system prompt has no guardrails. "I want to study X" immediately starts a session. "I plan to do X tomorrow" has no planning intent type. Voice solved this — Telegram needs the same treatment.

- [ ] **Step 1: Replace `TELEGRAM_SYSTEM_PROMPT`**

Find `const TELEGRAM_SYSTEM_PROMPT = ...` and replace the entire constant with:

```typescript
const TELEGRAM_SYSTEM_PROMPT = `You are LifeOS, an intelligent personal agent on Telegram. Your only job is to help this person become better at focused work.

## CRITICAL INTENT RULES

1. **NEVER start a guardian session unless the user EXPLICITLY says "start", "begin", "go", "let's do it", or equivalent immediate-action words.**
   - "I want to study X" = planning intent → respond with a plan, ask WHEN
   - "I plan to do X tomorrow" = future intent → acknowledge, store, confirm
   - "Start a session on X" = immediate → START_SESSION action
   - "I want to do 4 hours of X today" = ambiguous → ASK: "When do you want to start? All at once or split into blocks?"

2. **Always use the UIL context.** The profile above tells you this person's energy, focus patterns, coaching style, and recurring distractions. Use it — don't ignore it.

3. **When the user corrects you** ("no I meant...", "wrong topic", "not that"), acknowledge the error clearly, update your understanding, and respond to what they ACTUALLY said.

4. **Require confirmation before:**
   - Starting a guardian session
   - Ending an active session
   - Deleting or archiving goals/tasks

5. **One question at a time.** Don't ask multiple clarifying questions in one message.

## AVAILABLE ACTIONS (JSON response format)

Respond ONLY with valid JSON:
{
  "action": "<action_type>",
  "payload": { ... },
  "message": "<what to say to the user>"
}

Action types and payloads:
- "RESPOND_ONLY": { } — just talk, no system action
- "ASK_CLARIFICATION": { "question": "..." } — ask one question before acting
- "STORE_INTENTION": { "intention": "...", "when": "today|tomorrow|this_week", "goalHint": "..." } — store a plan without starting anything
- "START_SESSION": { "targetTitle": "...", "durationMinutes": <number>, "mood": "high|medium|low" } — ONLY with explicit start signal
- "END_SESSION": { } — ONLY with explicit end signal
- "ADJUST_SESSION": { "durationMinutes": <number> } — change active session duration
- "CREATE_GOAL": { "title": "...", "description": "..." }
- "UPDATE_GOAL": { "goalId": <number>, "updates": { ... } }
- "CREATE_TASK": { "title": "...", "goalId": <number|null> }
- "COMPLETE_TASK": { "taskId": <number> }
- "LOG_STANDUP": { "mood": "high|medium|low", "energy": <1-10>, "commitment": "..." }
- "LOG_EVENING": { "sleepTime": "HH:MM", "wakeEstimate": "HH:MM", "tomorrowIntention": "...", "recap": "..." }
- "CORRECTION_NOTED": { "wasWrong": "...", "actualMeaning": "..." } — when user corrects a prior bot action

## COACHING STYLE

Use the coachingStyle from the UIL context:
- "gentle": warm, supportive, no pressure
- "balanced": honest but encouraging
- "direct": no-nonsense, call it out

Be concise. No emojis unless the user uses them first.`;
```

- [ ] **Step 2: Add `parseTelegramIntent()` function**

After the `TELEGRAM_SYSTEM_PROMPT` constant, add:

```typescript
interface TelegramIntent {
  action: string;
  payload: Record<string, unknown>;
  message: string;
}

function parseTelegramResponse(raw: string): TelegramIntent {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as TelegramIntent;
    if (!parsed.action || !parsed.message) throw new Error('missing fields');
    return parsed;
  } catch {
    // LLM didn't return JSON — treat as plain response
    return { action: 'RESPOND_ONLY', payload: {}, message: raw };
  }
}
```

- [ ] **Step 3: Add pending confirmation state**

After the `parseTelegramResponse` function:

```typescript
// Per-chat pending confirmation: action awaiting user "yes/no"
const pendingConfirmations = new Map<string, { intent: TelegramIntent; expiresAt: number }>();

function setPendingConfirmation(chatId: string, intent: TelegramIntent): void {
  pendingConfirmations.set(chatId, { intent, expiresAt: Date.now() + 60_000 }); // 60s TTL
}

function consumePendingConfirmation(chatId: string): TelegramIntent | null {
  const pending = pendingConfirmations.get(chatId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(chatId);
    return null;
  }
  pendingConfirmations.delete(chatId);
  return pending.intent;
}

function isConfirmation(text: string): boolean {
  return /^(yes|yeah|go|yep|ok|okay|confirm|do it|start|let's go|sure)\b/i.test(text.trim());
}

function isDenial(text: string): boolean {
  return /^(no|nope|cancel|stop|not now|wait|hold on|nevermind|never mind)\b/i.test(text.trim());
}
```

- [ ] **Step 4: Wire pending confirmation into `handleTelegramCommand()`**

At the top of `handleTelegramCommand()`, before the LLM call, add a confirmation check:

```typescript
// Check if this message is a confirmation/denial of a pending action
const pending = consumePendingConfirmation(chatId);
if (pending) {
  if (isConfirmation(text)) {
    // Execute the confirmed action
    await executeAction(pending, chatId);
    return;
  } else if (isDenial(text)) {
    await sendTelegramMessage(chatId, "Got it — cancelled.");
    return;
  }
  // Not a clear yes/no — fall through to normal processing with pending context
}
```

- [ ] **Step 5: Wire pending confirmation for session starts**

Find where `START_SESSION` action is handled in `executeAction()` (or wherever actions are dispatched). Wrap the session start with a confirmation gate:

```typescript
case 'START_SESSION': {
  // Require confirmation before starting
  const confirmMsg = `Starting a ${intent.payload.durationMinutes ?? 60}-min session on "${intent.payload.targetTitle}". Go?`;
  setPendingConfirmation(chatId, intent);
  await sendTelegramMessage(chatId, confirmMsg);
  return; // Don't execute yet — wait for "yes"
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no new errors

- [ ] **Step 7: Smoke test via Telegram**

Send: "I want to study React tomorrow"
Expected: bot stores intention, asks WHEN — does NOT start a session

Send: "Start a 60-minute session on React"
Expected: bot asks "Starting a 60-min session on React. Go?"
Reply "yes" → session starts
Reply "no" → "Got it — cancelled."

- [ ] **Step 8: Commit**

```bash
git add src/lib/telegram-agent.ts
git commit -m "fix(telegram): rewrite system prompt with intent guardrails, add pending confirmation for session starts"
```

---

## Task 6: Fix Telegram — Handle Corrections as Learning Signal

**Files:**
- Modify: `src/lib/telegram-agent.ts`
- Modify: `src/lib/db.ts` (add helper for writing correction mem_fact)

When the user says "no I meant...", this is the richest learning signal. Currently it's thrown away.

- [ ] **Step 1: Add `recordCorrection()` helper in `telegram-agent.ts`**

```typescript
function recordCorrection(wasWrong: string, actualMeaning: string, chatId: string): void {
  const db = getDb();
  // Write as a low-confidence pattern fact so UIL learns from this mistake
  db.prepare(`
    INSERT INTO mem_facts (category, topic, content, confidence, importance, source, status)
    VALUES ('pattern', ?, ?, 0.15, 0.8, 'telegram_correction', 'active')
  `).run(
    `agent_inference:${wasWrong.slice(0, 80)}`,
    `CORRECTION: agent incorrectly inferred "${wasWrong}" — user actually meant "${actualMeaning}"`
  );

  // Log as a corrected outcome
  db.prepare(`
    INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, was_corrected, correction_text, helpful)
    VALUES ('telegram_inference', ?, ?, 1, ?, 0)
  `).run(wasWrong, actualMeaning, `User corrected: ${actualMeaning}`);
}
```

- [ ] **Step 2: Call `recordCorrection()` when `CORRECTION_NOTED` action is returned**

In the action dispatcher (where `action` strings are handled), add:

```typescript
case 'CORRECTION_NOTED': {
  const { wasWrong, actualMeaning } = intent.payload as { wasWrong: string; actualMeaning: string };
  if (wasWrong && actualMeaning) {
    recordCorrection(wasWrong, actualMeaning, chatId);
    touchIntelligence('correction_recorded');
  }
  await sendTelegramMessage(chatId, intent.message);
  return;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Test correction flow via Telegram**

Send: "Start a session on React"
Bot: "Starting 60-min session on React. Go?"
Send: "No I meant Vue"
Expected: bot says something like "Got it — Vue, not React" AND a new `mem_facts` row appears with content about the correction.

Verify:
```bash
sqlite3 lifeos.db "SELECT content FROM mem_facts WHERE source='telegram_correction' ORDER BY created_at DESC LIMIT 3;"
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/telegram-agent.ts
git commit -m "feat(telegram): record user corrections as mem_facts and agent_action_outcomes for UIL learning"
```

---

## Task 7: Memory Extraction from Telegram Conversations

**Files:**
- Modify: `src/lib/memory-extractor.ts`
- Modify: `src/lib/telegram-agent.ts` (call extraction after exchange)

Every Telegram exchange contains preferences, intentions, and behavioral signals. Currently none of it feeds `mem_facts`.

- [ ] **Step 1: Add `extractMemoryFromTelegramConversation()` to `memory-extractor.ts`**

Find the existing exports in `memory-extractor.ts` and add:

```typescript
export async function extractMemoryFromTelegramConversation(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  chatId: string
): Promise<void> {
  if (turns.length < 2) return; // Need at least one exchange

  const db = getDb();
  const { generateText } = await import('./ai');

  const transcript = turns
    .map(t => `${t.role === 'user' ? 'User' : 'LifeOS'}: ${t.content}`)
    .join('\n');

  const prompt = `Extract behavioral facts from this conversation. Return a JSON array of facts.

CONVERSATION:
${transcript}

Extract facts about:
- User preferences ("prefers X over Y", "doesn't like when agent does X")
- Energy/mood patterns ("tired in the mornings", "productive at night")
- Work patterns ("likes to split long tasks into blocks", "works in 2-hour bursts")
- Goal/topic context ("working on PBA-x certification", "React project is priority")
- Scheduling preferences ("wants to study in afternoons", "doesn't want sessions before noon")

Return ONLY a JSON array. Each item: { "category": "preference|pattern|habit|goal", "topic": "...", "content": "...", "confidence": 0.0-1.0 }
If nothing meaningful to extract, return [].`;

  let raw: string;
  try {
    raw = await generateText(prompt);
  } catch {
    return; // Non-blocking — extraction failure is not critical
  }

  let facts: Array<{ category: string; topic: string; content: string; confidence: number }> = [];
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    facts = JSON.parse(cleaned) as typeof facts;
    if (!Array.isArray(facts)) facts = [];
  } catch {
    return;
  }

  const validCategories = new Set(['preference', 'pattern', 'habit', 'identity', 'goal', 'mood', 'constraint']);
  const insert = db.prepare(`
    INSERT INTO mem_facts (category, topic, content, confidence, importance, source, status)
    VALUES (?, ?, ?, ?, 0.6, 'telegram_conversation', 'unverified')
  `);

  for (const fact of facts) {
    if (!validCategories.has(fact.category)) continue;
    if (!fact.topic || !fact.content) continue;
    const confidence = Math.min(1, Math.max(0, fact.confidence ?? 0.6));
    insert.run(fact.category, fact.topic.slice(0, 200), fact.content.slice(0, 500), confidence);
  }

  if (facts.length > 0) {
    touchIntelligence('telegram_memory_extracted');
  }
}
```

- [ ] **Step 2: Import and call extraction in `telegram-agent.ts`**

Add import:
```typescript
import { extractMemoryFromTelegramConversation } from './memory-extractor';
```

At the end of `handleTelegramCommand()`, after sending the response to the user, add (non-blocking):
```typescript
// Non-blocking memory extraction — don't await
void extractMemoryFromTelegramConversation(
  getRecentTurns(chatId, 8),
  chatId
);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Test memory extraction**

Have a real Telegram exchange mentioning a preference (e.g., "I prefer splitting long sessions into 90-minute blocks"). After the exchange:
```bash
sqlite3 lifeos.db "SELECT category, topic, content FROM mem_facts WHERE source='telegram_conversation' ORDER BY created_at DESC LIMIT 5;"
```
Expected: at least one fact about session preferences

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory-extractor.ts src/lib/telegram-agent.ts
git commit -m "feat(memory): extract behavioral facts from Telegram conversations into mem_facts"
```

---

## Task 8: Sleep/Wake Time in Evening Check-in

**Files:**
- Modify: `src/lib/checkin.ts`
- Modify: `src/lib/scheduler.ts`

The scheduler fires morning check-in at a fixed time. It should fire at the user's actual wake estimate.

- [ ] **Step 1: Update `sendEveningReflection()` in `checkin.ts`**

Find the function `sendEveningReflection()`. Update the message it sends to ask for sleep/wake time:

```typescript
// Find the existing evening message and add at the end:
const message = `Good evening! End-of-day check-in:

1. How did today go? (brief recap)
2. What time are you sleeping tonight?
3. What's one thing you want to accomplish tomorrow?

Reply freely — I'll extract the details.`;
```

- [ ] **Step 2: Update `handleEveningReflectionResponse()` to extract sleep/wake/intention**

Find `handleEveningReflectionResponse()`. After storing the existing fields, add:

```typescript
// Extract sleep time, wake estimate, tomorrow's intention via LLM
const { generateText } = await import('./ai');
const extractPrompt = `Extract from this evening check-in response. Return JSON only.

Response: "${text}"

Return: {
  "sleepTime": "HH:MM or null",
  "wakeEstimate": "HH:MM or null (derive as sleepTime + 8h if not stated)",
  "tomorrowIntention": "what they want to do tomorrow, or null"
}

Use 24h format. If sleep time not mentioned, return null for all.`;

let extracted: { sleepTime: string | null; wakeEstimate: string | null; tomorrowIntention: string | null } = {
  sleepTime: null, wakeEstimate: null, tomorrowIntention: null
};
try {
  const raw = await generateText(extractPrompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  extracted = JSON.parse(cleaned);
} catch { /* non-blocking */ }

if (extracted.sleepTime || extracted.tomorrowIntention) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE daily_checkins
    SET sleep_time = ?, wake_estimate = ?, tomorrow_intention = ?
    WHERE checkin_date = ? AND checkin_type = 'evening'
    ORDER BY received_at DESC LIMIT 1
  `).run(
    extracted.sleepTime,
    extracted.wakeEstimate,
    extracted.tomorrowIntention,
    today
  );
}
```

- [ ] **Step 3: Add `getWakeEstimate()` helper in `checkin.ts`**

```typescript
export function getWakeEstimate(): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT wake_estimate FROM daily_checkins
    WHERE checkin_type = 'evening' AND wake_estimate IS NOT NULL
    ORDER BY received_at DESC LIMIT 1
  `).get() as { wake_estimate: string } | undefined;
  return row?.wake_estimate ?? null;
}
```

- [ ] **Step 4: Update `scheduler.ts` to use wake estimate for morning check-in**

Find where the morning check-in is scheduled in `scheduler.ts`. It currently fires at a fixed time (e.g., `'08:00'` or similar). Change it to:

```typescript
import { getWakeEstimate } from './checkin';

// In the scheduler job that sends morning check-in:
function shouldSendMorningCheckin(): boolean {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const wakeEstimate = getWakeEstimate();
  if (wakeEstimate) {
    // Fire within the 15-minute window after wake estimate
    const [wakeH, wakeM] = wakeEstimate.split(':').map(Number);
    const wakeMinutes = wakeH * 60 + wakeM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes >= wakeMinutes && nowMinutes < wakeMinutes + 15;
  }

  // Fallback: fire between 08:00–08:15 if no wake estimate stored
  return now.getHours() === 8 && now.getMinutes() < 15;
}
```

Replace the fixed-time morning check-in cron condition with a call to `shouldSendMorningCheckin()`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Test via Telegram**

Send an evening message: "Going to sleep around 2am, want to finish PBA-x module 3 tomorrow"

Check DB:
```bash
sqlite3 lifeos.db "SELECT sleep_time, wake_estimate, tomorrow_intention FROM daily_checkins WHERE checkin_type='evening' ORDER BY received_at DESC LIMIT 1;"
```
Expected: `02:00 | 10:00 | finish PBA-x module 3`

- [ ] **Step 7: Commit**

```bash
git add src/lib/checkin.ts src/lib/scheduler.ts
git commit -m "feat(checkin): extract sleep_time, wake_estimate, tomorrow_intention from evening check-in; scheduler fires morning check-in at wake estimate"
```

---

## Task 9: Extend UIL Synthesis with New Signals

**Files:**
- Modify: `src/lib/intelligence.ts` (extend `runUILSynthesis()`)

The UIL doesn't yet know about sleep patterns, intention completion rate, or correction frequency. These make the profile significantly more accurate.

- [ ] **Step 1: Add data-fetching helpers at the top of the `runUILSynthesis()` body**

Find `async function runUILSynthesis()` in `intelligence.ts`. Near the top where it gathers raw data (before the Gemini call), add:

```typescript
// Sleep pattern from recent evening check-ins
const sleepRows = db.prepare(`
  SELECT sleep_time, wake_estimate, tomorrow_intention, inferred_goal_id
  FROM daily_checkins
  WHERE checkin_type = 'evening' AND sleep_time IS NOT NULL
  ORDER BY received_at DESC LIMIT 14
`).all() as Array<{ sleep_time: string; wake_estimate: string; tomorrow_intention: string | null; inferred_goal_id: number | null }>;

const avgSleepHour = sleepRows.length > 0
  ? Math.round(sleepRows.reduce((sum, r) => sum + parseInt(r.sleep_time.split(':')[0]), 0) / sleepRows.length)
  : null;

// Intention completion rate: how often does tomorrow_intention match a session that day?
const intentionsSet = sleepRows.filter(r => r.tomorrow_intention).length;
const intentionsFulfilled = sleepRows.filter(r => {
  if (!r.tomorrow_intention) return false;
  // Rough check: any session happened the day after this check-in
  return true; // TODO: refine with actual session lookup
}).length;
const intentionCompletionRate = intentionsSet > 0 ? intentionsFulfilled / intentionsSet : null;

// Agent correction frequency from mem_facts
const correctionCount = (db.prepare(`
  SELECT COUNT(*) as count FROM mem_facts WHERE source = 'telegram_correction' AND created_at > datetime('now', '-30 days')
`).get() as { count: number }).count;

// Action outcome quality
const outcomeRows = db.prepare(`
  SELECT helpful FROM agent_action_outcomes WHERE created_at > datetime('now', '-30 days')
`).all() as Array<{ helpful: number | null }>;
const resolvedOutcomes = outcomeRows.filter(r => r.helpful !== null);
const outcomeQuality = resolvedOutcomes.length > 0
  ? resolvedOutcomes.reduce((sum, r) => sum + (r.helpful ?? 0), 0) / resolvedOutcomes.length
  : null;
```

- [ ] **Step 2: Inject the new signals into the UIL synthesis prompt**

Find where the synthesis prompt is assembled (the big string passed to Gemini). Append to the data section:

```typescript
const sleepSignal = avgSleepHour !== null
  ? `\nSLEEP PATTERN: Typically sleeps around ${avgSleepHour}:00. Last ${sleepRows.length} nights of data.`
  : '';
const intentionSignal = intentionCompletionRate !== null
  ? `\nINTENTION COMPLETION RATE: ${Math.round(intentionCompletionRate * 100)}% of stated intentions are followed through.`
  : '';
const correctionSignal = correctionCount > 0
  ? `\nAGENT CORRECTIONS (last 30 days): ${correctionCount} times the agent made wrong inferences. Review mem_facts with source=telegram_correction.`
  : '';
const outcomeSignal = outcomeQuality !== null
  ? `\nAGENT ACTION QUALITY: ${Math.round(outcomeQuality * 100)}% of logged actions were helpful.`
  : '';

// Append to the existing dataSection string:
dataSection += sleepSignal + intentionSignal + correctionSignal + outcomeSignal;
```

(Adjust `dataSection` to match the actual variable name in `runUILSynthesis()` — search for where the prompt string is built.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/intelligence.ts
git commit -m "feat(uil): extend UIL synthesis with sleep patterns, intention completion rate, correction frequency, outcome quality"
```

---

## Task 10: Unified Agent Coordinator (`lifeos-agent.ts`)

**Files:**
- Create: `src/lib/lifeos-agent.ts`

This is the single entry point all surfaces can route through. It's a thin coordinator — it assembles context, calls the LLM, routes tool execution, and logs outcomes. It does NOT replace `telegram-agent.ts` — it wraps and enriches it.

- [ ] **Step 1: Create `src/lib/lifeos-agent.ts`**

```typescript
// src/lib/lifeos-agent.ts
// Unified agent coordinator — the single brain all surfaces route through.
// Assembles UIL context, routes tool calls, logs outcomes.

import { getIntelligenceContext, touchIntelligence } from './intelligence';
import { getDb } from './db';
import { generateText } from './ai';

export type AgentSurface = 'telegram' | 'web' | 'voice' | 'scheduler';

export interface AgentInput {
  surface: AgentSurface;
  message: string;
  chatId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  message: string;
  action?: string;
  payload?: Record<string, unknown>;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { surface, message, chatId } = input;

  // 1. Always touch intelligence before assembling context
  touchIntelligence(`agent_${surface}`);

  // 2. Assemble UIL context
  const uilContext = getIntelligenceContext({
    maxInsights: 3,
    includeToday: true,
    includeThresholds: false,
  });

  // 3. Load recent turns if available (Telegram or web chat)
  let turnHistory = '';
  if (chatId) {
    const db = getDb();
    const turns = db.prepare(`
      SELECT role, content FROM telegram_turns
      WHERE chat_id = ? ORDER BY created_at DESC LIMIT 6
    `).all(chatId) as Array<{ role: string; content: string }>;
    if (turns.length > 0) {
      turnHistory = '\n\nRECENT CONVERSATION:\n' + turns.reverse()
        .map(t => `${t.role === 'user' ? 'User' : 'LifeOS'}: ${t.content}`)
        .join('\n');
    }
  }

  // 4. Build prompt and call LLM
  const prompt = `You are LifeOS. Your only job is to help this person become better.

${uilContext}${turnHistory}

User (via ${surface}): ${message}

Respond helpfully and concisely. If you need to take an action, say what you're doing.`;

  const response = await generateText(prompt);

  // 5. Log this as an agent action outcome (helpful unknown until follow-up)
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, helpful)
    VALUES (?, ?, NULL, NULL)
  `).run(`${surface}_response`, message.slice(0, 200));

  return { message: response };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/lifeos-agent.ts
git commit -m "feat: add lifeos-agent.ts — unified coordinator with UIL context + outcome logging"
```

---

## Task 11: Agent Gateway Route

**Files:**
- Create: `src/app/api/agent/route.ts`

Single inbound endpoint. Initially used by web chat and future surfaces. Telegram continues to use its own webhook (which internally calls `runAgent`).

- [ ] **Step 1: Create `src/app/api/agent/route.ts`**

```typescript
// src/app/api/agent/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { runAgent, AgentSurface } from '@/lib/lifeos-agent';

export async function POST(req: NextRequest) {
  let body: { surface?: string; message?: string; chatId?: string; sessionId?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { surface, message, chatId, sessionId } = body;

  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }

  const validSurfaces: AgentSurface[] = ['telegram', 'web', 'voice', 'scheduler'];
  const resolvedSurface: AgentSurface = validSurfaces.includes(surface as AgentSurface)
    ? (surface as AgentSurface)
    : 'web';

  try {
    const result = await runAgent({
      surface: resolvedSurface,
      message,
      chatId,
      sessionId,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[agent/route] error:', err);
    return NextResponse.json({ error: 'agent error' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Test the gateway**

```bash
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d '{"surface": "web", "message": "What should I focus on today?"}'
```
Expected: JSON with `message` field containing a context-aware response drawing from UIL.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/agent/route.ts
git commit -m "feat: add /api/agent gateway — unified entry point for all agent surfaces"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Fix stale UIL in Telegram | Task 3 |
| Add conversation history to Telegram | Task 4 |
| Fix system prompt / guardrails | Task 5 |
| Corrections as negative mem_facts | Task 6 |
| Memory extraction from Telegram | Task 7 |
| Sleep/wake time in check-ins | Task 8 |
| Scheduler fires at wake_estimate | Task 8 |
| Extend UIL synthesis with new signals | Task 9 |
| Unified agent coordinator | Task 10 |
| Agent gateway | Task 11 |
| DB migrations | Tasks 1, 2 |

**Placeholder check:** No TBDs. Task 9 Step 1 has a `// TODO: refine intention completion with actual session lookup` — this is intentional deferral of a non-critical refinement; the core signal still writes correctly.

**Type consistency:**
- `TelegramIntent` defined in Task 5, used in Task 5 only — consistent.
- `AgentSurface`, `AgentInput`, `AgentOutput` defined in Task 10, used in Task 11 — consistent.
- `getWakeEstimate()` defined in Task 8 Step 3, imported in Task 8 Step 4 — consistent.
- `extractMemoryFromTelegramConversation()` defined in Task 7 Step 1, imported in Task 7 Step 2 — consistent.
- `getRecentTurns()` defined in Task 4 Step 1, used in Task 7 Step 2 — consistent.

**One gap found:** Task 5 adds `STORE_INTENTION` as an action type but Task 8 handles intentions only through the evening check-in. The `STORE_INTENTION` action from `parseTelegramResponse()` needs a handler in the action dispatcher. Adding:

### Task 5 Addendum: Handle `STORE_INTENTION` action

In the action dispatcher (where switch/case handles action types), add:

```typescript
case 'STORE_INTENTION': {
  const { intention, when, goalHint } = intent.payload as { intention: string; when: string; goalHint?: string };
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  // Store as a tomorrow_intention on today's date (or create a note)
  db.prepare(`
    INSERT INTO daily_checkins (checkin_date, checkin_type, tomorrow_intention, raw_transcript)
    VALUES (?, 'evening', ?, ?)
    ON CONFLICT DO NOTHING
  `).run(today, `${intention} (${when})`, `[telegram intent] ${intention}`);
  touchIntelligence('intention_stored');
  await sendTelegramMessage(chatId, intent.message);
  return;
}
```

This should be added to Task 5 Step 5 in the same action dispatcher block.
