# Phase E: Unfinished Things Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the open loops — every project started but not finished, every goal engaged in the last 30 days that hasn't been closed. Not as guilt, but as facts with a path forward. The guardian holds the thread and never lets things quietly vanish.

**Architecture:** A weekly audit job (Monday 8am) queries goals/tasks last touched in the past 30 days and builds an "open loops" Telegram message. The weekly reckoning from Phase D already references previous open questions — this phase adds a dedicated audit for incomplete goals/projects. A monthly pattern letter synthesizes 4 weeks of reckonings into a longer narrative.

**Tech Stack:** TypeScript, SQLite, Telegram, Gemini Flash

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Create | `src/lib/open-loops.ts` | Query open loops, build and send audit message |
| Modify | `src/lib/scheduler.ts` | Add weekly audit job (Monday 08:15) + monthly pattern letter (1st of month, 19:00) |
| Modify | `src/app/api/telegram/webhook/route.ts` | Route open loop responses |

---

## Task 1: Create `src/lib/open-loops.ts`

**Files:**
- Create: `src/lib/open-loops.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/open-loops.ts
// Weekly open loops audit: surface incomplete goals/projects, one actionable suggestion each

import { getDb } from './db';
import { sendTelegram } from './telegram';
import { getIntelligenceContext } from './intelligence';

export interface OpenLoop {
  type: 'goal' | 'task' | 'topic';
  title: string;
  lastTouchedDaysAgo: number;
  lastFocusScore?: number;
  lastElapsedMinutes?: number;
  sessionCount: number;
  status: string;
}

/**
 * Query all open loops: goals/tasks engaged in last 30 days but not completed.
 */
export function getOpenLoops(): OpenLoop[] {
  const db = getDb();
  const loops: OpenLoop[] = [];

  // Goals that are active but have sessions in last 30 days (and haven't had sessions in last 5 days)
  const goals = db.prepare(`
    SELECT
      g.title,
      g.status,
      g.updated_at,
      MAX(s.completed_at) as last_session_at,
      COUNT(s.session_id) as session_count,
      AVG(s.average_focus_score) as avg_score,
      AVG(s.elapsed_minutes) as avg_minutes
    FROM goals g
    LEFT JOIN guardian_session_summaries s ON s.target_title LIKE '%' || g.title || '%'
      AND s.completed_at >= datetime('now', '-30 days')
    WHERE g.status = 'active'
    GROUP BY g.id
    HAVING session_count > 0
    ORDER BY last_session_at ASC
  `).all() as Array<{
    title: string; status: string; updated_at: string;
    last_session_at: string; session_count: number;
    avg_score: number; avg_minutes: number;
  }>;

  for (const g of goals) {
    if (!g.last_session_at) continue;
    const daysAgo = Math.floor(
      (Date.now() - new Date(g.last_session_at).getTime()) / (24 * 3600 * 1000)
    );
    if (daysAgo >= 3) { // Only surface if not touched in 3+ days
      loops.push({
        type: 'goal',
        title: g.title,
        lastTouchedDaysAgo: daysAgo,
        lastFocusScore: Math.round(g.avg_score),
        lastElapsedMinutes: Math.round(g.avg_minutes),
        sessionCount: g.session_count,
        status: g.status,
      });
    }
  }

  // Tasks that are in-progress or doing but not completed
  const tasks = db.prepare(`
    SELECT
      t.title,
      t.status,
      t.updated_at,
      (julianday('now') - julianday(t.updated_at)) as days_since_update
    FROM tasks t
    WHERE t.status IN ('doing', 'todo')
      AND t.updated_at >= datetime('now', '-30 days')
      AND t.archived = 0
    ORDER BY days_since_update DESC
    LIMIT 10
  `).all() as Array<{ title: string; status: string; updated_at: string; days_since_update: number }>;

  for (const t of tasks) {
    if (t.days_since_update >= 5) {
      loops.push({
        type: 'task',
        title: t.title,
        lastTouchedDaysAgo: Math.floor(t.days_since_update),
        sessionCount: 0,
        status: t.status,
      });
    }
  }

  // Sort by most stale first
  return loops.sort((a, b) => b.lastTouchedDaysAgo - a.lastTouchedDaysAgo).slice(0, 8);
}

/**
 * Build and send the weekly open loops message.
 */
export async function sendOpenLoopsAudit(): Promise<void> {
  try {
    const loops = getOpenLoops();

    if (loops.length === 0) {
      console.log('[OpenLoops] No open loops to report this week.');
      return;
    }

    const context = getIntelligenceContext({ maxInsights: 1 });

    const loopsText = loops.map(l => {
      const sessionNote = l.sessionCount > 0
        ? `, ${l.sessionCount} sessions (avg score ${l.lastFocusScore}, avg ${l.lastElapsedMinutes}m)`
        : '';
      return `- ${l.title} — last touched ${l.lastTouchedDaysAgo} days ago${sessionNote}`;
    }).join('\n');

    const prompt = `You are Rohan's guardian writing a weekly open loops audit. Surface unfinished things honestly.

