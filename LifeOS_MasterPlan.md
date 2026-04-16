# LifeOS — Master Plan
### From Focus Tracker to Personal Intelligence System
*Document synthesized from architecture review + vision conversation*

---

## 1. What LifeOS Actually Is

LifeOS started as a focus session enforcer. That's what it is today. What it needs to become is something fundamentally different:

> **A personal intelligence system that watches you live your life, understands why you do what you do, and holds you accountable to the person you said you want to be.**

Not a blocker. Not a dashboard. A guardian that knows you — built from behavioral data, honest self-report, and a growing model of your patterns that gets more accurate every week.

The distinction matters because the problems LifeOS needs to solve are not session-level problems. They happen in the hours before you decide not to show up. The system currently has zero visibility into that.

---

## 2. The Person LifeOS Is Built For

This is the most important section. The architecture flows from this.

**Rohan's honest self-assessment:**
- Gets overwhelmed by complex topics and steps back when material gets hard
- Procrastinates and postpones — always "after this one thing"
- Studies intensely for 4-5 days then suddenly stops — the streak cliff
- Works best under deadline pressure — completes things the night before
- Starts many things and doesn't finish them — the open loop problem
- Wants consistency, wants to build gradually, wants to finish what he starts

**What this actually means (reframed):**

This is not a discipline problem. It's three specific patterns:

**Pattern 1 — The Complexity Wall**
When a topic gets hard and the gap between current understanding and required understanding becomes visible, the brain treats that gap as threat, not challenge. The response is retreat — YouTube, Instagram, "I'll come back to it." The wall is invisible to the current system because absence looks like silence.

**Pattern 2 — The 4-5 Day Cliff**
Strong engagement produces dopamine. After 4-5 days the novelty fades and the real work begins. The brain, having learned that deadlines work, starts looking for permission to rest. This cliff is predictable and the system should treat day 4 differently than day 1.

**Pattern 3 — The Unfinished Loop Tax**
Every abandoned project sits in working memory and drains cognitive energy. The accumulation of unfinished things creates a background sense of failure that paradoxically makes starting new things harder. The system needs to make this visible and create rituals for closing loops.

**What LifeOS needs to do for this person:**
- Notice when he disappears, not just when he shows up
- Catch the cliff before the fall, not after
- Surface the unfinished things without guilt, with a path forward
- Ask honest questions at honest moments
- Never let him quietly vanish from an active goal

---

## 3. Current State — What's Built

### What exists and works well:

**Realtime Guardian (Phases 1-5 complete)**
- Chrome extension: tab events, dwell time, URL classification per session
- Focus score: weighted composite (continuity 35%, switches 25%, dwell 20%, distraction revisit 15%, idle 5%)
- Decision table: block / speak / silence — synchronous, ~5ms, zero AI on hot path
- TTS via macOS `say`: max 2 queued, urgent interrupts current
- Telegram: session start/end summaries, override keyboards, classification review
- Override adjudication: AI-assisted, scoped URL pattern + TTL, auto-expires, no global disable

**Memory Architecture (Phase 2 complete)**
4-tier system in `memory.ts` + `memory-extractor.ts`:
- **Working**: in-process session state
- **Episodic**: `mem_episodes` — structured event log with source + importance
- **Semantic**: `mem_facts` — distilled facts with Mem0-style ADD/UPDATE/DELETE/NOOP, temporal decay formula `importance × e^(-ageDays/halfLife) + 0.3 × log(1 + accessCount)`, FTS5 search, embedding vectors
- **Procedural**: `mem_procedures` — coaching macros with success/failure tracking

**Calibration System**
- `guardian-calibration.ts`: keyword-based signal extraction from session feedback
- Adjusts focus score weights per user over time (learning rate 0.02)
- Energy weight calibration (standup mood, time-of-day, circadian)

**Optimizer (Phase 6 ready)**
- Karpathy-style bounded loop — mutates policy artifacts only
- Gemini Pro generates mutation candidates from session history + eval failures
- Eval harness: 10 scenarios, hard-fail gates, canary validation before promotion
- Rollback on canary failure

**Intelligence Layer — UIL**
- `intelligence.ts`: `aggregateSignals()` pulls every signal in the system
- `runUILSynthesis()`: Gemini Pro produces `UserIntelligenceProfile` — narrative, coaching insights, goal momentum, distraction triggers, adaptive thresholds, energy model
- 30-minute cache, background refresh on session end
- `getIntelligenceContext()`: single function injected into every LLM prompt across the system
- `memory-extractor.ts`: called at session end + every 5 voice turns, populates `mem_facts`

### What exists but is incomplete:

**The opening line** — `generateOpeningLine()` in `longitudinal-engine.ts` uses 3 hardcoded templates. The UIL `currentNarrative` exists in the DB but doesn't feed session openers.

**Session reflections** — generated (60 words, Gemini Flash) and stored in `guardian_session_reflections`. The last 3 are fetched in `getDayBriefing()` but never actually used in output — they're passed to `openingMessage` which ignores them.

**Continuity guardian** — `detectGoalDrift()` exists and queries goals not touched in 7+ days. Nothing calls it proactively. Nothing sends a message when you disappear.

**Coaching insights** — `coachingInsights[]` in `UserIntelligenceProfile` are synthesized by Gemini Pro and sitting in the DB. They are injected as context into other LLM calls but never delivered directly to Rohan.

### What is entirely missing:

- macOS daemon (app tracking, window titles, wake/sleep)
- Screenshot pipeline (always-on visual context)
- Cross-device signal layer (iPhone, iPad)
- Morning check-in pipeline
- Evening reflection pipeline (the inside-out data layer)
- Weekly reckoning job
- `screen_observations` table
- Continuity guardian running on a schedule
- Post-override follow-up ("did that actually help?")
- Streak cliff detection and proactive response
- The "unfinished things" audit

---

## 4. The Core Architectural Gap

The UIL is sophisticated. The memory system is real. The problem is a **delivery gap** and a **signal gap**.

**Delivery gap**: The intelligence exists. Rohan never sees it. `currentNarrative`, `coachingInsights`, `weeklyProgressSummary` — all synthesized, all sitting in the DB, all used to make other LLM calls smarter. Never sent directly to the human.

**Signal gap**: `aggregateSignals()` is comprehensive on behavioral data. It has zero subjective data. It knows what Rohan does. It doesn't know what Rohan thinks about what he does, what he's telling himself, what the honest reason behind avoidance is. The inside-out layer is entirely missing.

The fix for both is the same: a structured daily conversation between Rohan and the guardian, delivered via Telegram, where honest answers become the richest data source in the system.

---

## 5. Full Vision — What LifeOS Becomes

### The Guardian's complete view of a day:

```
06:00  iPhone picked up for the first time (Shortcut logs this)
07:02  Instagram: 34 minutes before getting out of bed
08:00  Morning check-in received: "Feeling okay, plan to work on ML assignment. 6/10 likelihood."
10:47  MacBook opened (daemon logs wake event)
10:47  First app: Chrome → Instagram web (screenshot: "scrolling Instagram feed")
11:14  VS Code opened
11:15-13:30  Screenshots: "writing TypeScript code — LifeOS guardian-runtime.ts" (deep work)
13:30  Session started: Network Security Lab
14:47  Session ended: focus score 81, 1 block, 0 overrides
14:47  Reflection generated: "Strong session on NS lab. Staying away from ML assignment again."
15:00-17:30  Screenshots: "YouTube — watching MMA highlights", "Twitter — scrolling feed"
17:30  MacBook closed
21:00  iPhone Screen Time report received: Instagram 2h 14m, YouTube 1h 8m, total 4h 31m, 94 pickups
21:30  Evening reflection received (voice note, 2m 40s):
       "I avoided the ML assignment again. I think it's because I opened it last week
        and didn't understand the first section and that made me feel stupid. So I
        keep finding other things to do that feel productive."
```

The UIL synthesizes all of this. The guardian now knows: the avoidance of ML assignment is not laziness. It's fear of feeling incompetent. The coaching response changes entirely.

### What the guardian says vs. what it says now:

**Now (session-only view):**
> "Starting 60 minute focus block on Network Security. Your recent sessions averaged 74."

**Full-picture view:**
> "You've avoided the ML assignment for 9 days. Last time you opened it, you closed it in 6 minutes. You told me yesterday it's because you didn't understand the first section and that made you feel stupid. Tonight: open it for 20 minutes. Don't try to finish it. Just read the section that confused you and write one question about it. That's the whole task."

That second message is only possible with the inside-out data layer. No amount of tab tracking produces it.

---

## 6. Cross-Device Architecture

**Mental model**: Mac Mini is the brain. Every other device is a sensor. Telegram is the nervous system.

```
iPhone ──────────┐
iPad ─────────────┼──→ Telegram Bot ──→ Mac Mini (LifeOS) ──→ Telegram (back to Rohan)
MacBook ──────────┤         ↑
Chrome ext ───────┤         │
macOS daemon ─────┤         │
Screenshots ──────┘         │
                            │
                    Webhook handler routes:
                    /screen  → ingestPhoneScreenTime()
                    voice   → Whisper → memory extractor
                    photo   → Gemini Vision → screen time parse
```

### Mac Mini / MacBook — three layers:

**Layer 1: Chrome Extension** (already built)
Tab events, dwell time, URL classification. Stays session-scoped for intervention. No change needed.

**Layer 2: macOS Daemon** (to build)
Python LaunchAgent running every 60 seconds, always-on:

```python
{
  "timestamp": "2025-04-07T14:32:00",
  "frontmost_app": "YouTube",
  "window_title": "MMA Highlights - Best Knockouts 2024",
  "idle_seconds": 0,
  "machine_state": "active",
  "audio_playing": true,
  "running_apps": ["Chrome", "VS Code", "YouTube", "Spotify"],
  "first_open_today": "10:47:00",
  "machine_woke_at": "10:47:00"
}
```

Window title is critical. "YouTube" is noise. "MMA Highlights - Best Knockouts 2024 while VS Code is open" is signal.

**Layer 3: Screenshot Pipeline** (to build)
Every 60 seconds, waking hours, always-on (not session-gated):

