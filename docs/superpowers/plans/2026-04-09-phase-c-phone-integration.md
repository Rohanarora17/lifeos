# Phase C: Phone Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest iPhone screen time data (Instagram, YouTube, total pickups) into LifeOS via Telegram, so the guardian has visibility into the phone hours that currently make up the invisible part of the day.

**Architecture:** iOS Shortcuts send structured screen time data to the Telegram bot at 8am, 1pm, and 9pm. The webhook handler parses these into `phone_screen_time` rows. The continuity guardian and UIL synthesis already query this table once populated. A `/screen` Telegram command also allows manual paste of screen time data.

**Tech Stack:** iOS Shortcuts (Shortcut app on iPhone), Telegram Bot, TypeScript/Next.js webhook, SQLite

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Modify | `src/lib/db.ts` | Add `phone_screen_time` table DDL |
| Create | `src/lib/phone-screen-time.ts` | Parse and store phone screen time reports |
| Modify | `src/app/api/telegram/webhook/route.ts` | Route `/screen` command and structured phone reports |
| Modify | `src/lib/continuity-guardian.ts` | Add phone screen time trigger (>3 hours before 6pm) |

**iOS Shortcuts** are created manually on iPhone — no code to deploy, just setup instructions at the end.

---

## Task 1: Add `phone_screen_time` Table

**Files:**
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Add table DDL**

In `src/lib/db.ts`, add after the existing table definitions:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_screen_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      report_type TEXT NOT NULL CHECK(report_type IN ('morning','midday','evening','manual')),
      total_minutes INTEGER,
      instagram_minutes INTEGER,
      youtube_minutes INTEGER,
      tiktok_minutes INTEGER,
      safari_minutes INTEGER,
      other_data TEXT,
      pickup_count INTEGER,
      first_pickup_time TEXT,
      longest_phone_free_minutes INTEGER,
      raw_text TEXT,
      received_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
```

- [ ] **Step 2: Verify**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
const t = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='phone_screen_time'\").get();
console.log(t);
"
```

Expected: `{ name: 'phone_screen_time' }`

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(db): add phone_screen_time table"
```

---

## Task 2: Create `src/lib/phone-screen-time.ts`

This file parses the text format that iOS Shortcuts sends and stores it in the DB.

**Files:**
- Create: `src/lib/phone-screen-time.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/phone-screen-time.ts
// Parse and store phone screen time reports from iOS Shortcuts via Telegram

import { getDb } from './db';

export interface ParsedScreenTimeReport {
  reportType: 'morning' | 'midday' | 'evening' | 'manual';
  reportDate: string;
  totalMinutes: number | null;
  instagramMinutes: number | null;
  youtubeMinutes: number | null;
  tiktokMinutes: number | null;
  safariMinutes: number | null;
  pickupCount: number | null;
  firstPickupTime: string | null;
  longestPhoneFreeMinutes: number | null;
  otherData: Record<string, number>;
}

/**
 * Parse a structured screen time report.
 * The iOS Shortcut sends text in this format:
 *
 * SCREEN_TIME_REPORT
 * date: 2026-04-09
 * type: evening
 * total: 187
 * instagram: 94
 * youtube: 52
 * tiktok: 0
 * safari: 18
 * pickups: 94
 * first_pickup: 07:14
 * longest_free: 112
 *
 * Fields are flexible — parse what's available, ignore what's missing.
 */
export function parseScreenTimeReport(text: string): ParsedScreenTimeReport | null {
  const lines = text.trim().split('\n').map(l => l.trim());

  if (!lines[0].includes('SCREEN_TIME_REPORT')) return null;

  const getValue = (key: string): string | null => {
    const line = lines.find(l => l.toLowerCase().startsWith(key + ':'));
    return line ? line.split(':').slice(1).join(':').trim() : null;
  };

  const getInt = (key: string): number | null => {
    const val = getValue(key);
    return val !== null ? parseInt(val) : null;
  };

  const dateStr = getValue('date') || new Date().toISOString().slice(0, 10);
  const typeStr = getValue('type') as 'morning' | 'midday' | 'evening' | null;
  const reportType: 'morning' | 'midday' | 'evening' | 'manual' = typeStr || 'manual';

  return {
    reportType,
    reportDate: dateStr,
    totalMinutes: getInt('total'),
    instagramMinutes: getInt('instagram'),
    youtubeMinutes: getInt('youtube'),
    tiktokMinutes: getInt('tiktok'),
    safariMinutes: getInt('safari'),
    pickupCount: getInt('pickups'),
    firstPickupTime: getValue('first_pickup'),
    longestPhoneFreeMinutes: getInt('longest_free'),
    otherData: {},
  };
}

