# LifeOS Agent Architecture Design

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Transform LifeOS from a feature-based productivity app into a unified agentic companion — one brain, all surfaces, self-improving loop.

---

## North Star

One agent whose sole directive is to make you better. Everything — sessions, check-ins, sleep patterns, goal drift, energy levels, future screen/activity tracking — is a sensor feeding one intelligence model. Every interaction sharpens the model. Nothing is logged and forgotten.

---

## Inspiration

**OpenClaw**: Three-layer architecture (channel → brain → body). Skills system. Heartbeat daemon for autonomous scheduling. Local-first.

**Hermes**: AIAgent loop as the core. Self-improving procedural skills. Persistent cross-session memory. Multi-platform gateway. The agent gets more capable the longer it runs.

LifeOS adopts the same structural principles but is purpose-built: single user, productivity domain, Mac-native, with a guardian session layer as the session-scoped expert.

---

## Architecture

### Three Layers

```
CHANNELS (surfaces)
  Telegram ─┐
  Web App  ─┤──► Agent Gateway ──► LifeOSAgent
  Voice PTT─┤                      (the brain)
  Extension─┘

BRAIN (LifeOSAgent)
  Context Builder → Tool Router → LLM → Self-Eval

BODY (tools)
  Goals, Tasks, Sessions, Memory, Scheduler, Telegram, Guardian
  (later: Screen, App Usage, Calendar)
```

### Key Principle

The Guardian Runtime is not replaced. It becomes a tool the agent can invoke — the session-scoped expert. The agent is the lifelong companion. The Guardian handles "what do I do during this 90-minute deep work block." The agent handles "who is this person, what do they need today, and how do I help them compound over weeks."

---

## Components

### 1. LifeOSAgent (`src/lib/lifeos-agent.ts`)

The central reasoning loop. Inspired by Hermes' `AIAgent` class.

**Responsibilities:**
- Assemble full context before every LLM call (see Intelligence Model below)
- Route tool calls to the appropriate body functions
- Evaluate outcomes and update the intelligence model
- Never answer from stale context — always build fresh from the model

**Loop:**
```
receive message/event
  → build context (semantic + episodic + working memory)
  → construct prompt (system: directive + context; user: message/event)
  → LLM call with tool definitions
  → execute tool calls (may chain)
  → emit response to surface (Telegram, web, voice)
  → self-eval: did this action produce good signal? update model
```

**System prompt directive (invariant):**
> You are LifeOS — a personal agent whose only job is to make this person better. You have full context of their history, goals, energy patterns, and behavioral fingerprint. Act on it. Don't just respond — reason, decide, and when in doubt, ask one focused question.

### 2. Agent Tools (`src/lib/agent-tools.ts`)

All capabilities the agent can invoke. Defined as typed tool schemas (compatible with Gemini/Claude tool-use API).

| Tool | Description |
|------|-------------|
| `read_goals` | Get active goals with status and linked tasks |
| `update_goal` | Modify goal status, priority, notes |
| `create_goal` | Create new goal with optional parent linkage |
| `read_tasks` | Get tasks (filterable by goal, status, date) |
| `create_task` | Create task, optionally linked to goal |
| `complete_task` | Mark task done, log outcome |
| `read_session_history` | Get recent session summaries with focus scores |
| `read_reflections` | Get post-session reflections |
| `read_intelligence_model` | Get the full current intelligence model snapshot |
| `update_intelligence_model` | Write new signal into the model (sleep, energy, intention, pattern) |
| `set_daily_intention` | Record tonight's sleep time, wake estimate, tomorrow's intention |
| `get_daily_intention` | Read today's/tomorrow's intention |
| `send_telegram` | Send proactive Telegram message to user |
| `schedule_nudge` | Register a one-shot future nudge with the scheduler |
| `invoke_guardian` | Start/end a guardian session, query current guardian state |
| `infer_goal_linkage` | Internal only: LLM sub-call invoked by `set_daily_intention`, given free-form text returns best-matching goal ID or null. Not exposed as an external tool. |

**Future tools (Phase 3+):**
- `read_screen_activity` — Mac helper daemon feed
- `read_app_usage` — app/window usage outside browser
- `read_calendar` — Google Calendar events
- `write_calendar` — block focus windows

### 3. Intelligence Model (`src/lib/agent-memory.ts`)

One source of truth. All surfaces read from here. All interactions write to here.

**Four layers:**

| Layer | Content | Storage |
|-------|---------|---------|
| Semantic | Behavioral fingerprint: energy band, coaching style, best start hour, distraction domains, strong/friction topics, sleep patterns, avg focus by day-of-week | `guardian_semantic_profiles` (extended) |
| Episodic | Session summaries, reflections, interventions, check-in logs, daily intentions, mood logs | Existing tables + `agent_daily_intentions`, `agent_checkin_logs` |
| Procedural | Policy bundles, agent skill snapshots, self-eval outcomes | `guardian_artifact_versions` (extended) |
| Working | Today's intention, current mood/energy, active session context, last check-in time | In-memory, hydrated at agent startup from DB |

**New DB tables:**

```sql
-- Daily intentions: what you plan to do, when you sleep/wake
agent_daily_intentions (
  id, date, sleep_time, wake_estimate, intention_text,
  inferred_goal_id, inferred_goal_confidence, created_at
)

-- Check-in logs: morning mood/energy, evening recap
agent_checkin_logs (
  id, checkin_type ('morning'|'evening'), mood, energy_score,
  free_text, created_at
)

-- Self-eval outcomes: did agent actions produce good signal?
agent_self_eval_log (
  id, action_type, action_payload, outcome_signal,
  helpful BOOLEAN, created_at
)
```