```python
# screencapture → Gemini Vision → text description → mem_episodes → delete image
{
  "activity": "watching YouTube MMA highlights video",
  "category": "distraction",  # deep_work|shallow_work|consumption|distraction|idle
  "app": "YouTube",
  "content_type": "video",
  "attention_quality": "consuming",
  "specific_content": "MMA highlights compilation, not related to any active goal",
  "productive_for_goals": false,
  "confidence": 0.95
}
```

Screenshot is captured, analyzed, description stored, image immediately deleted. No raw images persist anywhere.

### iPhone — three Shortcuts:

**Morning (8am, automated):**
```
→ First phone pickup time today
→ Screen Time since midnight
→ Ask: "How are you feeling? What's today's one commitment? 1-10 likelihood of doing it?"
→ Send to Telegram bot
```

**Midday (1pm, automated):**
```
→ Screen Time so far today: Instagram, YouTube, total
→ Send to Telegram bot (no interaction needed, just data)
```

**Evening (9pm, automated):**
```
→ Full day Screen Time breakdown
→ Total pickups, longest phone-free stretch
→ Send to Telegram bot
→ Guardian sends evening reflection questions in response
```

**Manual: "I'm spiraling" button (home screen widget):**
One tap → sends "Manual check-in triggered" → guardian responds: "What's happening right now?"
This is for when Rohan catches himself mid-scroll and wants the guardian to intervene.

### iPad:
Same Shortcuts as iPhone. Chrome extension installed on iPad browser — connects to same Mac Mini LifeOS instance via local IP. Session-scoped tab tracking, same as desktop.

---

## 7. The Three Tracking Tiers

| Tier | What | Always-on? | Intervention? | Purpose |
|------|------|------------|---------------|---------|
| **Passive observation** | macOS daemon, screenshots, phone screen time | Yes | No | Day-level picture, feeds UIL |
| **Session-adjacent** | Screenshot pipeline during peak hours | Yes | No | Understanding work quality |
| **Active guardian** | Everything currently built | Session-scoped | Yes | Focus enforcement |

**Why not session-gate everything**: The intervention layer should stay session-scoped. The observation layer needs to be always-on. These are different concerns. Conflating them means the system only knows Rohan when he's already trying. The observation layer is what lets the system know the Rohan who's avoiding.

---

## 8. The Inside-Out Data Layer

This is what separates LifeOS from every other productivity tool. The tab data and screenshots are the outside-in view. Rohan's own voice is the inside-out view. Both are required for accuracy.

### Morning check-in (8am Telegram):
> "Good morning. What's your one commitment today? And honestly — how likely are you to actually do it, 1-10?"

The 1-10 score is a leading indicator. A 4 or below the evening before or morning of is a strong predictor of a skip day. The system responds to low scores with scaffolding, not motivation:

> "You said 4/10 for today. Let's make it stupidly small. One tab open, 20 minutes, that's it. What time are you starting?"

### Evening reflection (9:30pm Telegram, after screen time report lands):
Three questions. Voice note or text. Non-negotiable:

1. **"What did you avoid today, and what's the honest reason — not the reason you'd tell someone else, the actual reason?"**
2. **"What are you postponing that you keep telling yourself is for tomorrow?"**
3. **"How do you feel about showing up tomorrow, 1-10? Why that number?"**

These answers go directly to `extractMemoryFromVoice()`. The memory extractor runs a special analysis prompt that reads the answers against the day's behavioral data and looks for gaps between stated intent and revealed behavior.

### Post-override follow-up (20 minutes after any approved override):
> "You overrode the block for [site] 20 minutes ago. Did it actually serve your session, or did it spiral?"

Options: Helped / Spiraled / Somewhere in between (voice note)

Over time this builds a model of Rohan's self-deception patterns — which override reasons are genuine and which are rationalization.

### Voice reflection analysis prompt (special, runs on evening reflection):

```
This is Rohan's evening reflection. He has documented patterns:
- Strong 4-5 day streaks followed by sudden disengagement (the cliff)
- Avoiding complex topics when they get hard
- Deadline-driven work (night before completion)
- Starting many things, not finishing them

Today's behavioral data:
[screenshot summary: categories by hour]
[phone screen time: Instagram Xh, YouTube Xh, total Xh, pickups N]
[sessions today: N sessions, topics, focus scores]
[laptop open: first open Xam, total active hours Y]

His evening reflection (transcript):
"[transcript]"

Analyze for:
1. Signs of the cliff pattern starting
2. Topics he's rationalizing avoiding
3. Emotional state behind his words vs what the data shows
4. Gap between his stated intentions and likely actual behavior
5. What he's NOT saying that matters
6. Whether immediate guardian response is needed tonight

Return: memory operations + guardian_response_needed: true/false + response_text if needed
```

---

## 9. The Continuity Guardian

Runs every 30 minutes. Not once a day. Checks:

```typescript
interface ContinuityCheck {
  laptopOpenedToday: boolean;
  firstOpenTime: string | null;
  hoursDeepWorkToday: number;
  hoursDistractionToday: number;
  currentActivity: string;        // from last screenshot
  lastSessionDaysAgo: number;
  activeGoalLastTouchedDaysAgo: Record<string, number>;
  streakDay: number;
  phoneScreenTimeToday: number;   // minutes
  instagramTodayMinutes: number;
  morningCommitmentScore: number; // the 1-10 from morning check-in
  morningCommitment: string;      // what they said they'd do
}
```

### Specific triggers and exact messages:

**11am, laptop not yet opened:**
> "It's 11am. Your laptop hasn't opened yet today. Yesterday you said [commitment]. Still the plan?"

**First app after laptop open = Instagram/YouTube:**
> "First thing you opened was Instagram. 18 minutes ago. [commitment] is still waiting. What's the actual plan for this morning?"

**3 consecutive hours of distraction screenshots:**
> "The last 3 hours have been [specific content from screenshots]. You have [X] hours left in your peak window. One thing. What is it?"

**Day 4 of strong streak (evening):**
> "You're on day 4. Your strongest stretches look exactly like this. Tomorrow is historically when the slide starts — not because you decide to stop, but because you find reasons. What's the plan for tomorrow morning specifically? Not in general. The first 30 minutes."

**Topic not touched in 5 days:**
> "You haven't worked on [topic] in 5 days. Last session on it: focus score [X], [Y] minutes. What's actually going on with it?"

**Phone screen time > 3 hours before 6pm:**
> "Phone screen time is at [X] hours already today, [Y] of that was Instagram. Your laptop has been active for [Z] hours. The ratio is off. What's happening today?"

**Morning commitment score ≤ 4, it's now 2pm:**
> "This morning you said [commitment] but gave yourself [N]/10 on likelihood. It's 2pm. The data matches your prediction. What do you want to do with the rest of today?"

**Third override request in a session:**
> "This is your third override today. The first two were for [reasons]. I'm not blocking you — but what's actually happening right now? Not what you're about to tell me. What's actually happening."

---

## 10. The Weekly Reckoning

Every Sunday at 8pm. No softening.

Built from: full week of screenshot categories + phone screen time + sessions + morning scores + evening reflections + goal progress.

Format:

```
WEEK OF [DATE]

REALITY:
Laptop opened: 5/7 days
Average first-open time: 11:23am (peak window starts 9am — you're losing 2+ hours daily)
Deep work hours: 11.5h across 5 days
Distraction hours (screenshots): 8.2h
Instagram total (phone): 14.3 hours this week — 2h 2m per day
Sessions completed: 4 of 7 planned
Phone pickups average: 94/day

GOALS:
✓ Network Security — 3 sessions, on track
✗ ML Assignment — opened 3 times, closed within 8 minutes each time, 9 days avoided
✓ LifeOS — 2 sessions, active

PATTERN THIS WEEK:
You started strong Monday-Tuesday. Wednesday you opened Instagram at 10:14am before
VS Code. Thursday and Friday followed the same pattern. The ML assignment has been
opened and closed 3 times — you open it, feel the difficulty, and leave.

You told me on Thursday: "I think I'm scared I won't understand it and that'll make
me feel stupid." That's the most honest thing you've said about it.

ONE QUESTION I'M NOT MOVING ON FROM:
What specifically happens in the first 3 minutes when you open the ML assignment?
Walk me through it.

[Expects a response. Will follow up if none received by Monday morning.]
```

The last section matters. The guardian holds the thread. It doesn't reset on Monday morning and pretend the ML assignment doesn't exist.

---

## 11. The UIL Upgrades Needed

### Synthesis triggers (upgrade from current):
- Session end — already doing this ✓
- Every morning at 7:30am — before Rohan picks up his phone
- After evening phone report lands — so full day is synthesized before reflection questions
- When 3+ consecutive hours of distraction category detected mid-day
- After weekly reckoning response received

### Opening line replacement:
Replace `generateOpeningLine()` template with:
```
Given this intelligence profile: [getIntelligenceContext()]
And today's morning check-in: [commitment + score]

Write one sentence to open this guardian session on [topic] for [duration] minutes.
Be specific to what you know about this person. Reference actual recent patterns.
Do not use generic motivational language. Speak like a coach who has been watching.
```

### Insight delivery (currently missing):
After every session end, alongside the reflection, send to Telegram:
- Top 2 `coachingInsights` from current UIL profile
- Any updated `avoidancePatterns` detected this session
- If `goalMomentum` changed for any goal, name it

---

## 12. New Database Tables Needed

