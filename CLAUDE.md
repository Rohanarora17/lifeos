# LifeOS Guardian — Claude Knowledge Base

## Project Overview

LifeOS is a personal productivity OS being rebuilt as a **session-scoped AI guardian**. It is silent and non-observant when inactive. During explicit study sessions it becomes a hard guardian: it watches behavioral signals, computes a live focus score, blocks distractions, and speaks at the right moments — like a coach reading your pace and calling it when it counts.

**Core principle:** The extension and agent are completely silent when no session is active. No tab tracking, no AI calls, no data sent. Guardian mode is a privilege the user explicitly grants.

**Target environment:** macOS, Chrome/Brave, single user, Mac Mini running 24/7.

**Tech stack:** Next.js 16, React 19, Tailwind CSS 4, SQLite (better-sqlite3), Google Gemini API (via `src/lib/ai.ts`).

---

## Spec and Plan Documents

Read these before making any guardian changes:

| File | Purpose |
|------|---------|
| `final-execution.md` | Canonical 8-phase plan: architecture decisions, data contracts, test plan, acceptance criteria |
| `phase-by-phase.md` | Per-phase breakdown: subtasks, acceptance criteria, confidence gate, execution rules |
| `PLAN.md` | High-level architecture summary and assumptions |
| `LifeOS-Guardian-Spec.md` | Full implementation spec: all 7 layers with interfaces and decision tables |
| `docs/LOCAL_WHISPER_CPP.md` | Local whisper.cpp STT setup and env vars |

---

## Implementation Status

Phases 1–5 are **complete**. Phase 6 (Optimizer Plane) is next.

| Phase | Status | Summary |
|-------|--------|---------|
| 1 — Core Runtime | Done | `guardian-runtime` is single live decision-maker; `agent-loop` and `session-state` are adapters |
| 2 — Realtime Contract | Done | Unified `GuardianEvent` / `GuardianCommand` / `GuardianDecision` types; extension, API, and web use one contract |
| 3 — Voice Plane | Done | Push-to-talk via `guardian-voice.ts`; whisper.cpp STT; `say` fallback TTS; LiveKit optional transport |
| 4 — Longitudinal Intelligence | Done | Day briefing, semantic profile extraction, episodic trace persistence in `longitudinal-engine.ts` |
| 5 — Policies and Blocking | Done | Distraction taxonomy, cooldowns, override rubric with TTL, auto-reblock on expiry |
| 6 — Optimizer Plane | **Next** | Karpathy-style bounded loop, eval harness, artifact versioning, keep-or-revert |
| 7 — Product Surfaces | Pending | Web cockpit, extension hardening, Mac helper daemon, phone PWA |
| 8 — Cleanup | Pending | Remove prototype debt, raw-SQL tools from chat, startup side effects |

---

## Architecture: Four Planes

### Realtime Plane
Extension sensors → `guardian-events.ts` → `guardian-runtime.ts` → SSE stream → dashboard + extension commands.

### Memory Plane
- **Working**: current session state in `GuardianState` (in-memory, `guardian-runtime`)
- **Episodic**: full session traces, interventions, overrides, reflections (SQLite)
- **Semantic**: stable preferences, energy patterns, recurring distractions (`guardian_semantic_profiles` table)
- **Procedural**: active promoted policy bundle (`guardian_artifact_versions` table)

### Reasoning Plane
Intent parsing (`intent-engine.ts`), override adjudication (AI-assisted, scoped), reflection, day briefing, tutor submode (explicit only).

### Optimizer Plane
Bounded autoresearch loop over versioned policy artifacts only. Never edits route code, DB schema, or runtime plumbing.

---

## Guardian Authority Model

| State | Behavior |
|-------|---------|
| `INACTIVE` | Zero monitoring. Extension silent. No AI calls. |
| `SOFT_WATCH` | Gentle reminders only. No tab tracking. |
| `ACTIVE` | Full guardian mode. Tab tracking + blocking + agent loop. |
| `BREAK` | Tabs unblocked. Break timer running. Returns to `ACTIVE` automatically. |
| `COMPLETE` | Session ended. Reflect loop running. Graph updating. |

Rules:
- Every block must carry: reason, category, source event, suggested alternative.
- Override requests are AI-assisted but resolve to a scoped `urlPattern` + `ttlSeconds`. No blanket session disable.
- Approved overrides auto-expire and re-block automatically.
- No override can disable the guardian globally.

---

## Key Files and Their Roles

