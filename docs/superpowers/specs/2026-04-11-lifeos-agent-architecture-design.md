# LifeOS Agent Architecture Design

**Date:** 2026-04-11  
**Status:** Approved (revised after full codebase audit)  
**Scope:** Transform LifeOS into a unified agentic companion — connect what exists, fix critical gaps, make the intelligence loop genuinely self-improving.

---

## North Star

One agent whose sole directive is to make you better. Everything — sessions, check-ins, sleep patterns, goal drift, energy, screen activity, corrections, feedback — feeds one intelligence model. Every interaction sharpens the model. Nothing is logged and forgotten. The agent learns from your data and becomes more capable the longer it runs (Hermes-style).

---

## What Already Exists (Do Not Rebuild)

The codebase is significantly more complete than the first version of this spec assumed. These are all operational:

| Module | What it does |
|--------|-------------|
| `intelligence.ts` (UIL) | Gemini-powered synthesis of `UserIntelligenceProfile` (30+ fields). `getIntelligenceContext()` is the context function. Re-synthesizes every 30 min. |
| `behavior.ts` | Focus depth, entropy, archetype, behavioral memory. Feeds UIL. |
| `energy-composite.ts` | Per-user calibrated [0–100] energy estimate. Weights auto-adjust via calibration. |
| `guardian-calibration.ts` | Post-session feedback → weight adjustment. The existing self-improving loop. |
| `telegram-agent.ts` | Full Telegram command handler. Standup, goals, tasks, habits, sessions, overrides. |
| `checkin.ts` | Morning/evening Telegram check-ins + response handlers. |
| `scheduler.ts` | Daily/interval job scheduler. Already runs check-ins, weekly reckoning, screenshot pipeline. |
| `screenshot-pipeline.ts` | macOS screenshots every 30s, Gemini Vision analysis. Screen tracking exists. |
| `google-calendar.ts` | Full OAuth Google Calendar CRUD. Already integrated. |
| `memory-extractor.ts` | LLM fact extraction from sessions, voice, check-ins → `mem_facts` with embeddings. |
| `notifications.ts` | Deadline warnings, habit missed, focus drops, goal drift. Telegram + email. |
| `open-loops.ts` | Weekly unfinished goal/task audit + monthly pattern letter. |
| `weekly-planner.ts` | Energy-based weekly task assignment. |
| `weekly-reckoning.ts` | Weekly Telegram recap + response handler. |
| `goal-health.ts` | Nightly velocity check per goal: on_track / at_risk / off_track. |
| `graph.ts` | Knowledge graph per goal, BKT mastery propagation. |
| `mem_facts / mem_episodes / mem_procedures / mem_working` | 4-tier memory already in DB. |
| `/api/chat/route.ts` | Streaming Gemini chat agent with tools (calendar, memory, tasks, guardian start). |

**Nothing above gets replaced or rebuilt.**

---

## The Actual Gaps

### Gap 1 — Telegram is broken as an intelligence surface

Diagnosed from a real bad interaction where:
- "I want to finish PBA-x course today, 4 hours" → bot started a session on "Sonic ZK paper" (stale UIL topic)
- "Not right now, not in one session" → bot ended a phantom session and prompted for reflection

**Root causes (confirmed by code audit):**

| Problem | Location | Evidence |
|---------|----------|----------|
| Stale UIL context | `telegram-agent.ts:459` | Calls `getIntelligenceContext()` but never calls `touchIntelligence()` first — profile up to 30 min stale |
| No conversation history | `telegram-agent.ts` | Each message processed in isolation. No `getRecentContextText()` equivalent. |
| Session starts too eagerly | System prompt | No "DO NOT start_session unless explicitly asked" guardrail (voice has this at line ~437) |
| No pending confirmation | `telegram-agent.ts` | Voice has `pendingActions` map. Telegram executes destructive actions immediately. |
| Weak system prompt | `telegram-agent.ts:25–81` | 8 generic actions. Voice has 13+ with full parameter specs and numbered guardrails. |

**Fix:**
1. Call `touchIntelligence('telegram_message')` before UIL fetch in `handleTelegramCommand()`
2. Store Telegram turns in DB (new `telegram_turns` table), pass recent history to every LLM call
3. Add `pendingActions` map mirroring voice's confirmation pattern
4. Rewrite system prompt with voice-style guardrails: planning intent vs immediate action, confirmation required for session starts
5. Add `parseTelegramIntent()` as a dedicated intent-parsing phase (mirrors `parseGuardianVoiceIntent()`)