```sql
-- Primary new table: always-on screen observations
CREATE TABLE screen_observations (
  id INTEGER PRIMARY KEY,
  observed_at TIMESTAMP NOT NULL,
  app TEXT,
  window_title TEXT,
  activity TEXT,
  category TEXT CHECK(category IN (
    'deep_work','shallow_work','communication','consumption','distraction','idle'
  )),
  content_type TEXT,
  attention_quality TEXT CHECK(attention_quality IN (
    'focused','browsing','consuming','distracted'
  )),
  specific_content TEXT,
  productive_for_goals BOOLEAN,
  confidence REAL,
  session_id TEXT REFERENCES guardian_sessions(session_id),
  source TEXT DEFAULT 'screenshot' -- screenshot | daemon
);

-- Daily phone report
CREATE TABLE phone_screen_time (
  id INTEGER PRIMARY KEY,
  report_date DATE NOT NULL,
  report_type TEXT CHECK(report_type IN ('morning','midday','evening')),
  total_minutes INTEGER,
  instagram_minutes INTEGER,
  youtube_minutes INTEGER,
  tiktok_minutes INTEGER,
  safari_minutes INTEGER,
  other_data JSON, -- full app breakdown
  pickup_count INTEGER,
  first_pickup_time TIME,
  longest_phone_free_minutes INTEGER,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily check-in record
CREATE TABLE daily_checkins (
  id INTEGER PRIMARY KEY,
  checkin_date DATE NOT NULL,
  checkin_type TEXT CHECK(checkin_type IN ('morning','evening')),
  commitment TEXT,           -- morning: what they said they'd do
  likelihood_score INTEGER,  -- morning: 1-10
  avoidance_honest TEXT,     -- evening: Q1 answer
  postponed_item TEXT,       -- evening: Q2 answer
  tomorrow_score INTEGER,    -- evening: Q3 1-10
  tomorrow_reason TEXT,      -- evening: Q3 why
  raw_transcript TEXT,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Weekly reckoning record
CREATE TABLE weekly_reckonings (
  id INTEGER PRIMARY KEY,
  week_start DATE NOT NULL,
  reckoning_text TEXT,       -- full message sent
  open_question TEXT,        -- the one question that wasn't moved past
  response_text TEXT,        -- Rohan's answer
  response_received_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 13. Build Phases — In Order of Impact

### Phase A: The Inside-Out Layer (highest impact, build first)
*Why first: Without this, all downstream intelligence is outside-in only. This is the data that changes everything.*

1. Telegram webhook router for incoming messages (voice, text, photo, screen time data)
2. Morning check-in scheduled message (8am) + response handler
3. Evening reflection scheduled message (9:30pm) + voice transcription + deep analysis prompt
4. `daily_checkins` table
5. Memory extractor integration for check-in responses
6. Post-override follow-up (20 min after approval)

### Phase B: Mac Visibility (closes the largest blind spot)
*Why second: The system currently knows nothing about non-session time on Mac.*

1. macOS daemon — LaunchAgent Python script
   - App name + window title every 60 seconds
   - Wake/sleep event logging
   - Audio detection
   - Sends daily summary to LifeOS at midnight
2. Screenshot pipeline — always-on, 60-second interval
   - Gemini Vision analysis prompt returning structured JSON
   - `screen_observations` table
   - Immediate image deletion after analysis
3. Continuity guardian — runs every 30 minutes
   - Reads `screen_observations` + daemon data + sessions
   - Sends targeted Telegram messages on triggers

### Phase C: Phone Integration
*Why third: Phone is where the Instagram/Reels problem actually lives.*

1. iOS Shortcut — Morning (8am automated): first pickup, overnight screen time
2. iOS Shortcut — Midday (1pm automated): screen time so far, sends silently
3. iOS Shortcut — Evening (9pm automated): full day breakdown, triggers reflection
4. iOS Shortcut — Manual "I'm spiraling" home screen button
5. `phone_screen_time` table
6. Telegram webhook handler for incoming phone reports

### Phase D: Intelligence Delivery (closing the delivery gap)
*Why fourth: The intelligence exists. Rohan just never sees it.*

1. Morning UIL synthesis job (7:30am)
2. Replace `generateOpeningLine()` with UIL-powered opener
3. Post-session insight delivery via Telegram (insights, not just reflection)
4. Streak cliff detection on day 4 of any strong engagement streak
5. Weekly reckoning job (Sunday 8pm) + `weekly_reckonings` table
6. UIL synthesis triggers upgrade (mid-day distraction detection)

### Phase E: The Unfinished Things Audit
*Why fifth: Closing the open loop problem.*

1. Weekly audit job: every goal/topic engaged in last 30 days with completion status
2. "Open loops" Telegram message: not guilt, just facts + one actionable suggestion
3. Guardian holds the thread — references open questions from previous week
4. Monthly pattern letter: synthesized from 4 weeks of reckonings

---

## 14. Challenges and Solutions

### Challenge: Screenshot API cost at 60-second intervals
**At full frequency**: 840 calls/day × 30 days = 25,200 calls/month  
**Solution**: Gemini Flash Vision is cheap. But for additional control — run at 60 seconds during historical peak hours and first/last hour of laptop activity. Drop to 3-minute intervals during known low-value windows. Kill switch available if needed.

### Challenge: Privacy — screenshots going to Gemini API
**Rohan's position**: Explicitly comfortable with this.  
**Mitigations anyway**:
- Image deleted immediately after analysis (never stored locally or remotely)
- Only text description persists
- Window title sanitization for anything containing passwords/credentials (detect `*` password fields, don't send those screenshots)
- Option to pause pipeline for sensitive work (one Telegram command)

### Challenge: iOS Screen Time API limitations
**Problem**: No public API for programmatic Screen Time access.  
**Solution**: iOS Shortcuts "Get Screen Time" action (iOS 17+) gives app-by-app breakdown. Automated at 9pm, sends to Telegram bot. 10 seconds of Rohan's time. Fallback: screenshot of Screen Time screen → Gemini Vision reads it.

### Challenge: The system knows what Rohan does but not why
**Problem**: Behavioral data is outside-in. Screenshots can see 2 hours of reels but not whether that's avoidance or genuine recovery.  
**Solution**: The inside-out layer (morning/evening check-ins + voice reflections). The memory extractor reads both together. Over time the system builds a model of which behavioral signatures correspond to which internal states *for Rohan specifically*.

### Challenge: Rohan might game the system
**Problem**: If the system only responds to what Rohan tells it, he might tell it what it wants to hear.  
**Solution**: The voice reflection analysis prompt explicitly reads answers against behavioral data. If Rohan says "I worked hard today" and screenshots show 6 hours of distraction, the system names the gap. Not accusatorially. Factually. "You said it was a productive day. The data shows 6.2 hours in consumption category. What am I missing?"

### Challenge: The system becomes annoying or preachy
**Problem**: Too many messages, too much guilt, Rohan mutes it.  
**Solution**: Continuity guardian has a message limit — max 2 proactive messages per day outside sessions. Weekly reckoning is one message. Morning and evening are scheduled, not reactive. The guardian speaks when it matters, not constantly. The silence rule from the session guardian applies to life coaching too: if things are going well, stay quiet.

### Challenge: Context window as data grows
**Problem**: Months of sessions, reflections, voice turns, screen observations — UIL synthesis context gets large.  
**Solution**: Already solved architecturally. `aggregateSignals()` uses tiered retention:
- Raw screen observations: 14-day rolling window
- Session summaries: permanent (small)
- Daily digests: permanent (small)
- Semantic facts in `mem_facts`: decay-scored, FTS retrieval, max 40 injected per synthesis
- UIL profile: versioned, only latest read

### Challenge: The 4-5 day cliff — system can't prevent it
**Problem**: You can't force consistency. The system can only make the gap visible.  
**Solution**: The guardian doesn't try to prevent the cliff. It prepares for it. On day 4, the message changes. Not "great streak!" but "Tomorrow is historically when this ends. What's one small thing you'll do tomorrow even if you don't feel like it?" The answer goes into the next day's morning check-in as a commitment to hold.

---

## 15. The Human-Guardian Contract

This is the most important section after "The Person LifeOS Is Built For."

**What the guardian commits to:**
- Notice when Rohan disappears, not just when he shows up
- Hold the thread — never forget an open question or an unfinished thing
- Be specific, not generic — reference actual data, actual patterns, actual words he used
- Never use guilt — use facts and reflection
- Stay quiet when things are going well
- Ask honest questions, not rhetorical ones
- Expect answers

**What Rohan commits to:**
- Share phone screen time every evening (30 seconds)
- Answer morning commitment question honestly, including the 1-10 score
- Answer evening reflection questions with the actual reason, not the presentable reason
- When the guardian asks a direct question — answer it directly
- Not opening VS Code to feel productive while doing nothing

**The accuracy principle:**
The system will only understand Rohan as well as Rohan is willing to understand himself and feed that understanding in. The behavioral data is the shadow. The voice reflections are the thing itself. Together they approach accuracy. Either one alone is insufficient.

---

## 16. What Success Looks Like — 90 Days Out

**Week 1-2**: The system knows Rohan's full day for the first time. Phone data lands. Screenshot pipeline runs. Morning/evening check-ins establish baseline. `mem_facts` starts populating with real patterns.

**Week 3-4**: The UIL synthesis has enough inside-out data to produce a `currentNarrative` that is genuinely accurate — not "you tend to study in the mornings" but "you avoid ML assignment specifically when the first section of a new chapter is unclear, and you replace it with LifeOS work because it feels productive without the discomfort."

**Month 2**: The guardian catches the cliff before it happens twice in a row. The ML assignment gets touched for the first time in weeks — not because Rohan suddenly has willpower but because the guardian made the avoidance visible and gave him a stupidly small task to start with.

**Month 3**: The weekly reckoning becomes the most important 10 minutes of Rohan's week. Not because it's punishing but because it's the clearest mirror he has. He starts answering the open questions before the guardian has to follow up.

**The real goal**: Not a better focus score. Not more sessions. A person who has learned to notice the patterns that were invisible before — because a system showed them to him, consistently, honestly, over time.

> *"I want someone who nurtures me, who helps me reach from 0 to 1, who holds me accountable, who makes me do work, who understands me and helps me achieve my goals, who grows with me as I grow."*
>
> That's what this becomes. Not immediately. Over time. If the data goes in and the honesty goes in — it grows with you.

---

## 17. How Screen-Seeing Apps Actually Work

*Context: How tools like Clicky (cursor-adjacent AI teacher) see your screen — and what this means for the LifeOS screenshot pipeline.*

There are three distinct mechanisms. Most apps combine two or more of them.

---

### Mechanism 1: Accessibility API (most common, lightest weight)

This is how most cursor-adjacent tools work. On macOS, the Accessibility API lets any app with permission read — without taking a screenshot:

- What app is frontmost
- All text currently on screen
- Every UI element (buttons, text fields, menus, their positions)
- Where the cursor is
- What text is selected

It's structured screen reading. The OS already maintains a complete tree of everything visible — the Accessibility API just exposes it. No screenshot, no vision model, almost zero CPU. The app is listening to a data stream the OS is already producing.

**Limitation**: can't understand images, video content, or anything non-text. It reads the UI structure, not the pixels.

---

### Mechanism 2: Screenshot + Vision Model (what Clicky uses for rich context)

For understanding actual content — not just which app, but what's on screen — you need pixels. The flow:

```
screencapture (OS native call, ~50ms)
  → compress image
  → send to vision model (GPT-4V, Gemini Vision)
  → get text description back
  → act on description
  → discard image