**Extended semantic profile fields:**
- `avg_sleep_duration_hours` — rolling average
- `avg_wake_hour` — rolling average
- `energy_by_day_of_week` — JSON: `{0: 'low', 1: 'high', ...}`
- `sleep_focus_correlation` — does more sleep = better focus? computed weekly
- `intention_completion_rate` — how often does planned = done?

### 4. Agent Gateway (`src/app/api/agent/route.ts`)

Single inbound endpoint. All surfaces route here.

**Request shape:**
```typescript
{
  surface: 'telegram' | 'web' | 'voice' | 'extension' | 'scheduler',
  message?: string,
  event?: GuardianEvent,
  metadata?: { telegramChatId?: string, sessionId?: string }
}
```

Gateway responsibilities:
- Normalize inbound message/event into agent input
- Invoke LifeOSAgent
- Route response back to the correct surface (Telegram reply, SSE push, voice TTS)

Existing Telegram webhook handler becomes a thin adapter that calls this gateway. Existing guardian event route similarly becomes an adapter.

### 5. Autonomous Scheduler (`src/lib/agent-scheduler.ts`)

Heartbeat daemon — always running, even when no session is active. This is what makes the agent proactive rather than reactive.

**Scheduled behaviors:**

| Trigger | Condition | Action |
|---------|-----------|--------|
| Evening ritual | `now >= sleep_time - 60min` AND no check-in today | Send Telegram: "How'd today go? What are you sleeping on?" |
| No-check-in reminder | `now >= 23:30` AND still no evening check-in | Telegram reminder |
| Morning wake-up | `now >= wake_estimate` AND user hasn't messaged | Telegram: mood + energy + confirm today's intention |
| AFK at wake time | `now >= wake_estimate + 30min` AND no response | Follow-up Telegram |
| Goal drift check | Daily at noon | Read goals, compare last 7 days of sessions, flag drift |
| Session opportunity | Energy=high + no session today + it's within best_start_hour ± 2 | Proactive nudge: "Good time for a session?" |

Scheduler is implemented as a `setInterval` loop started at Next.js server startup (Mac Mini runs 24/7, server is persistent). Checks fire every 5 minutes and evaluate trigger conditions against the intelligence model. It does not run on the guardian hot path.

---

## The Unified Loop

```
Evening check-in (Telegram)
  "done for today, sleeping 3am, want to finish auth module"
  → agent stores: sleep_time, intention, infers goal link
  → intelligence model updated

Morning check-in (~11am)
  heartbeat fires, sends Telegram
  "how's energy?" → user: "tired, 6/10"
  → working memory: energy=low
  → guardian will: shorter sprints, softer tone, no harsh blocks

Afternoon session
  guardian reads intelligence model
  knows: energy low, intention is auth module, goal is LifeOS v1
  → personalized coaching from minute one

Session ends
  reflection written, focus score logged
  agent self-eval: was today's intention completed? partial?
  → semantic profile updated: auth module = friction topic on low-energy days

Next evening check-in
  agent proactively surfaces: "auth was rough yesterday — break it into smaller pieces tomorrow?"
  → intention for tomorrow is better scoped

Every cycle → model gets sharper → agent gets better
```

---

## Migration Path (Existing → Agentic)

LifeOS doesn't need a rewrite. The existing architecture is the foundation.

| Existing | Role in Agent Architecture |
|----------|---------------------------|
| `guardian-runtime.ts` | Session-scoped tool the agent invokes |
| `longitudinal-engine.ts` | Day briefing tool, feeds intelligence model |
| `guardian-semantic-profiles` table | Semantic layer of intelligence model (extended) |
| Telegram bot handlers | Become thin adapters → agent gateway |
| Guardian SSE stream | Still exists, agent can read/push via `invoke_guardian` tool |
| `guardian-optimizer.ts` | Procedural layer optimizer (still runs off hot path) |

**Nothing is deleted. Everything is promoted.**

---

## What This Is NOT

- Not a full replacement of the guardian — guardian stays as session expert
- Not always-listening or passive surveillance outside sessions (until Phase 3 screen tracking, which is opt-in and local)
- Not multi-user — single user, single agent instance
- Not a chatbot wrapper — the agent reasons, acts, and self-evaluates. It doesn't just respond.

---

## Phase Boundary

**This spec covers:**
- LifeOSAgent core loop
- Agent tools (goals, tasks, sessions, memory, Telegram, guardian invoke)
- Intelligence model (new DB tables + extended semantic profile)
- Agent gateway (unified inbound)
- Autonomous scheduler (daily ritual loop)
- Telegram as primary async surface

**Out of scope (future phases):**
- Screen/app tracking (Mac helper daemon)
- Google Calendar read/write
- Voice as primary agent surface (currently PTT → guardian only)
- Web app redesign around agent-first UX

---

## Acceptance Criteria

- [ ] Telegram message → agent gateway → LifeOSAgent → tool execution → Telegram response, end to end
- [ ] Evening check-in stored: sleep time, intention, inferred goal link
- [ ] Morning check-in fires at estimated wake time even if user hasn't opened app
- [ ] Missing evening check-in triggers reminder by 23:30
- [ ] Session coaching reflects today's energy and intention (not just historical profile)
- [ ] After 5 sessions, semantic profile noticeably reflects real patterns (energy, friction topics, sleep correlation)
- [ ] Agent self-eval runs after every action and writes outcome signal to DB
- [ ] Guardian runtime continues to work as before — agent wraps, does not break it
- [ ] Zero passive monitoring when no session active and no scheduler trigger pending