### Gap 2 — User corrections are thrown away

The richest learning signal is when the user corrects the agent. "No I meant...", "wrong topic", "not right now" are direct feedback that the agent made a wrong inference. Currently these are processed as new messages with no memory of the error.

**Fix:** When a correction is detected (via intent classifier: `correction` type), write to `mem_facts`:
```
{ category: 'agent_error', topic: <action_that_was_wrong>, content: 'incorrectly inferred X when user meant Y', confidence: -0.9 }
```
The UIL synthesis already reads `mem_facts` — negative confidence facts will inform future inferences.

### Gap 3 — Memory extraction doesn't run on Telegram conversations

`memory-extractor.ts` has `extractMemoryFromSession()`, `extractMemoryFromVoice()`, `extractMemoryFromCheckin()` — but no equivalent for general Telegram conversations.

Every Telegram exchange where the user states a preference, corrects the agent, sets an intention, or describes their state is valuable signal being discarded.

**Fix:** Add `extractMemoryFromTelegramConversation(turns: TelegramTurn[])` to `memory-extractor.ts`. Called after every Telegram exchange. Extracts preferences, corrections, intentions → `mem_facts`.

### Gap 4 — No self-eval signal after agent actions

After every agent action (session start, nudge, recommendation), there's no mechanism to record whether it was effective. User corrections, immediate reversals, session aborts are all outcome signals that should feed back into UIL synthesis.

**Fix:** New `agent_action_outcomes` table. After every significant action, log: action type, what was inferred, what the user actually did next. UIL synthesis reads this to calibrate inference accuracy over time.

### Gap 5 — Sleep/wake time missing from check-ins

`checkin.ts` has morning/evening check-ins but no sleep time or wake estimate fields. `scheduler.ts` fires at fixed times. The agent can't adapt its schedule to your actual sleep rhythm.

**Fix:** Two new DB fields on `daily_checkins` (or new `agent_daily_intentions` table):
- `sleep_time` — logged during evening check-in ("sleeping now, 3am")
- `wake_estimate` — derived (sleep_time + 8h) or user-stated
- `tomorrow_intention` — free-form text, LLM infers goal link
- `inferred_goal_id` + `inferred_goal_confidence`

Scheduler reads these to fire morning check-in at `wake_estimate` instead of a fixed time.

---

## Intelligence Layer: Making It Actually Learn

The UIL synthesizes behavioral data but the learning loop has gaps. Here's what turns it from "analytics display" into a Hermes-style self-improving agent:

### Signal sources to add

| New signal | Where it comes from | How it feeds UIL |
|-----------|---------------------|-----------------|
| User corrections | Telegram/voice intent classifier | Negative `mem_facts` entries → UIL reads these to avoid repeat errors |
| Telegram conversation facts | `extractMemoryFromTelegramConversation()` | Preferences, intentions → `mem_facts` |
| Action outcomes | `agent_action_outcomes` table | Did session start → did user actually work? Did nudge → did user respond positively? |
| Sleep/wake patterns | Evening check-in | `sleep_time`, duration, consistency → UIL energy forecast improvement |
| Morning energy self-report | Morning check-in | Replaces inference with ground truth for that day's energy composite |
| Intention completion | Compare `tomorrow_intention` vs session history | `intention_completion_rate` → UIL knows when your plans are reliable |

### What UIL synthesis gains

With these signals, the UIL profile gains:
- `sleepPattern`: avg duration, consistency, sleep time variance, sleep-focus correlation
- `intentionCompletionRate`: how often planned = done (calibrates how seriously to take stated intentions)
- `agentErrorPatterns`: which types of inferences are most often wrong for this user
- `morningEnergyBaseline`: ground truth from check-ins vs predicted (calibrates energy composite)
- `correctionFrequency`: how often user corrects agent (measures agent quality over time)

---

## Architecture: What Actually Changes

### New files