```

On macOS this uses `CGWindowListCreateImage` or the `screencapture` CLI. The screenshot itself never needs to persist. The vision model call happens, returns a text description, image is discarded. What remains is text: "user is watching a YouTube MMA video while VS Code is open in background."

This is exactly how Clicky's pointing feature works — screenshot → "what is the user hovering over?" → cursor-positioned response overlay.

---

### Mechanism 3: OS-Level Screen Recording Permission (most powerful)

Apps like Loom or always-on AI assistants request `Screen Recording` in macOS Privacy Settings. With this they can read every pixel continuously from any app at any frame rate.

In practice nobody processes 60fps through a vision model — cost and CPU would be absurd. So even with full permission, they sample: every 1-5 seconds, or on change detection (compare frames, only call vision model when something meaningfully changed).

---

### How Clicky Specifically Works

It's a transparent overlay window — macOS `NSWindow` with level set above all other windows and `isOpaque = false`. Visually it floats next to your cursor.

- **Sees your screen**: Screen Recording permission + periodic screenshots
- **Points at things**: cursor position from the OS event stream (no special permission — cursor coordinates are a standard system event any app can subscribe to)
- **Understands content**: screenshot → vision model → response

The "AI that sees everything" feeling is: screenshot every N seconds + vision model + cursor tracking. The mechanism is simple. The experience feels like magic.

---

### What This Means for the LifeOS Screenshot Pipeline

The 60-second screenshot approach is exactly right. One important optimization to add before building:

**Change detection before calling the vision model.** If the screen hasn't meaningfully changed since the last capture, skip the API call and carry forward the previous classification. This cuts costs significantly without losing accuracy.

```python
import hashlib

def should_analyze(prev_hash: str, current_bytes: bytes) -> tuple[bool, str]:
    current_hash = hashlib.md5(current_bytes).hexdigest()
    if current_hash == prev_hash:
        return False, current_hash  # Pixel-identical — skip
    return True, current_hash       # Changed — send to vision model
```

For more sophisticated detection, compare image histograms — catches cases where the page scrolled slightly but content is essentially the same (still reading the same article, no need to re-classify).

**Practical impact**: 60-second interval becomes "check every 60 seconds, call vision model only when something changed." In practice: 200-300 vision calls per day instead of 840, covering the same information. The person reading the same research paper for 20 minutes generates one classification, not 20.

**The full pipeline with change detection:**

```python
prev_hash = None
prev_classification = None

while True:
    time.sleep(60)
    
    # Capture
    subprocess.run(['screencapture', '-x', '-t', 'jpg', '/tmp/lifeos_snap.jpg'])
    with open('/tmp/lifeos_snap.jpg', 'rb') as f:
        img_bytes = f.read()
    subprocess.run(['rm', '/tmp/lifeos_snap.jpg'])  # delete immediately
    
    # Change detection
    changed, current_hash = should_analyze(prev_hash, img_bytes)
    
    if not changed:
        # Carry forward previous classification — no API call needed
        log_observation(prev_classification, source='carried_forward')
        continue
    
    # Vision model call only when content changed
    classification = call_gemini_vision(img_bytes)
    log_observation(classification, source='vision_model')
    
    prev_hash = current_hash
    prev_classification = classification
```

This is the production-grade version of the pipeline. Build it this way from the start rather than retrofitting change detection later.

---

---

## 18. Voice Architecture

*What exists, what's missing, and what to build for the new reflection and check-in use cases.*

---

### What's Already Built

- Push-to-talk via Telegram voice notes → Whisper transcription → intent parsing → guardian actions
- macOS `say` for TTS output during sessions
- `guardian-voice.ts` handles the full pipeline including multi-turn conversation history
- `voice_turns` table persists conversation history per session key
- Local `whisper.cpp` architected in `docs/LOCAL_WHISPER_CPP.md`

This covers the **command interface** — "start session", "override", "status", "tutor mode." It works.

---

### What's Missing

The new voice use cases are different in nature. Not commands. Conversations. Specifically:

- Morning check-in (speaking about the day ahead, honest likelihood score)
- Evening reflection (3 questions, voice answers, the most important data in the system)
- Weekly reckoning response (answering the open question)
- The "I'm spiraling" moment — catching yourself mid-scroll and talking to the guardian about what's actually happening

These are emotional and reflective — longer, messier, more important than session commands. The pipeline handles them technically but the analysis layer on the other end isn't built for them.

---

### Three Decisions

**Decision 1 — Input: where does voice come from?**

**Telegram voice notes** — send a voice note to the bot from any device. iPhone, iPad, Mac. Already on every device, no new app, no new friction. The webhook receives the audio file, downloads it, passes to Whisper, gets transcript, routes to analysis. This is the right choice for reflections and check-ins. Low friction, works everywhere, already integrated.

**Local wake word on Mac** — "hey LifeOS" running locally via `whisper.cpp` + `Silero VAD`. Already architected. Good for in-session moments at the desk — when you want to say something without picking up your phone.

Not for reflections — you don't want to do your honest evening reflection sitting at your desk. You want to do it on your phone, relaxed, wherever you are.

**→ Telegram voice notes for reflections and check-ins. Local wake word for in-session moments. Both.**

---

**Decision 2 — Transcription: local or cloud?**

Both options are already built — local `whisper.cpp` and cloud options via Gemini.

For reflections specifically — where you're saying honest, personal things — **local Whisper is the right call.** The transcript stays on your machine. Only the extracted memory facts go to Gemini for analysis, not the raw transcript.

The raw transcript of "I think I'm scared I won't understand the ML assignment and that'll make me feel stupid" should not leave your machine in raw form. What goes to Gemini is the fact extracted from it: `pattern/avoidance: avoids ML assignment when first section is unclear — fear of appearing incompetent`. That's what enters the memory system.

**→ Whisper local for transcription. Gemini Flash for analysis of the transcript. Raw audio and raw transcript stay local.**

---

**Decision 3 — Output: how does the guardian speak back?**

Three options in increasing quality:

**macOS `say`** — already working, free, instant, robotic. Fine for "you've been idle 8 minutes." Not right for "here's what I think is actually happening with you this week."

**Kokoro TTS** — higher quality, still fully local, runs on Mac Mini. Already mentioned in the architecture docs. Sounds like a real person. Right choice for the guardian's more important messages — coaching insights, weekly reckoning, opening lines.

**Telegram voice message** — the guardian sends you a generated audio message on Telegram that you play on your phone. Right for anything you receive away from your desk — morning briefing, post-session reflection delivery, weekly reckoning.

**→ `say` for in-session interruptions (already built, fast). Kokoro for high-quality local output at desk. Telegram voice message for anything delivered to phone.**

---

### What to Actually Build

**Step 1: Telegram webhook handles incoming voice notes**

```typescript
if (update.message?.voice) {
  const fileId = update.message.voice.file_id;
  const audioBuffer = await downloadTelegramFile(fileId);
  
  // Transcribe locally via whisper.cpp
  const transcript = await transcribeLocal(audioBuffer);
  
  // Detect context from conversation state
  const context = detectVoiceContext(update.message.from.id);
  // 'morning_checkin' | 'evening_reflection' | 'reckoning_response' | 'freeform'
  
  if (context === 'evening_reflection') {
    await processEveningReflection(transcript, update.message.from.id);
  } else if (context === 'morning_checkin') {
    await processMorningCheckin(transcript, update.message.from.id);
  } else {
    await processGuardianVoiceCommand({ transcript });
  }
}
```

**Step 2: Context detection**

The guardian knows what mode it's in based on what it last sent. If it sent the evening reflection questions 2 minutes ago, the next voice note is an evening reflection answer. Simple state tracking per user in SQLite — `voice_context` table with `user_id`, `context`, `expires_at`.

**Step 3: Evening reflection processing pipeline**

```typescript
async function processEveningReflection(transcript: string, userId: number) {
  // 1. Store raw transcript locally — never leaves machine in raw form
  await storeReflectionTranscript(transcript, 'evening');
  
  // 2. Pull today's behavioral data
  const todayData = await aggregateTodaySignals();
  // screenshot categories by hour, phone screen time, sessions, laptop open time
  
  // 3. Deep analysis — transcript vs behavioral data
  // Gemini Flash reads what was said against what the data shows
  // Looks for: avoidance patterns, gaps between stated intent and behavior,
  // what's not being said, signs of the cliff pattern starting
  const analysis = await analyzeReflectionAgainstData(transcript, todayData);
  
  // 4. Memory extraction
  await extractMemoryFromVoice(
    [{ role: 'user', text: transcript }],
    'evening_reflection'
  );
  
  // 5. Guardian responds if immediate response needed
  if (analysis.immediateResponseNeeded) {
    await sendTelegram(analysis.responseText);
  }
  
  // 6. Persist to daily_checkins
  await storeDailyCheckin('evening', transcript, analysis);
}
```

**Step 4: The reflection analysis prompt (the critical piece)**

```
This is Rohan's evening voice reflection. He has documented patterns:
- Strong 4-5 day streaks followed by sudden disengagement
- Avoiding complex topics when they get hard  
- Deadline-driven work (night before completion)
- Starting many things, not finishing them

TODAY'S BEHAVIORAL DATA:
[screenshot category breakdown by hour]
[phone screen time: Instagram Xh, YouTube Xh, total Xh, pickups N]
[sessions: N sessions on [topics], focus scores]
[laptop: first opened Xam, total active Yh]
[morning commitment: "[what he said]", likelihood score: N/10]

REFLECTION TRANSCRIPT:
"[transcript]"

Analyze for:
1. Gap between what he said and what the data shows
2. Signs of the cliff pattern starting
3. Topics he's rationalizing avoiding
4. Emotional state behind the words — what the words are covering
5. What he's NOT saying that matters as much as what he is saying
6. Whether immediate guardian response is needed tonight