Intelligence profile summary:
${context.slice(0, 400)}

Open loops (things started but not recently touched):
${loopsText}

Write a Telegram message in this format:
1. One sentence header: "X things you started and haven't touched." (use actual count, no softening)
2. For each loop (max 5): one line with the item and ONE specific, actionable suggestion (not motivational — concrete: "open the file", "write one question", "send the email")
3. One final line: "Which one is actually going to get done this week?"

Rules:
- No guilt language ("you failed to", "you should have")
- Just facts and a path forward
- Keep suggestions specific to what you know about the person
- Max 200 words total
- Return ONLY the message text, no explanation`;

    const { generateContent } = await import('./ai');
    const auditText = await generateContent(prompt, { temperature: 0.4, maxOutputTokens: 400 });

    if (!auditText) {
      console.error('[OpenLoops] generateContent returned null');
      return;
    }

    await sendTelegram(auditText, 'HTML');
    console.log(`[OpenLoops] Sent audit for ${loops.length} open loops`);

  } catch (err) {
    console.error('[OpenLoops] sendOpenLoopsAudit failed:', err);
  }
}

/**
 * Build and send the monthly pattern letter (synthesizes 4 weeks of reckonings).
 */
export async function sendMonthlyPatternLetter(): Promise<void> {
  try {
    const db = getDb();

    // Last 4 weekly reckonings
    const reckonings = db.prepare(`
      SELECT week_start, reckoning_text, open_question, response_text
      FROM weekly_reckonings
      ORDER BY created_at DESC
      LIMIT 4
    `).all() as Array<{ week_start: string; reckoning_text: string; open_question: string; response_text: string | null }>;

    if (reckonings.length < 2) {
      console.log('[OpenLoops] Not enough reckonings for monthly letter, need at least 2.');
      return;
    }

    // Session stats for the month
    const monthStart = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const monthStats = db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as total_sessions,
        ROUND(AVG(average_focus_score)) as avg_score,
        COUNT(DISTINCT date(completed_at)) as days_with_sessions,
        SUM(elapsed_minutes) as total_minutes
      FROM guardian_session_summaries
      WHERE completed_at >= ?
    `).get(monthStart) as { total_sessions: number; avg_score: number; days_with_sessions: number; total_minutes: number };

    const reckoningsText = reckonings.map((r, i) =>
      `WEEK ${i + 1} (${r.week_start}):\n${r.reckoning_text?.slice(0, 600) || '(no data)'}\n${r.response_text ? `Response: "${r.response_text.slice(0, 200)}"` : '(no response)'}`
    ).join('\n\n---\n\n');

    const prompt = `You are Rohan's guardian writing a monthly pattern letter. This is more personal and analytical than the weekly reckoning.

Last 4 weeks of reckonings and responses:
${reckoningsText}

Month stats:
- Sessions: ${monthStats.total_sessions} total, ${monthStats.days_with_sessions} days active
- Average focus score: ${monthStats.avg_score}
- Total focus time: ${Math.round(monthStats.total_minutes / 60)}h

Write a monthly pattern letter that:
1. Names the 1-2 dominant patterns across all 4 weeks (not events, patterns)
2. Notes what changed vs. what stayed the same
3. References specific things Rohan said in his responses (if any)
4. Ends with ONE insight the system has developed about this person that wasn't visible 4 weeks ago
5. No prescriptions, no action items — this is a mirror, not a plan

Max 350 words. Direct. Specific. No filler.`;

    const { generateContent } = await import('./ai');
    const letter = await generateContent(prompt, { temperature: 0.4, maxOutputTokens: 700 });

    if (!letter) {
      console.error('[OpenLoops] Monthly pattern letter generateContent returned null');
      return;
    }

    const header = `📅 <b>Monthly Pattern Letter</b>\n\n`;
    await sendTelegram(header + letter, 'HTML');
    console.log('[OpenLoops] Monthly pattern letter sent.');

  } catch (err) {
    console.error('[OpenLoops] sendMonthlyPatternLetter failed:', err);
  }
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "open-loops" | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/open-loops.ts
git commit -m "feat(open-loops): add weekly open loops audit and monthly pattern letter"
```

---

## Task 2: Add Jobs to Scheduler

**Files:**
- Modify: `src/lib/scheduler.ts`

- [ ] **Step 1: Add imports**

```typescript
import { sendOpenLoopsAudit, sendMonthlyPatternLetter } from './open-loops';
```

- [ ] **Step 2: Add open loops audit job (Monday 08:15)**

In `initScheduler()`:

```typescript
    // Weekly open loops audit — Monday morning at 08:15
    registerDailyJob('open_loops_audit', '08:15', async () => {
        const dayOfWeek = new Date().getDay(); // 1 = Monday
        if (dayOfWeek !== 1) return;
        await sendOpenLoopsAudit();
    });