| File | Role |
|------|------|
| `src/lib/lifeos-agent.ts` | Unified agent loop — UIL context + history + tool routing + self-eval. All surfaces (Telegram, web chat, voice) call this instead of their own LLM stacks. |
| `src/lib/agent-scheduler.ts` | Extends existing `scheduler.ts` with sleep-time-aware check-in triggers and daily intention handling. |
| `src/app/api/agent/route.ts` | Unified gateway. Telegram webhook, chat, and voice route here. |

### Modified files

| File | Change |
|------|--------|
| `telegram-agent.ts` | Fix UIL staleness, add history, add confirmation, rewrite system prompt, add `parseTelegramIntent()` |
| `memory-extractor.ts` | Add `extractMemoryFromTelegramConversation()` |
| `checkin.ts` | Add sleep_time, wake_estimate, tomorrow_intention fields to evening check-in flow |
| `scheduler.ts` | Use stored wake_estimate to trigger morning check-in instead of fixed time |
| `intelligence.ts` | Extend `runUILSynthesis()` to read sleep patterns, intention completion rate, action outcomes |
| DB migrations | `telegram_turns`, `agent_daily_intentions`, `agent_action_outcomes` tables |

### NOT changed

Guardian runtime, voice pipeline, guardian optimizer, extension, web app components. The agent wraps these — it does not replace them.

---

## The Unified Loop (Corrected)

```
Evening (Telegram):
  "Sleeping now, 3am, want to finish PBA-x module 3 tomorrow"
  → agent stores: sleep_time=3am, wake_estimate=11am, intention="finish PBA-x module 3"
  → LLM infers: maps to Goal "PBA-x certification"
  → touchIntelligence('evening_checkin') → UIL re-synthesizes overnight

Morning (~11am, wake_estimate-triggered):
  scheduler fires (not at fixed time — at stored wake_estimate)
  Telegram: "Morning. Energy check — how are you feeling? (1-10)"
  User: "7/10, rested"
  → agent stores morning energy → feeds energy composite as ground truth
  → Telegram: "You planned: finish PBA-x module 3. Still on? Want to start a session?"
  User: "Yeah, later today, maybe 2pm"
  → agent stores: session_planned_at=2pm
  → extractMemoryFromTelegramConversation() → mem_facts updated

2pm (scheduler nudge):
  Telegram: "Ready for PBA-x? Session timer starts when you say go."
  User: "Go"
  → guardian session starts with correct topic, correct duration split across sessions
  → UIL context is fresh (touchIntelligence called at morning check-in)

Session ends:
  reflection written, focus score logged
  extractMemoryFromSession() runs
  agent_action_outcomes logged: agent suggested PBA-x module 3, user completed it → positive signal
  touchIntelligence('session_complete') → UIL re-synthesizes

Next evening:
  UIL knows: PBA-x works best in afternoon, 90-min blocks, after 7+ energy mornings
  Agent uses this in tomorrow's planning — no guessing
```

---

## Migration Path

| Existing | Role going forward |
|----------|-------------------|
| `intelligence.ts` (UIL) | The brain. All agent LLM calls use `getIntelligenceContext()`. |
| `telegram-agent.ts` | Fixed and promoted to route through `lifeos-agent.ts` |
| `checkin.ts` | Extended with sleep/wake/intention fields |
| `scheduler.ts` | Extended with sleep-time-aware triggers |
| `memory-extractor.ts` | Extended with Telegram conversation extraction |
| `guardian-runtime.ts` | Session expert — invoked as a tool by the agent |
| `mem_facts` | Primary learning store — corrections, preferences, outcomes all land here |

**Nothing deleted. Everything connected.**

---

## Acceptance Criteria

- [ ] Telegram message → correct UIL context (topic matches what user actually said, not stale cache)
- [ ] "I want to study X later" does NOT start a session — it creates a planned intention
- [ ] User correction ("no I meant...") → negative mem_fact created, UIL re-synthesizes
- [ ] Morning check-in fires at stored wake_estimate, not fixed time
- [ ] Evening check-in captures sleep_time + tomorrow_intention + inferred_goal_id
- [ ] Every Telegram conversation run through `extractMemoryFromTelegramConversation()`
- [ ] After 10 interactions, `mem_facts` contains user-specific preferences extracted from conversation
- [ ] Guardian runtime unaffected — sessions still work exactly as before
- [ ] Voice pipeline unaffected