Return:
- memory_ops: [...] — facts to extract
- immediate_response_needed: true/false
- response_text: "..." — if needed, what to send
- flag_for_weekly_reckoning: true/false — if this needs to be held and referenced Sunday
```

**Step 5: Local wake word for Mac (in-session)**

```bash
# LaunchAgent runs whisper.cpp with Silero VAD
# Listens for "hey LifeOS"
# On detection: records until silence, passes to guardian-voice.ts
npm run guardian:stt-local  # already in your package.json
```

Handles the in-session "hey LifeOS, I'm about to spiral, stop me" moment. Hands-free, at desk, no phone needed. Already architected — just needs to be connected to the continuity layer, not just the session layer.

---

### The One Addition Not in Current Plan

**Voice note quality check for reflections.**

If a reflection voice note is under 30 seconds, the guardian responds:

> "That was quick. The three questions were about avoidance, postponement, and tomorrow's likelihood. Which one did you answer? Send me the other two."

Not harsh. Just holding the standard. The depth of what goes in is the depth of what comes out. A 10-second vague answer extracts almost nothing useful. A 3-minute honest answer rewrites what the system knows about you.

---

### Build Order for Voice

1. Telegram webhook handles incoming voice notes → local Whisper transcription
2. Context detection — `voice_context` table, state per user
3. Evening reflection processing pipeline with behavioral data comparison
4. Morning check-in voice processing
5. Reflection quality check (under 30 seconds → ask for more)
6. Kokoro TTS for high-quality guardian voice output
7. Local wake word connected to continuity layer (not just session layer)
8. Guardian sends Telegram voice messages for phone-delivered insights

---

### Privacy Summary for Voice

| Data | Where it lives | Goes to cloud? |
|------|---------------|----------------|
| Raw audio | Deleted after transcription | Never |
| Raw transcript | Local SQLite only | Never |
| Extracted memory facts | Local SQLite | Gemini Flash for analysis only |
| Guardian's spoken responses | Local Kokoro / macOS say | Never |
| Guardian's Telegram voice messages | Generated locally, sent via Telegram API | Telegram API only |

The most personal data — what you actually say about yourself in your own words — never leaves your machine in raw form.

---

---

## Section 0: The Real Requirements

*This section comes last in the document but should be read first. Before any architecture. Before any build plan.*

LifeOS only works if you use it. Not occasionally. Consistently. The most sophisticated AI guardian in the world produces nothing for someone who hasn't built the habit of engaging with it.

There is also a specific failure mode for someone who genuinely enjoys building things: **building LifeOS becomes the thing you do instead of the things LifeOS is supposed to help you do.** Adding features feels like progress. The architecture gets more sophisticated. The document gets longer. The ML assignment stays untouched.

The test is simple: are you currently using what's already built? Is Telegram sending you messages? Are you doing sessions and getting reflections? Is the semantic profile populated with real data from real sessions?

If yes — keep building. Everything in this document compounds on a working foundation.

If no — stop adding features. Use what exists for two weeks. Then build more.

---

**Minimum viable engagement — what "using LifeOS" actually means daily:**

| Time | Action | Time cost |
|------|---------|-----------|
| 8:00am | Answer morning check-in on Telegram | 60 seconds |
| Whenever | Start at least one guardian session | Variable |
| 9:00pm | Share Screen Time screenshot | 30 seconds |
| 9:30pm | Answer evening reflection (voice note) | 3 minutes |
| Sunday 8pm | Read weekly reckoning, respond to open question | 10 minutes |

**That's it. Four and a half minutes of deliberate input per day.** Everything else — the intelligence synthesis, the memory extraction, the coaching insights, the pattern detection — happens automatically. But it only happens if those four and a half minutes go in.

If you do this consistently for 30 days, the system will know you better than any tool you've ever used. If you do it sporadically, it will know you approximately as well as a calendar.

---

## 19. Knowledge Graph Connected to Coaching

*Currently missing: the learning graph is disconnected from the guardian's accountability layer.*

### The Gap

LifeOS has a knowledge graph — concept nodes, mastery scores (0.0–1.0), prerequisites, bloom levels, decay rates. It tracks what you've learned with genuine sophistication. But the continuity guardian and the weekly reckoning don't read from it.

So the system can say "you haven't studied ML in 9 days." It cannot say "you're at 34% mastery on backpropagation, which is a prerequisite for transformer architecture — the topic you said you want to understand before your exam in 6 weeks. At your current pace you won't clear the prerequisite in time."

That's a fundamentally different kind of accountability. Not just presence/absence but concrete cost of avoidance expressed in terms of what actually matters to Rohan.

### What to Add

**Weekly reckoning includes one knowledge graph line per active goal:**

```
LEARNING PROGRESS:
Network Security:
  ✓ Cryptographic Protocols: 78% mastery (strong)
  → Secure Channel Design: 45% mastery (current focus, on track)
  ✗ Formal Verification: 12% mastery (prerequisite for final project, 3 weeks away)

ML Assignment:
  ✗ Backpropagation: 34% mastery
  ✗ Gradient Descent variants: 21% mastery
  ↓ Both required before transformer architecture
  ↓ At current engagement rate: will not reach threshold before deadline
```

**Opening line uses mastery data:**

Instead of "your recent sessions averaged 74" — "you're at 45% on Secure Channel Design, which is the unlock point for the next module. One session today takes you past halfway."

**Continuity guardian reads prerequisite gaps:**

If a prerequisite node hasn't been touched in 7+ days and the dependent concept has a deadline within 3 weeks, the guardian fires:

> "You have an exam on transformer architecture in 18 days. Backpropagation is a prerequisite and you're at 34% mastery. That gap needs 4-5 focused sessions to close. The first one needs to happen this week."

### Implementation

```typescript
// Add to weekly reckoning job
const knowledgeGaps = await getKnowledgeGraphGaps({
  userId: 'default',
  deadlineWithinDays: 30,
  masteryThreshold: 0.6,  // below this = at risk
  includePrerequisiteChains: true
});

// Add to continuity guardian check
const blockedConcepts = await getBlockedConceptsByDeadline();
if (blockedConcepts.length > 0) {
  await sendTelegram(buildKnowledgeGapAlert(blockedConcepts));
}
```

---

## 20. The Friction Audit

*Currently missing: the system detects avoidance but never asks what specifically makes something hard.*

### The Problem with "You're Avoiding X"

Knowing you're avoiding something is half the information. The other half is: what specifically is the hard part?

For the ML assignment, it might be:
- Starting from a blank page (task initiation friction)
- Not knowing if you're doing it right (fear of being wrong)
- The first section being unclear (comprehension block)
- The task being too vague — "work on ML" means nothing (missing specificity)
- Feeling like you need to catch up before you can start (perfectionism trap)

Each of these has a different fix. The guardian can't apply the right fix until it knows which one it is. Right now it applies the same generic accountability to all of them.

### The Friction Audit — Monthly

Once a month, the guardian sends a specific message for each consistently avoided topic:

> "You've avoided your ML assignment 11 times in the last 30 days. I want to understand why so I can actually help. Answer this honestly:
>
> When you think about opening the ML assignment right now, what specifically happens? Walk me through the first 60 seconds in your head."

The answer goes to memory extraction with high importance. The fact extracted is not "avoids ML" — it's the specific friction type. That fact then shapes every future nudge about that topic.

### Friction Types and Guardian Responses

| Friction type | What the guardian does differently |
|---------------|-----------------------------------|
| Task initiation | Breaks the task into a 5-minute starting ritual |
| Fear of being wrong | Reframes: "wrong answers are part of the process, show me your attempt" |
| Comprehension block | Identifies the specific unclear concept, suggests one resource |
| Task too vague | Refuses to accept "work on X" — demands specific deliverable |
| Perfectionism trap | Sets a minimum viable session: "open it, write anything, close it" |
| Energy/timing mismatch | Reschedules to peak energy window based on UIL data |

### Implementation

```typescript
// Run monthly for each goal with >3 avoided sessions
async function runFrictionAudit(goalTitle: string) {
  const avoided = await getAvoidedSessions(goalTitle, 30);
  if (avoided.length < 3) return;
  
  await sendTelegram(
    `You've avoided "${goalTitle}" ${avoided.length} times this month.\n\n` +
    `I want to understand why so I can actually help.\n\n` +
    `When you think about opening it right now — what specifically ` +
    `happens in your head in the first 60 seconds? Voice note or text.`
  );
  
  // Store that we asked — await response, route to memory extraction
  await storePendingFrictionAudit(goalTitle);
}
```

---

## 21. The Recovery Protocol

*Currently missing: the system warns about the cliff but has no specific response for the 48 hours after it.*

### Why the 48 Hours After the Cliff Are the Most Dangerous

The cliff itself — day 5, sudden disengagement — is predictable and the guardian can warn about it. But the real damage happens in the 2 days after.

The thought pattern is: "I broke the streak. I was doing so well and now I've ruined it. What's the point of starting again when I'll just quit again." This shame spiral is more likely to end the goal entirely than the cliff itself was.

The current system has no specific response to this. The continuity guardian sends a message if you've been absent 2+ days. But it sends the same kind of message it would send on any absence. It doesn't know that this absence is different — that it follows a strong streak, that this is the specific moment where people quit.

### The Recovery Protocol — Exact Messages

**Day 1 after cliff (first missed day after 4+ day streak):**

> "Yesterday was your first miss after a strong [N]-day run. That's the pattern — it happens almost every time around this point. Not a failure. Exactly what happens.
>
> Tomorrow: one thing, 20 minutes. Not to catch up. Just to reconnect. The streak is gone — the work isn't."

**Day 2 after cliff (if still absent):**

> "Two days now. This is the moment where it either becomes a proper break or becomes a stop.
>
> One question: do you want to keep going with [goal]? Not should you — do you want to?
>
> If yes: tonight, open it for 10 minutes. Literally 10. If no: tell me and we'll close the loop properly rather than let it hang."

The second message is important. Giving explicit permission to quit — combined with the alternative of a genuinely small action — often breaks the spiral. The shame comes from the implicit pressure of an undefined open loop. Naming it removes the shame.

**Day 3+ (if still absent):**

Guardian stops sending daily messages about it. Instead it adds the goal to the Friday "open loops" list and the weekly reckoning. Persistent daily nudging after day 3 becomes nagging and produces avoidance of the guardian itself.

### Implementation

```typescript
// Add to continuity guardian — runs every 30 minutes
async function checkCliffRecovery() {
  const recentStreaks = await getRecentStreakCliffs();
  // A streak cliff = 4+ day streak followed by 1+ day absence
  
  for (const cliff of recentStreaks) {
    const daysSinceCliff = cliff.daysSinceLastSession;
    
    if (daysSinceCliff === 1 && !cliff.day1MessageSent) {
      await sendRecoveryDay1Message(cliff.goalTitle, cliff.streakLength);
      await markRecoveryMessageSent(cliff.id, 'day1');
    } else if (daysSinceCliff === 2 && !cliff.day2MessageSent) {
      await sendRecoveryDay2Message(cliff.goalTitle);
      await markRecoveryMessageSent(cliff.id, 'day2');
    }
    // Day 3+: silence from continuity guardian, appears in weekly reckoning only
  }
}
```

---

## 22. Success Pattern Analysis

*Currently missing: the system studies what goes wrong but not what goes right.*

### The Asymmetry Problem

The current system is heavily oriented toward failure detection — distraction tracking, avoidance detection, cliff warnings, override analysis. This is right and necessary. But it creates an asymmetry: the guardian knows a lot about your worst patterns and very little about your best ones.

When you have a genuinely great session — high focus score, deep work, felt good, finished what you started — the guardian generates a reflection and moves on. It doesn't systematically ask: what were the conditions that made this session different from the ones that went badly?

Over 15-20 sessions the system should be able to answer: what specific conditions reliably produce Rohan's best work?

### What to Track on High-Quality Sessions

A session is "high quality" when: focus score >80 AND elapsed time >80% of planned AND no override requests.

On these sessions, the guardian captures:

```typescript
interface SessionConditions {
  startTime: number;               // hour of day
  dayOfWeek: number;               // 0-6
  timeSinceWakeUp: number;         // minutes between first laptop open and session start
  firstThingOpenedToday: string;   // app from daemon — phone or VS Code or Instagram?
  taskSpecificity: 'vague' | 'specific' | 'very_specific';  // from session intent
  topicFamiliarity: 'new' | 'continuing' | 'reviewing';     // new vs returning topic
  phoneInFirstHour: boolean;       // from screen time data
  hadCommitment: boolean;          // was there a morning commitment for this?
  commitmentScore: number;         // morning 1-10 score
  energyEstimate: 'high' | 'medium' | 'low';  // from UIL at session start
  precedingActivity: string;       // what was happening in the hour before
}
```

### What the Analysis Produces

After 10+ high-quality sessions, the UIL synthesis identifies the common conditions. Example output:

```
YOUR BEST SESSION CONDITIONS (based on 12 high-quality sessions):