```

- [ ] **Step 3: Add monthly pattern letter job (1st of month, 19:00)**

```typescript
    // Monthly pattern letter — 1st of each month at 19:00
    registerDailyJob('monthly_pattern_letter', '19:00', async () => {
        const dayOfMonth = new Date().getDate();
        if (dayOfMonth !== 1) return;
        await sendMonthlyPatternLetter();
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
git commit -m "feat(scheduler): add open loops audit (Monday 08:15) and monthly pattern letter (1st of month)"
```

---

## Task 3: End-to-End Verification

- [ ] **Step 1: Seed test data and trigger open loops audit manually**

```bash
# Ensure there are some goals and sessions in the DB first
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
// Check what's in goals table
console.log('Goals:', db.prepare('SELECT title, status FROM goals WHERE status = \"active\" LIMIT 5').all());
// Check recent sessions
console.log('Sessions:', db.prepare('SELECT target_title, completed_at FROM guardian_session_summaries ORDER BY completed_at DESC LIMIT 5').all());
"
```

- [ ] **Step 2: Trigger audit**

```bash
node -e "
const { sendOpenLoopsAudit } = require('./src/lib/open-loops');
sendOpenLoopsAudit().then(() => process.exit(0));
"
```

Expected: Telegram message arrives listing open loops with specific actionable suggestions. Message ends with "Which one is actually going to get done this week?"

- [ ] **Step 3: Verify `getOpenLoops()` logic**

```bash
node -e "
const { getOpenLoops } = require('./src/lib/open-loops');
console.log(JSON.stringify(getOpenLoops(), null, 2));
"
```

Expected: array of `OpenLoop` objects with `title`, `lastTouchedDaysAgo`, `sessionCount`, etc.

- [ ] **Step 4: Test monthly letter (requires ≥2 weekly reckonings in DB)**

First run Phase D's weekly reckoning twice (or insert test rows):

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
db.prepare(\"INSERT INTO weekly_reckonings (week_start, reckoning_text, open_question) VALUES ('2026-03-23', 'Test week 1 reckoning text. Pattern: avoided ML assignment.', 'What specifically happens when you open the ML assignment?')\").run();
db.prepare(\"INSERT INTO weekly_reckonings (week_start, reckoning_text, open_question, response_text) VALUES ('2026-03-30', 'Test week 2 reckoning text. Pattern: strong sessions on LifeOS.', 'What would finishing the ML assignment actually mean to you?', 'I think I am scared it will confirm I am bad at ML.')\").run();
console.log('inserted test reckonings');
"
```

Then trigger:

```bash
node -e "
const { sendMonthlyPatternLetter } = require('./src/lib/open-loops');
sendMonthlyPatternLetter().then(() => process.exit(0));
"
```

Expected: Telegram receives a "Monthly Pattern Letter" with 2-3 paragraph narrative identifying patterns across weeks.

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat(phase-e): complete unfinished things audit — open loops, monthly pattern letter"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Weekly audit job queries goals/tasks not touched in 3+ days
- ✅ "Open loops" Telegram message: facts + one actionable suggestion per item
- ✅ Ends with "Which one is actually going to get done this week?"
- ✅ No guilt language — just facts and path forward
- ✅ Guardian holds the thread — previous week's open question is in Phase D's weekly reckoning prompt
- ✅ Monthly pattern letter synthesizes 4 weeks of reckonings
- ✅ Monthly letter ends with one new insight about the person that wasn't visible 4 weeks ago

**Dependencies on prior phases:**
- Phase D must be complete (weekly_reckonings table must exist) for monthly letter to have data
- Phase B screen observations improve `getOpenLoops()` context (not required, just richer)

**What's deferred:**
- Open loop resolution tracking (when Rohan acts on an open loop, mark it closed in the audit)
- "Completing" an open loop via Telegram reply — add `pending_open_loop_response` state