### Guardian Core
| File | Role |
|------|------|
| `src/lib/guardian-types.ts` | All canonical types: `GuardianEvent`, `GuardianState`, `GuardianDecision`, `GuardianCommand`, `OverrideRequest`, `OverrideDecision`, `GuardianPolicyBundle`, `DayBriefing`, `GuardianSemanticProfile`, eval types |
| `src/lib/guardian-runtime.ts` | **Single live decision-maker.** Owns session state, focus score, intervention cooldowns, block/unblock, explainability, override state, event fanout, policy application. |
| `src/lib/guardian-bus.ts` | SSE event fanout — transport only, does not own state |
| `src/lib/guardian-events.ts` | Inbound event normalization and validation |
| `src/lib/guardian-voice.ts` | Voice pipeline: push-to-talk capture, transcript handoff, TTS output, turn-taking |
| `src/lib/guardian-optimizer.ts` | Policy artifact versioning, active bundle loading, eval run recording |
| `src/lib/guardian-eval.ts` | Eval harness: scenario runner, scoring function, hard-fail gates |
| `src/lib/guardian-artifacts.ts` | Artifact CRUD and promotion logic |

### Supporting Lib
| File | Role |
|------|------|
| `src/lib/focus-score.ts` | Focus score algorithm (weighted composite: continuity 35%, tab switches 25%, dwell 20%, distraction revisit 15%, idle 5%) |
| `src/lib/intent-engine.ts` | Parses lock-in utterance → `LockInIntent` (topic, goalId, conceptNodeId, duration, mood) |
| `src/lib/longitudinal-engine.ts` | Day briefing generation, goal drift detection, energy forecasting, semantic profile updates |
| `src/lib/session-state.ts` | Adapter — delegates to `guardian-runtime` |
| `src/lib/agent-loop.ts` | Adapter — delegates to `guardian-runtime` |
| `src/lib/tts.ts` | TTS abstraction: `say` fallback, queue policy, urgent-speech interruption |
| `src/lib/db.ts` | SQLite schema and helpers |

### API Routes (Guardian Contract)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/guardian/session/start` | POST | Start guardian session (intent → session creation → extension activation → SSE open) |
| `/api/guardian/session/end` | POST | End session, trigger reflection |
| `/api/guardian/events` | POST | Ingest normalized `GuardianEvent` from extension or other surfaces |
| `/api/guardian/stream` | GET | SSE stream of runtime state to dashboard |
| `/api/guardian/override` | POST | Submit and adjudicate override request |
| `/api/guardian/day-briefing` | GET | Longitudinal briefing from memory layers |
| `/api/guardian/optimize` | POST | Trigger optimizer run (off-session only) |
| `/api/voice/push-to-talk` | POST | Accept audio blob → transcribe → route to guardian intent |
| `/api/voice/transcribe` | POST | Forward to whisper.cpp; returns `{ transcript, confidence }` |
| `/api/voice/livekit/config` | GET | LiveKit config (optional transport) |
| `/api/voice/livekit/token` | POST | LiveKit token (optional transport) |

Legacy routes (`/api/agent/*`, `/api/extension/*`) are thin delegates — marked deprecated.

### Extension
| File | Role |
|------|------|
| `extension/background.js` | Tab tracking (session-scoped only), idle detection, block command executor |
| `extension/guardian.js` | Guardian state sync, block/unblock UI |
| `extension/popup.js` | Extension popup UI |
| `extension/sidebar.js` | Side panel session view |

Extension rules:
- Emits events **only during active sessions**
- No focus scoring in extension
- No autonomous policy in extension
- No passive monitoring when inactive

---

## Focus Score Algorithm

Computed every heartbeat tick (30s). Weighted composite:

| Component | Weight | Calculation |
|-----------|--------|------------|
| On-topic continuity | 35% | on-topic seconds ÷ total elapsed seconds |
| Tab switch rate | 25% | Inverse of switches/min. 0 = 100, >3/min = 0 |
| Dwell depth | 20% | Avg dwell on on-topic pages. >3 min = 100, <30s = 0 |
| Distraction revisit penalty | 15% | Each revisit to same distraction domain = -8 pts |
| Idle penalty | 5% | >5 min idle = -15, >10 min = -30 |

Trend: if current > mean of last 10 ticks +5 → `rising`; -5 → `falling`; else `stable`.

---

## Guardian Decision Table (Agent Loop, Layer 4)

Evaluated top-to-bottom each tick. First matching rule fires:

| Condition | Action | Tone |
|-----------|--------|------|
| distraction revisits ≥ 3 in 10 min | block + speak | direct_push |
| tabSwitches > 4 in 5 min AND on distraction | block + speak | firm warning |
| tabSwitches > 6 in 5 min (any) | speak only | grounding_nudge |
| idle > 8 min during session | speak + ping extension | check-in |
| focusScore drops > 15 pts in 3 ticks | speak only | motivational push |
| focusTrend = falling AND score < 60 | speak only | break_suggestion |
| elapsed = plannedMinutes × 0.5 | speak — midpoint check-in | midpoint_checkin |
| elapsed = plannedMinutes × 0.8 | speak — closing sprint | final_push |
| on-topic url, dwell > 4 min, score > 85 | auto-classify + silence | — |
| focus rising AND score > 88 for 3+ ticks | speak — flow confirmation | flow_confirmed |
| session personal best | speak — milestone | personal_best |
| none of the above | silence | — |

**Silence rule:** Minimum 90s between any two speech events. If score > 85 and stable, never interrupt. Block/extension actions exempt.

---

## Execution Rules (from phase-by-phase.md)