Shared across 10/12:  Started before 10:30am
Shared across 9/12:   Task was specific, not vague ("finish section 3.2" not "work on ML")
Shared across 9/12:   No phone in first 45 minutes of the day
Shared across 8/12:   Continuing a topic, not starting something new
Shared across 7/12:   Morning commitment score was 7 or above
Shared across 7/12:   Preceded by 10+ minutes of something non-screen (food, walk)

NOT correlated with quality: time of sleep, day of week, topic difficulty
```

The guardian uses this proactively:

> "You're about to start a session on transformer architecture — a new topic. Your best sessions are on continuing topics. Consider: spend the first 20 minutes reconnecting with backpropagation before moving into the new material."

Or at morning check-in:

> "It's 11:20am. 8 of your 12 best sessions started before 10:30. The window is closing but not gone. How quickly can you start?"

### Implementation

```typescript
// Run after every high-quality session
async function captureSuccessConditions(sessionId: string) {
  const session = await getSessionById(sessionId);
  if (!isHighQualitySession(session)) return;
  
  const conditions: SessionConditions = {
    startTime: getHourFromTimestamp(session.startedAt),
    dayOfWeek: getDayOfWeek(session.startedAt),
    timeSinceWakeUp: await getTimeSinceFirstLaptopOpen(session.startedAt),
    firstThingOpenedToday: await getFirstAppToday(),
    taskSpecificity: await inferTaskSpecificity(session.targetTitle),
    topicFamiliarity: await getTopicFamiliarity(session.conceptNodeId),
    phoneInFirstHour: await getPhoneUsageInFirstHour(),
    hadCommitment: await hadMorningCommitmentFor(session.targetTitle),
    commitmentScore: await getMorningScore(),
    energyEstimate: await getEnergyAtTime(session.startedAt),
    precedingActivity: await getPrecedingScreenActivity(session.startedAt),
  };
  
  await insertFact({
    category: 'pattern',
    topic: 'high_quality_session_conditions',
    content: JSON.stringify(conditions),
    confidence: 0.8,
    importance: 0.7,
    source: `session_${sessionId}`,
  });
}

// Weekly: synthesize patterns from accumulated condition facts
async function synthesizeSuccessPatterns() {
  const conditionFacts = await searchFactsByText('high_quality_session_conditions', 20);
  // Pass to Gemini Pro for pattern extraction
  // Output goes to UIL as 'successConditions' field
}
```

---

## 23. Implementation Intentions

*Currently missing: the morning commitment is too vague to be useful.*

### Why "I'll Work on ML Today" Doesn't Work

Behavioral science is consistent on this: vague intentions fail. "I'll work on my assignment today" sounds like a plan but it isn't one. It has no when, no where, no how long, no what exactly. When 2pm arrives and you haven't started, there's nothing specific to violate — just a general sense that you should be doing something.

Implementation intentions are different: "I will do X at time Y in location Z." Decades of research show they dramatically improve follow-through, specifically for tasks people find aversive — which is exactly the problem LifeOS is solving.

The morning check-in currently accepts vague commitments. It shouldn't.

### The Upgraded Morning Check-in

Current:
> "What's your one commitment today? 1-10 likelihood?"

Upgraded — a 3-step conversation:

**Step 1:**
> "Good morning. What's the one thing that matters most today?"

You answer: "ML assignment"

**Step 2:**
> "Good. Now make it specific: what exactly will you do, at what time, for how long, and where?"

You answer: "Section 3.2 and 3.3, at my desk, starting at 9:30am, for 90 minutes"

**Step 3:**
> "When you open section 3.2, what's the first thing you'll do — before anything else?"

You answer: "Read the first two paragraphs and write a one-sentence summary"

That last question — the "first thing" question — is the most important. It specifies the entry point so precisely that there's no ambiguity about how to start. The hardest part of any task is the first 90 seconds. Specifying those 90 seconds in advance removes the decision cost of starting.

The guardian stores: `{ task: "ML assignment", specifics: "section 3.2-3.3", startTime: "09:30", duration: 90, location: "desk", firstAction: "read first two paragraphs, write one-sentence summary" }`

The evening check-in then asks against these specifics — not "did you work on ML" but "did you do section 3.2 and 3.3 starting at 9:30?"

### Handling Vague Answers

If at Step 2 you answer vaguely ("sometime in the morning, for a while"), the guardian doesn't accept it:

> "That's not specific enough to hold you to. When exactly — give me a time. How long — give me minutes."

Not harsh. Just firm. The guardian's job is to make the commitment real before you make it, not to accept whatever you offer.

### Low Likelihood Scores

If you give a likelihood score of 4 or below, the guardian doesn't move on:

> "You said 4/10. That means you probably won't do it. Either tell me what would make it more likely — different time, smaller scope, different task — or tell me honestly if this isn't the right day for it."

This forces either a revised plan that's actually likely to happen, or an honest acknowledgment that today is a rest day — which is fine, but should be a deliberate choice rather than a default drift.

### Implementation

```typescript
// Morning check-in — multi-step conversation handler
async function handleMorningCheckin(userId: number, message: string, step: number) {
  switch(step) {
    case 1:
      // Store vague commitment, ask for specifics
      await storePendingCommitment(userId, { task: message });
      await sendTelegram(
        `Good. Now make it specific:\n\n` +
        `What exactly will you do, at what time, for how long, and where?\n\n` +
        `Format: "[what] at [time] for [X] minutes at [where]"`
      );
      await setCheckinStep(userId, 2);
      break;
      
    case 2:
      // Parse specifics, ask for first action
      const specifics = await parseImplementationIntention(message);
      await updatePendingCommitment(userId, specifics);
      
      if (specifics.likelihoodScore <= 4) {
        await sendTelegram(
          `You said ${specifics.likelihoodScore}/10. That means you probably won't do it.\n\n` +
          `What would make it more likely — different time, smaller scope, ` +
          `or is today actually a rest day?`
        );
        await setCheckinStep(userId, 'likelihood_recovery');
      } else {
        await sendTelegram(
          `When you open ${specifics.task} at ${specifics.startTime}, ` +
          `what's the very first thing you'll do?`
        );
        await setCheckinStep(userId, 3);
      }
      break;
      
    case 3:
      // Store complete implementation intention
      await finalizeCommitment(userId, { firstAction: message });
      await sendTelegram(
        `Locked in. ${specifics.task} at ${specifics.startTime} for ` +
        `${specifics.duration} minutes. First action: ${message}.\n\n` +
        `I'll check in at ${specifics.startTime}.`
      );
      break;
  }
}