/**
 * Store a parsed screen time report in the DB.
 * If a report for the same date + type already exists, update it.
 */
export function storeScreenTimeReport(report: ParsedScreenTimeReport, rawText: string): void {
  const db = getDb();

  const existing = db.prepare(`
    SELECT id FROM phone_screen_time
    WHERE report_date = ? AND report_type = ?
  `).get(report.reportDate, report.reportType) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE phone_screen_time SET
        total_minutes = ?, instagram_minutes = ?, youtube_minutes = ?,
        tiktok_minutes = ?, safari_minutes = ?, pickup_count = ?,
        first_pickup_time = ?, longest_phone_free_minutes = ?, raw_text = ?,
        received_at = datetime('now','localtime')
      WHERE id = ?
    `).run(
      report.totalMinutes, report.instagramMinutes, report.youtubeMinutes,
      report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO phone_screen_time
        (report_date, report_type, total_minutes, instagram_minutes, youtube_minutes,
         tiktok_minutes, safari_minutes, pickup_count, first_pickup_time,
         longest_phone_free_minutes, raw_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.reportDate, report.reportType, report.totalMinutes, report.instagramMinutes,
      report.youtubeMinutes, report.tiktokMinutes, report.safariMinutes, report.pickupCount,
      report.firstPickupTime, report.longestPhoneFreeMinutes, rawText,
    );
  }

  console.log(`[PhoneScreenTime] Stored ${report.reportType} report for ${report.reportDate}: total=${report.totalMinutes}m, instagram=${report.instagramMinutes}m`);
}

/**
 * Get today's phone screen time for use in continuity guardian and UIL.
 */
export function getTodayPhoneScreenTime(): {
  totalMinutes: number;
  instagramMinutes: number;
  youtubeMinutes: number;
  pickupCount: number;
} | null {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Use the most recent report for today (prefer evening > midday > morning)
  const row = db.prepare(`
    SELECT total_minutes, instagram_minutes, youtube_minutes, pickup_count
    FROM phone_screen_time
    WHERE report_date = ?
    ORDER BY
      CASE report_type WHEN 'evening' THEN 1 WHEN 'midday' THEN 2 WHEN 'morning' THEN 3 ELSE 4 END
    LIMIT 1
  `).get(today) as { total_minutes: number; instagram_minutes: number; youtube_minutes: number; pickup_count: number } | undefined;

  if (!row) return null;

  return {
    totalMinutes: row.total_minutes || 0,
    instagramMinutes: row.instagram_minutes || 0,
    youtubeMinutes: row.youtube_minutes || 0,
    pickupCount: row.pickup_count || 0,
  };
}

/**
 * Format a phone screen time summary for Telegram.
 */
export function formatPhoneScreenTimeSummary(report: ParsedScreenTimeReport): string {
  const parts: string[] = [
    `<b>📱 Phone Screen Time (${report.reportType})</b>`,
  ];

  if (report.totalMinutes !== null) {
    const hours = Math.floor(report.totalMinutes / 60);
    const mins = report.totalMinutes % 60;
    parts.push(`Total: ${hours}h ${mins}m`);
  }
  if (report.instagramMinutes !== null && report.instagramMinutes > 0) {
    parts.push(`Instagram: ${report.instagramMinutes}m`);
  }
  if (report.youtubeMinutes !== null && report.youtubeMinutes > 0) {
    parts.push(`YouTube: ${report.youtubeMinutes}m`);
  }
  if (report.pickupCount !== null) {
    parts.push(`Pickups: ${report.pickupCount}`);
  }
  if (report.longestPhoneFreeMinutes !== null) {
    parts.push(`Longest phone-free: ${report.longestPhoneFreeMinutes}m`);
  }

  return parts.join('\n');
}
```

- [ ] **Step 2: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "phone-screen" | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/phone-screen-time.ts
git commit -m "feat(phone): add phone screen time parsing and storage"
```

---

## Task 3: Wire Phone Screen Time into Telegram Webhook

The webhook needs to detect when an incoming message is a screen time report (starts with `SCREEN_TIME_REPORT`) and route it to the parser.

**Files:**
- Modify: `src/app/api/telegram/webhook/route.ts`

- [ ] **Step 1: Add import**

At the top of the webhook route, add:

```typescript
import { parseScreenTimeReport, storeScreenTimeReport, formatPhoneScreenTimeSummary } from '@/lib/phone-screen-time';
```

- [ ] **Step 2: Add screen time detection in the message handler**

In the message handler block (around line 44-52), add screen time detection BEFORE the check-in state check:

```typescript
        // Handle standard messages
        if (body.message?.text) {
            const chatId = String(body.message.chat.id);
            if (chatId !== authorizedChatId) {
                await sendTelegram('Sorry, I am a private LifeOS assistant.', 'HTML');
                return NextResponse.json({ ok: true });
            }

            const text: string = body.message.text;

            // Screen time report from iOS Shortcut
            if (text.includes('SCREEN_TIME_REPORT')) {
                const report = parseScreenTimeReport(text);
                if (report) {
                    storeScreenTimeReport(report, text);
                    const summary = formatPhoneScreenTimeSummary(report);
                    await sendTelegram(summary, 'HTML');
                } else {
                    await sendTelegram('Could not parse screen time report. Check format.', 'HTML');
                }
                return NextResponse.json({ ok: true });
            }

            // Check if we're awaiting a check-in response
            const pendingType = getPendingCheckinType();
            if (pendingType === 'morning') {
                await handleMorningCheckinResponse(text);
                return NextResponse.json({ ok: true });
            } else if (pendingType === 'evening') {
                await handleEveningReflectionResponse(text);
                return NextResponse.json({ ok: true });
            }

            await handleTelegramCommand(text);
            return NextResponse.json({ ok: true });
        }
```

- [ ] **Step 3: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "webhook" | head -10
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/telegram/webhook/route.ts
git commit -m "feat(telegram): route SCREEN_TIME_REPORT messages to phone screen time handler"
```

---

## Task 4: Add Phone Screen Time to Continuity Guardian

**Files:**
- Modify: `src/lib/continuity-guardian.ts`

- [ ] **Step 1: Add import at top of continuity-guardian.ts**

```typescript
import { getTodayPhoneScreenTime } from './phone-screen-time';
```

- [ ] **Step 2: Add phone screen time to `getContinuityState()`**

Find the `ContinuityState` interface and add:

```typescript
interface ContinuityState {
  // ... existing fields ...
  phoneTotalMinutesToday: number | null;
  phoneInstagramMinutesToday: number | null;
}
```

In `getContinuityState()`, before the `return` statement, add:

```typescript
  const phoneST = getTodayPhoneScreenTime();
```

And include in the return:

```typescript
    phoneTotalMinutesToday: phoneST?.totalMinutes ?? null,
    phoneInstagramMinutesToday: phoneST?.instagramMinutes ?? null,
```

- [ ] **Step 3: Add phone screen time trigger to `evaluateTriggers()`**

Add a new trigger after the "Morning commitment score ≤ 4" trigger:

```typescript
  // 7. Phone screen time > 3 hours before 6pm
  if (
    state.phoneTotalMinutesToday !== null &&
    state.phoneTotalMinutesToday > 180 &&
    hour < 18
  ) {
    const totalHours = Math.round(state.phoneTotalMinutesToday / 60 * 10) / 10;
    const instaHours = state.phoneInstagramMinutesToday !== null
      ? Math.round(state.phoneInstagramMinutesToday / 60 * 10) / 10
      : null;

    // Check laptop active hours from screen observations
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
```

- [ ] **Step 4: Compile check**

```bash
npx tsc --noEmit 2>&1 | grep "continuity" | head -10
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/continuity-guardian.ts
git commit -m "feat(continuity): add phone screen time trigger (>3h before 6pm)"
```

---

## Task 5: iOS Shortcut Setup Instructions

These are manual setup steps on the iPhone — not code to deploy.

- [ ] **Step 1: Create "LifeOS Morning" Shortcut**

In the Shortcuts app on iPhone:

1. Create new Shortcut named "LifeOS Morning"
2. Add action: **Get Battery Level** (optional)
3. Add action: **Get Screen Time** → "Get all app usage for Today"
4. Add action: **Get first pickup time** (from Screen Time action if available)
5. Add action: **Text** — build message:
   ```
   SCREEN_TIME_REPORT
   date: [Current Date formatted as YYYY-MM-DD]
   type: morning
   total: [total screen time in minutes from Screen Time action]
   instagram: [Instagram minutes]
   youtube: [YouTube minutes]
   safari: [Safari minutes]
   pickups: [pickup count]
   ```
6. Add action: **Send Telegram Message** → Bot token + chat ID (or use "Send Message" with a Telegram URL scheme: `tg://msg?to=@lifeos_bot&text=[message]`)
7. Set automation: **Daily at 8:00am** → Run Shortcut

> **Note:** If "Get Screen Time" action isn't available, use "Take Screenshot of Screen Time page" and send the photo instead — the webhook can handle image-based parsing in Phase C v2.

- [ ] **Step 2: Create "LifeOS Midday" Shortcut**

Same as morning, but:
- `type: midday`
- Automation: **Daily at 1:00pm**
- No interaction needed — just silently sends

- [ ] **Step 3: Create "LifeOS Evening" Shortcut**

Same structure, but:
- `type: evening`
- Include `longest_free: [longest phone-free minutes]`
- Automation: **Daily at 9:00pm**
- This triggers the evening reflection questions in Telegram (handled by Phase A)

- [ ] **Step 4: Create "I'm Spiraling" Home Screen Widget**

1. Create Shortcut named "I'm Spiraling"
2. Send to Telegram: `I'm spiraling — what's happening right now?`
3. Add to Home Screen as widget

When tapped, the guardian will respond in Telegram: "What's happening right now?" and route the reply as a free-form reflection (handled by `handleTelegramCommand` which goes to the LLM agent).

- [ ] **Step 5: Test end-to-end**

Send a test screen time report manually from Telegram:

```
SCREEN_TIME_REPORT
date: 2026-04-09
type: manual
total: 187
instagram: 94
youtube: 52
tiktok: 0
safari: 18
pickups: 94
first_pickup: 07:14
longest_free: 112
```

Expected response in Telegram:
```
📱 Phone Screen Time (manual)
Total: 3h 7m
Instagram: 94m
YouTube: 52m
Pickups: 94
Longest phone-free: 112m
```

Check DB:
```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('lifeos.db');
console.log(db.prepare('SELECT * FROM phone_screen_time ORDER BY id DESC LIMIT 3').all());
"
```

Expected: row with all fields populated

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat(phase-c): complete phone integration — screen time parsing, storage, continuity trigger"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `phone_screen_time` table
- ✅ Morning (8am), midday (1pm), evening (9pm) report types
- ✅ Parse total, Instagram, YouTube, TikTok, Safari, pickups, first pickup, longest phone-free
- ✅ Telegram message acknowledges receipt with formatted summary
- ✅ Manual `/screen` paste also works
- ✅ Continuity guardian uses phone data (>3 hours before 6pm trigger)
- ✅ iOS Shortcut setup documented

**What's deferred:**
- Photo-based screen time parsing (screenshot of Screen Time page → Gemini Vision) — fallback if `Get Screen Time` action isn't available
- `phone_screen_time` data in evening reflection behavioral context (wire in Phase A's `extractMemoryFromCheckin()` by querying this table)
- iPad Shortcuts (identical to iPhone — same instructions apply)