These are hard rules, not suggestions:

1. **One phase at a time** — do not start next phase until current passes acceptance criteria. Do not mix voice transport, optimizer logic, and runtime refactors in the same change set.
2. **Confidence gate** — `95%+`: implement. `80–94%`: clarify or reduce scope. `<80%`: do not implement.
3. **Change discipline** — prefer adapters over big-bang replacement. Keep legacy routes alive until replacements are verified. Avoid parallel edits on already-hot guardian files unless ownership is explicit.
4. **Verification gate per phase** — typecheck on touched surfaces, build passes, targeted behavior tests pass, manual scenario checklist passes.
5. **Rollback rule** — every phase must be mergeable or reversible without DB rescue work.
6. **Stop and ask rule** — if a phase reveals unresolved product ambiguity, stop and ask before coding rather than guessing.

---

## Voice Posture

- V1: **push-to-talk only**. No always-listening wake word.
- Primary local pipeline: `whisper.cpp` (STT) + `Silero VAD` + `Kokoro` (TTS)
- `say` (macOS): bootstrap fallback only, not long-term primary
- LiveKit: optional browser transport. Not a runtime dependency.
- No passive mic capture when inactive.
- TTS queue policy: max 2 queued messages, oldest dropped if full. Urgent speech may interrupt.

Env vars for local voice:
```
VOICE_MODE=local
WHISPER_CPP_MODEL=/absolute/path/to/ggml-small.en.bin
WHISPER_CPP_URL=http://127.0.0.1:8080/inference
```

Start local STT server: `npm run guardian:stt-local`

---

## Autonomy / Optimizer Posture

The optimizer may **only** edit these versioned policy artifacts:
- intervention prompt pack
- focus-score weights and thresholds
- override adjudication rubric
- retrieval/memory-selection prompt pack
- session planning policy
- voice phrasing policy
- red-team defense rules

It may **never** edit: route code, DB schema, extension permissions, auth logic, or runtime plumbing.

Primary metric: `guardian_eval_score` — weighted scalar across intent accuracy, distraction interception quality, false-positive block penalty, over-intervention penalty, override judgment quality, tone/trust score, session-outcome proxy.

Hard-fail gates: privacy violation, intervention while inactive, broken override expiry, unsafe block, regression on critical scenarios.

Promotion rules: baseline first → one candidate mutation → fixed eval budget → promote only on improved score with zero hard failures → canary before full activation → instant rollback on canary failure.

---

## DB Tables (Guardian-Specific)

| Table | Purpose |
|-------|---------|
| `guardian_sessions` | Session records |
| `guardian_event_log` | All normalized guardian events |
| `guardian_interventions` | Intervention history |
| `guardian_overrides` | Override requests and decisions |
| `guardian_semantic_profiles` | Stable user behavioral preferences |
| `guardian_artifact_versions` | Versioned policy bundles |
| `guardian_eval_cases` | Eval case definitions |
| `guardian_eval_runs` | Eval run results |
| `guardian_promotions` | Promotion history |
| `guardian_canary_results` | Canary test results |

---

## Test Scenarios to Always Verify

- Inactive privacy: zero extension emission, zero mic, zero interventions, zero network
- Session start/end lifecycle
- Hard block fires only under active session with rationale
- Override: scoped target + TTL, auto-expires, re-blocks
- Voice push-to-talk reaches runtime end to end
- Speech queue never overlaps itself
- Tired-day low-energy case (softer tone, shorter sprints)
- Manipulative override loophole request (should be denied)
- Productive scatter false positive (deep work mistaken for distraction)
- Long silent deep-work stretch (guardian should stay silent when score > 85)
- Browser idle with active session (check-in, not block)
- Extension disconnect/reconnect during active session

---

## What NOT to Do

- Do not add decision logic to pages, components, or route handlers — they collect input and render output only.
- Do not let the extension own focus scoring or policy.
- Do not expose raw SQL to the live guardian agent — use typed read models.
- Do not make the optimizer run on the live session hot path.
- Do not allow blanket guardian disable via override.
- Do not use Gemini Live as primary voice — it sends behavioral data to Google.
- Do not add tutor behavior unprompted — tutor mode is explicit only.
- Do not mix guardian responsibilities between old `/api/agent/*` routes and new `/api/guardian/*` routes — old routes are thin delegates, eventually deprecated.

---

## Phase 6 Checklist (Next Implementation Target)

From `final-execution.md` and `phase-by-phase.md`:

1. Freeze mutable artifact surface — formalize `GuardianPolicyBundle` as the only optimizer target
2. Define eval entities in DB: eval cases, runs, promotions, canaries
3. Build three eval sources: scripted held-out scenarios, replayed real session traces, adversarial override cases
4. Define scoring function with all components + hard-fail gates
5. Build keep-or-revert loop: baseline → one mutation → fixed budget → promote or revert
6. Add canary activation and rollback
7. Keep optimizer completely off live hot path

Confidence gate: `88–92%`. Needs eval metric formula locked before starting implementation.