// At the committed start time — reminder if no session started
async function checkCommitmentStartTime(userId: number) {
  const commitment = await getTodaysCommitment(userId);
  if (!commitment) return;
  
  const now = new Date();
  const startTime = parseTime(commitment.startTime);
  
  if (isWithin5Minutes(now, startTime) && !await hasSessionStarted(userId)) {
    await sendTelegram(
      `${commitment.startTime}. ${commitment.task}. ` +
      `First action: ${commitment.firstAction}.\n\nStart now.`
    );
  }
}
```

---

## 24. What Success Actually Looks Like — The Honest Version

The architecture is complete. The vision is right. Here is the honest version of what success looks like — not in terms of features, but in terms of the person using them.

**30 days in:**
The morning check-in is habit. You do it before you check Instagram. The evening reflection takes 3 minutes and you answer honestly even when the honest answer is "I avoided it because I was scared." The system has enough data to know the difference between a rest day and the start of a spiral. It catches you on day 2, not day 6.

**60 days in:**
The UIL narrative is accurate. When you read the weekly reckoning, you recognize yourself in it — not a generic productivity summary, but something that sounds like it was written by someone who has been watching you specifically. The friction audit has identified what actually makes the ML assignment hard. The guardian no longer says "you're avoiding ML" — it says "open section 3.2, read the first page, write one question. That's it."

**90 days in:**
You have finished something. Not because the guardian forced you. Because the open loop of an unfinished thing became more visible and more uncomfortable than the discomfort of doing the work. Because the system made the avoidance pattern so clear that hiding from it became harder than facing it. Because one day you started a session, the guardian stayed quiet because your score was above 85, and you just kept going.

That's the goal. Not a better focus score. Not more sessions. A person who has learned — through honest data and honest conversation with a system that was watching — what his patterns actually are, and has started to make different choices because of that knowledge.

> The guardian doesn't make you consistent. It makes inconsistency impossible to hide from. That's enough. For someone with the self-awareness to build this and the honesty to use it — that's enough.

---

---

## 25. The Personal Knowledge Wiki

*The missing readable layer. mem_facts stores structured atoms. The wiki stores the story those atoms tell.*

---

### The Gap

LifeOS has a sophisticated memory system — `mem_facts`, episodic logs, UIL synthesis, semantic profiles. These are queryable, decay-scored, and machine-readable. They make the LLM smarter. But they are not human-readable.

There is no place in LifeOS where you can open a file and read a coherent narrative about yourself. No document that says "here is what we know about how Rohan works, written in plain language, updated as he changes."

The wiki is that layer. Not a database. Not a dashboard. A directory of markdown files that the LLM writes and maintains — the same way the original LLM Knowledge Bases thread described building a research wiki from raw sources. Except the raw sources are you.

---

### What the Wiki Is

A `/wiki` directory inside the LifeOS project. Markdown files. The LLM maintains them. You rarely touch them directly. They are readable by you any time. They are injected into LLM prompts when relevant — richer and more narrative than `mem_facts` atoms.

```
/wiki
  /rohan
    energy-patterns.md
    avoidance-triggers.md
    best-conditions.md
    distraction-profile.md
    goal-history.md
    coaching-notes.md
  /weeks
    2025-W14.md
    2025-W15.md
    2025-W16.md
  /topics
    ml-assignment.md
    network-security.md
    lifeos.md
    zk-proofs.md
  INDEX.md
```

---

### What Each File Contains

**`rohan/energy-patterns.md`** — synthesized from UIL energy data, session start times, focus scores by hour:
```markdown
# Rohan's Energy Patterns

## Peak Window
Consistently strongest between 9-11am. Sessions starting in this window 
average 81 focus vs 67 for sessions starting after 1pm. The gap is not 
small — it represents a meaningfully different cognitive state.

## The 2pm Dip
Almost every day shows a focus score drop between 1:30-3pm. This is not 
laziness — it's circadian. Sessions scheduled here consistently underperform. 
Best use of this window: shallow work, review, planning.

## What Ruins the Morning
The single strongest predictor of a wasted morning: picking up the phone 
before opening the laptop. On days where Instagram was the first app touched, 
average session start time was 11:47am. On days where VS Code or a session 
was first: 9:23am.

Last updated: [date] — based on 34 sessions
```

**`rohan/avoidance-triggers.md`** — synthesized from friction audits, evening reflections, session absence patterns:
```markdown
# Rohan's Avoidance Triggers

## The Complexity Wall
When a topic becomes genuinely hard — when the gap between current 
understanding and required understanding is visible — the default response 
is retreat. This is documented across: ML assignment (backpropagation), 
ZK proofs (constraint systems), Network Security (formal verification).

The retreat doesn't look like quitting. It looks like switching to 
something else that feels productive. LifeOS work is the most common 
substitute — it is real work, which makes the avoidance invisible.

## What He Says vs What the Data Shows
Common stated reason for avoidance: "I'll do it later when I have more energy."
What the data shows: energy levels are not lower on avoidance days. 
The avoidance precedes the energy dip, not the other way around.

## The ML Assignment Specifically
Opened 11 times in the last 30 days. Average time before closing: 7 minutes.
Rohan's own words (evening reflection, [date]): "I think I'm scared I won't 
understand it and that'll make me feel stupid."
Friction type: fear of incompetence, not task complexity.
Guardian approach: closed tasks ("read section 3.2, write one sentence"), 
not open sessions.

Last updated: [date] — based on 8 friction audits + 23 evening reflections
```

**`weeks/2025-W14.md`** — generated every Sunday from the week's data:
```markdown
# Week of April 7, 2025

## By the Numbers
Sessions: 4 of 6 planned
Average focus score: 77 (up from 71 last week)
Deep work hours: 11.5h
Distraction hours: 8.2h
Instagram (phone): 14.3h total
Laptop first open average: 11:23am

## What Actually Happened
Strong start Monday-Tuesday. Wednesday opened Instagram before VS Code — 
the pattern that predicts a weak rest of week. Thursday and Friday followed.

The ML assignment was opened 3 times and closed within 8 minutes each time.
Network Security lab was completed in one strong session Thursday evening — 
deadline was Friday. Classic deadline rescue.

## What Changed This Week
Focus scores are improving. The 4-5 day cliff came and the recovery was 
faster than the previous cycle — 2 days instead of 4. That's progress, 
even if it doesn't feel like it.

## Open Question from Last Week
"What specifically happens in the first 3 minutes when you open the ML 
assignment?" — answered [date]: "I read the first paragraph and don't 
understand it immediately and close it."

## Open Question for This Week
You completed Network Security the night before the deadline. The session 
was good — focus score 81. But you had 6 days before that where you could 
have worked on it. What would it take to start on day 1 instead of day 6?
```

**`topics/ml-assignment.md`** — per-topic file, updated after any session touching the topic:
```markdown
# ML Assignment

## Current Status
Mastery: 34% (backpropagation), 21% (gradient descent variants)
Last session: [date], 47 minutes, focus score 73
Deadline: [date] — 18 days away

## History
First engaged: [date]
Sessions completed: 3
Sessions opened and abandoned: 11
Longest gap: 9 days (current)

## What Works
- Closed tasks ("read section X, write one question") produce starts
- Morning sessions (before 10:30am) produce completion
- Starting with review of previous session notes reduces initiation time

## What Doesn't Work  
- Open sessions ("work on ML") — abandoned 8/8 times
- Afternoon scheduling — 0 completions after 2pm
- Starting cold on new sections without reviewing prerequisites

## Guardian Notes
The friction is not capability — it is fear of appearing incompetent when 
the material is unclear. The assignment is approachable when the entry point 
is specific. Current recommendation: never schedule "work on ML assignment" — 
always schedule "read [specific section], produce [specific output]."
```

---

### How the Wiki Gets Maintained

**After every session** — the relevant topic file is updated. Session stats, what worked, what didn't, any new patterns.

**Every Sunday** — a new week file is generated from the week's data. The previous week's open question is answered or carried forward.

**After every friction audit** — the relevant avoidance trigger file is updated with the specific friction type and guardian approach.

**After every UIL synthesis** — if `currentNarrative` or `coachingInsights` contains something materially new, the relevant rohan/ file is updated.

**Monthly** — the guardian does a wiki health check: finds inconsistencies between files, fills in missing data, identifies new article candidates, updates confidence on older observations.

---

### How the Wiki Feeds Back into the System

The wiki files are injected into LLM prompts as context — richer than `mem_facts` atoms because they contain narrative, history, and nuance.

Specifically:
- Session opening line uses the relevant topic file
- Override adjudication reads the topic file for the blocked URL
- Evening reflection analysis reads the avoidance trigger file
- Weekly reckoning is generated from the week file template + current data
- Morning check-in uses the energy patterns file to suggest start time

The wiki also becomes queryable. You can ask: "What does the guardian know about why I avoid the ML assignment?" and get a human-readable answer from `topics/ml-assignment.md`, not a list of database records.

---

### Implementation

```typescript
// New file: src/lib/wiki-engine.ts

const WIKI_DIR = path.join(process.cwd(), 'wiki');

export async function updateTopicWikiPage(topic: string, sessionData: SessionData) {
  const filePath = path.join(WIKI_DIR, 'topics', `${slugify(topic)}.md`);
  const existing = await readWikiPage(filePath);
  
  const updated = await generateWithFallback(ai, {
    model: MODEL_PRO,
    contents: `Update this wiki page for topic "${topic}" with new session data.
    
EXISTING PAGE:
${existing}

NEW SESSION DATA:
${JSON.stringify(sessionData)}

Rules:
- Preserve existing observations unless new data clearly contradicts them
- Add new patterns only if they appear more than once
- Keep the page under 400 words
- Update "Last updated" and session counts
- Return the complete updated markdown page`,
  });
  
  await writeWikiPage(filePath, updated.text);
}

export async function generateWeeklyWikiPage(weekStart: Date) {
  const weekData = await aggregateWeekData(weekStart);
  const prevWeek = await readWikiPage(getWeekFilePath(subWeeks(weekStart, 1)));
  
  const page = await generateWithFallback(ai, {
    model: MODEL_PRO,
    contents: `Generate a weekly wiki page for week of ${weekStart.toDateString()}.
    
WEEK DATA: ${JSON.stringify(weekData)}
PREVIOUS WEEK PAGE: ${prevWeek}

Follow the standard weekly format. Include the open question from last week 
with its answer (or note if unanswered). Generate one new open question 
that matters and isn't rhetorical.`,
  });
  
  await writeWikiPage(getWeekFilePath(weekStart), page.text);
}

export async function getWikiContext(topic: string): Promise<string> {
  // For injecting into LLM prompts
  const topicPage = await readWikiPage(
    path.join(WIKI_DIR, 'topics', `${slugify(topic)}.md`)
  );
  const avoidancePage = await readWikiPage(
    path.join(WIKI_DIR, 'rohan', 'avoidance-triggers.md')
  );
  
  return [topicPage, avoidancePage].filter(Boolean).join('\n\n---\n\n');
}
```

---

### New Table Needed

```sql
CREATE TABLE wiki_pages (
  id INTEGER PRIMARY KEY,
  file_path TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  word_count INTEGER,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  update_trigger TEXT, -- 'session_end'|'weekly_job'|'friction_audit'|'uil_synthesis'
  version INTEGER DEFAULT 1
);
```

Stores the wiki in SQLite as well as on disk — makes it queryable, versionable, and recoverable.

---

## 26. The Karpathy-Style Optimizer — Honest Assessment and Upgrades

*What's good, what's weak, and what needs to change for the optimizer to actually improve you rather than just its own scores.*

---

### What's Well-Designed

**The constraint surface is exactly right.** The optimizer touches only policy artifacts — intervention prompts, focus score weights, override rubric, voice phrasing, session planning policy. It cannot touch route code, DB schema, extension permissions, or runtime plumbing. This boundary is architecturally enforced, not just documented. That's the correct approach.

**The eval → canary → promote → rollback loop is correct.** Baseline first. One mutation at a time. Fixed budget. Hard-fail gates. Canary validation on holdout cases before full promotion. Automatic rollback on canary failure. This is the Karpathy approach done properly — small bounded experiments with automatic reversion.

**The scoring function is thoughtful.** 85% scenario performance + 15% calibration accuracy. The calibration component means the optimizer is rewarded for being accurate about Rohan specifically, not just passing abstract test cases. That's the right orientation.

**The hard-fail gates are non-negotiable and correctly defined.** Privacy violation, intervention while inactive, broken override expiry, unsafe block, regression on critical scenarios. No amount of score improvement overrides these.

---

### What's Weak

**The eval suite is too small and too static.**

10 scenarios. They're well-designed scenarios but 10 is a small surface. The optimizer will find the policy that scores well on those 10 cases. That policy may not generalize to real behavior.

More critically: the scenarios use hardcoded URLs — `leetcode.com`, `reddit.com`, `youtube.com`. Your actual sessions have different patterns, different rhythms, different combinations. The optimizer is learning to score well on a fixed test, not learning to coach you better.

**The real session traces are not being used as eval cases.**

`buildMutationContext()` reads the last 6 sessions and passes them to the LLM mutation generator as context. Good — the mutations are informed by real behavior. But those sessions are not being used as eval cases. The mutations are still evaluated against the 10 fixed scenarios only.

This means the optimizer can generate a policy that performs well on abstract distraction scenarios while performing worse on the specific patterns of your actual sessions. The eval suite never knows.

**There is no feedback loop from Rohan.**

Policy changes — intervention prompts rewritten, thresholds shifted — and nothing tells you. You'd need to query `guardian_artifact_versions` to know the system has changed. That's not a feedback loop. That's archaeology.

**The eval score measures the wrong thing.**

`guardian_eval_score` measures whether the guardian makes correct intervention decisions. What you actually care about is whether Rohan studies more consistently and finishes more things. These are separated by several layers of causality. A policy that scores 95 on the eval suite might still be wrong for you — too aggressive, eroding trust, causing disengagement. A policy that scores 78 might be exactly right because it matches your specific rhythm.

The eval suite cannot capture this. Only real outcomes can.

---

### The Upgrades

**Upgrade 1: Real session traces as eval cases**

After every 5 real sessions, automatically generate a new eval case from the actual session trace — real URLs, real timing, real decision sequence, real outcome:

```typescript
async function generateEvalCaseFromRealSession(sessionId: string) {
  const session = await getFullSessionTrace(sessionId);
  const summary = await getSessionSummary(sessionId);
  
  // Only generate eval cases from sessions with clear outcomes
  // (clearly good or clearly bad — ambiguous sessions are noisy)
  const isClearOutcome = summary.averageFocusScore > 80 || summary.averageFocusScore < 50;
  if (!isClearOutcome) return;
  
  const evalCase = {
    caseName: `real_session_${sessionId.slice(0, 8)}`,
    scenarioType: 'real_trace',
    inputPayload: {
      durationMinutes: session.durationMinutes,
      targetTitle: session.targetTitle,
      events: session.tabEventLog.map(e => ({
        type: e.type,
        url: e.url,
        dwellSeconds: e.dwellSeconds,
        idleSeconds: e.idleSeconds,
      })),
      expected: {
        // Derive expected from actual outcome
        maxBlockCount: summary.blockedCount + 1,  // allow slight variation
        finalFocusScore: summary.averageFocusScore,
      }
    },
    expectedOutcome: `Real session outcome: focus ${summary.averageFocusScore}, blocks ${summary.blockedCount}, overrides ${summary.overrideCount}`,
  };
  
  await insertRealSessionEvalCase(evalCase);
}
```

The eval suite now grows with real behavior. After 20 sessions there are 4 real-trace cases. After 100 sessions there are 20. The optimizer increasingly learns from your actual patterns rather than abstract archetypes.

**Upgrade 2: Policy promotion notification**

When a new policy is promoted, the guardian tells you immediately:

```typescript
async function notifyPolicyPromotion(
  promoted: PolicyArtifactVersion,
  baseline: { score: number },
  rationale: string | null
) {
  const bundle = JSON.parse(promoted.content) as GuardianPolicyBundle;
  
  const changes: string[] = [];
  const prev = getDefaultBundle();
  
  if (bundle.thresholds.speechCooldownMs !== prev.thresholds.speechCooldownMs) {
    const diff = bundle.thresholds.speechCooldownMs - prev.thresholds.speechCooldownMs;
    changes.push(`Speech cooldown ${diff > 0 ? 'increased' : 'decreased'} by ${Math.abs(diff/1000)}s`);
  }
  if (bundle.thresholds.distractionRevisitBlockCount !== prev.thresholds.distractionRevisitBlockCount) {
    changes.push(`Block threshold changed to ${bundle.thresholds.distractionRevisitBlockCount} revisits`);
  }
  // ... other threshold comparisons
  
  await sendTelegram(
    `🔄 <b>Guardian policy updated</b>\n\n` +
    `Eval score: ${baseline.score} → ${promoted.guardianEvalScore}\n` +
    (rationale ? `Reason: ${rationale}\n` : '') +
    (changes.length ? `\nChanges:\n${changes.map(c => `• ${c}`).join('\n')}\n` : '') +
    `\nIf this feels off, reply <b>revert</b> and I'll roll back immediately.`
  );
}

// Handle revert command in Telegram webhook
if (message.text === 'revert') {
  await revertToLastStablePolicy();
  await sendTelegram('Rolled back to previous policy version.');
}
```

You become part of the feedback loop rather than just the subject of it.

**Upgrade 3: Outcome signal feeding back into eval score**

This is the hard one and the most important one.

The optimizer needs a signal that connects policy quality to real outcomes — not just eval case performance. The weekly reckoning data is that signal. It's slow and noisy but it's real.

```typescript
interface OutcomeSignal {
  weekStart: Date;
  sessionsCompleted: number;
  sessionsPlanned: number;
  completionRate: number;           // sessions completed / planned
  avgFocusScore: number;
  goalsProgressed: number;          // goals with measurable progress this week
  cliffOccurred: boolean;           // did the 4-5 day cliff happen?
  cliffRecoveryDays: number | null; // how long to recover if it did?
  rochanSatisfactionScore: number;  // from weekly reckoning response (1-10, parsed)
  overrideTrend: 'increasing' | 'stable' | 'decreasing';
}

// Run weekly, after reckoning response received
async function computeOutcomeSignal(weekStart: Date): Promise<OutcomeSignal> {
  // ... aggregate from sessions, goals, reckoning response
}

// Blend into eval score for next optimizer run
async function getBlendedEvalScore(
  scenarioScore: number,
  outcomeSignal: OutcomeSignal | null
): Promise<number> {
  if (!outcomeSignal) return scenarioScore;
  
  // Outcome score: 0-100 based on real behavior this week
  const outcomeScore = computeOutcomeScore(outcomeSignal);
  
  // Weight: starts at 5% outcome, grows to 30% over 8+ weeks of data
  const weeks = await getWeeksOfOutcomeData();
  const outcomeWeight = Math.min(0.30, 0.05 + weeks * 0.03);
  const scenarioWeight = 1 - outcomeWeight;
  
  return scenarioWeight * scenarioScore + outcomeWeight * outcomeScore;
}
```

This means the optimizer starts optimizing for you, not for the eval suite. After 8 weeks of outcome data, 30% of the score comes from whether you're actually improving. A policy that scores 95 on scenarios but correlates with poor completion rates will lose to a policy that scores 82 but correlates with strong real-world outcomes.

**Upgrade 4: The optimizer reflects on itself**

Monthly, the optimizer generates a plain-language summary of what it has learned and sends it to Telegram:

```
📊 Guardian Optimizer Report — April 2025

Policy version: guardian-v1-dwell-boost-3 (promoted 11 days ago)
Eval score trend: 71 → 78 → 82 (improving)
Real outcome signal: 23% weight (7 weeks of data)

What changed this month:
• Speech cooldown increased from 90s to 135s — you were getting interrupted too often
• Distraction block threshold lowered from 3 to 2 revisits — catching drift earlier
• Override rubric softened — approval rate went from 18% to 34%, session outcomes improved

What the data suggests:
• You respond better to fewer, more precise interventions than frequent nudges
• Override approval correlates with better session completion (not worse)
• The direct coaching tone produces better focus scores than balanced tone for you

One thing still not working:
• The cliff pattern — the optimizer has tried 3 policy variants, none have improved 
  the day-4 cliff rate. This may not be a policy problem. It may be a habit problem 
  that no guardian policy can fix.
```

That last line matters. The optimizer should be honest about the limits of what policy changes can accomplish. Some things are not policy problems.

---

### The Fundamental Question the Optimizer Can't Answer

Karpathy's original framing was about a well-defined loss function over a well-defined performance metric. Neural network weights, cross-entropy loss, ImageNet accuracy. Clean.

The coaching problem doesn't have a clean loss function. "Is Rohan improving" is not directly measurable. Session completion rate is a proxy. Focus score is a proxy. Goal progress is a proxy. Weekly reckoning satisfaction score is a proxy.

The optimizer will get better at optimizing those proxies. Whether optimizing those proxies makes Rohan actually better at the things that matter to him — finishing his thesis, learning ZK proofs, building consistency — is a question the system cannot answer for itself.

That question requires Rohan to answer it, honestly, in the weekly reckoning, month after month. The system can surface the data. The judgment about whether the data represents real progress is human.

This is not a limitation of the implementation. It's the correct boundary between what the machine can know and what only the person can know.

---

*Document covers conversation from April 7, 2026.*  
*Sections: 0 (Real Requirements) · 1-18 (Architecture) · 19 (Knowledge Graph) · 20 (Friction Audit) · 21 (Recovery Protocol) · 22 (Success Patterns) · 23 (Implementation Intentions) · 24 (What Success Looks Like) · 25 (Personal Knowledge Wiki) · 26 (Optimizer Assessment and Upgrades)*  
*Next step: Phase A — Telegram webhook router + morning/evening check-in pipeline.*
