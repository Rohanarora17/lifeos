# Personalization Goal Assessment

Date: 2026-07-23  
Last corrected: 2026-07-25

## Two tiers (do not collapse)

Personalization is not one percentage. Split it:

| Tier | Name | Question it answers |
| --- | --- | --- |
| **A** | Adaptive Day OS | Does the product plan, run, notify, reward, and speak using *today’s* context instead of generic defaults? |
| **B** | Cognitive Self-Map | Does the product map *how / why / when your brain works* (including pressure dependency), show evidence, and eventually help rewire performance? |

Tier A is mostly product adaptivity. Tier B is the real north star for someone pressure-wired who wants to understand and change that wiring.

---

## Tier A — Adaptive Day OS

### Goal

LifeOS should stop behaving like every day is the same. The application and agent should make informed choices from the user's schedule, focus history, task type, mood, sleep, feedback, calendar context, rewards, and memory. Hardcoded defaults are acceptable only as cold-start fallbacks when there is not enough signal yet.

This tier is finite. It is complete when the core product can repeatedly plan, run, adapt, and learn from a day without relying on generic assumptions where personalized context exists.

### Completion bar

1. Shared context spine: every major product and agent surface consumes a common personalization snapshot or an explicit domain policy derived from it.
2. Time-based task model: tasks are defined by target minutes, and linked focus-session minutes complete them automatically when the accumulated target is reached.
3. Next-day planning loop: the evening flow collects tomorrow intent, likely sleep/wake changes, mood, energy, calendar constraints, and task priorities before generating sessions.
4. Calendar and backend sync: generated sessions are editable, reschedulable, and kept consistent between LifeOS storage and calendar events.
5. Adaptive notification policy: reminders account for current mode, planned focus, deadline pressure, alert fatigue, recovery needs, and prior feedback.
6. Feedback/self-model loop: session feedback, evening journal, mood, sleep, alert reactions, and task outcomes update future prompts and policies.
7. Reward policy: XP, coins, and reward pricing adapt to task type, effort, timing, deadline pressure, energy, and user overrides.
8. Surface audit: high-impact empty states, fallback prompts, notification copy, and agent replies are contextual whenever a personalization snapshot is available.
9. Verification gates: TypeScript passes, targeted scenario checks pass, and hardcoded fallback audits show no major remaining generic behavior in personalized surfaces.

### Current assessment (Tier A)

Overall Tier A status: about **87-89%** complete.

- Implemented product behavior: about **86-90%** for backend and agent paths.
- Verified backend behavior: about **86-89%**.
- User-facing hardcoded fallback cleanup: about **79-84%**.

Assessment correction on 2026-07-24: the prior 91-92% estimate was too high because it weighted isolated backend verifiers too heavily.

Assessment correction on 2026-07-25: Tier A completeness must **not** be reported as overall personalization completeness. Tier B is separate and earlier.

### Tier A finish scenarios

1. Recovery day  
2. Deadline day  
3. Planning evening  
4. Protect-focus day  

Each must demonstrate time-target completion, calendar/backend sync, adaptive reminders, personalized agent response, context-aware rewards, and a feedback/mood/sleep/journal signal that changes a later decision.

### Remaining Tier A hygiene

- Expand rendered smoke beyond dashboard/Guardian.
- Rerun live evening extraction with a valid Gemini Developer API key.
- Live Google OAuth calendar smoke.
- Final high-impact hardcoded fallback audit.
- Centralize adaptive empty-state helpers if drift remains.

Do **not** block Tier B on 100% Tier A.

---

## Tier B — Cognitive Self-Map

### Goal

Map the user as a person, not only as a day mode:

1. **Map** — durable traits: pressure dependency, activation energy, avoidance signature, voluntary start rate, crisis performance, peak windows.
2. **Explain** — answer *how / why / when* the brain works with confidence + evidence chains.
3. **Optimize** — after the map is trusted, actively coach rewiring toward high performance without only being able to start under crisis pressure.

User identity signal (2026-07-25): works well under deadlines/pressure; wants to understand that wiring and change it over time — not shame crisis productivity, measure it and build alternatives beside it.

### What exists today vs Tier B need

| Layer | Exists | Tier B gap |
| --- | --- | --- |
| Day snapshot modes (`deadline_pressure`, …) | Yes | Weather for today, not climate of the person |
| UIL narrative + thresholds | Yes | Regenerated story; weak causal trait graph |
| Self-model beliefs | Partial | Thin until cognitive traits wired |
| Archetype / heatmaps on Insights | Yes | Labels and charts, little pressure science |
| Deterministic pressure traits | **In progress (B1)** | PDI, voluntary starts, lag, avoidance, crisis bonus |
| Confirm/dispute identity loop | No | Needed for trust |
| Brain Map as Insights home | No | Elevate Insights |
| Light experiments → active rewiring | No | End goal after map trust |

**Honest Tier B status (2026-07-25, after shared-spine integration):** about **90-95% of the Cognitive Self-Map spine**. Deterministic pressure traits, confirm/dispute, Insights Brain Map, light experiments, history/trends, weekly questions, active coach, **and first-class `snapshot.cognitive` + UIL ground-truth ingestion** so COM is not a silo.

**Shared spine proof:** `tests/unit/cognitive-shared-spine.test.cjs` — snapshot carries structured cognitive fields; `formatPersonalizationContext` reuses them; `getIntelligenceContext` includes the same map for guardian/agents.

**Verified by automated suite (not build-only):**
- `npm run test:cognitive` — unit/integration against temp SQLite + production lib/route code
- `npm run test:e2e:brain-map` — Playwright + real Next server on `/insights`

**Recheck fixes applied:** `getNextDayPlan` now reloads candidates with coach bias; planned-session XP no longer incorrectly snaps multipliers via `clampMinutes` (that crushed adaptive XP); voluntary rewiring bonus applies to XP as well as coins; API tests assert `activeCoach` / mode toggle.

**Remaining polish / live deps:**
- Live Gemini evening extraction: requires a **valid** Developer API key (`npm run verify:live-evening-extraction` or `npm run test:live-gates`).
- Live Google Calendar OAuth: fake CRUD verified; real-account smoke still manual (`npm run test:live-gates` reports env honestly).
- Multi-week trajectory: code + unit tests for week buckets; sparklines fill as real days accumulate.

**Self-answer path (implemented):** chat + voice deep_analysis ground on `buildCognitiveSelfAnswer` / `explainCognitiveWiring` — deterministic evidence for how/why/when questions.

### Tier B phases

| Phase | Name | Status |
| --- | --- | --- |
| B0 | Doc split Tier A vs B | Done |
| B1 | Deterministic pressure & activation metrics | Done (`cognitive-traits`, `verify:cognitive-traits`) |
| B2 | Hypothesis confirm/dispute + memory promotion | Done (`setCognitiveTraitStance`, `verify:cognitive-trait-stance`) |
| B3 | Elevate Insights into Brain Map | Done (Insights Brain Map UI + confirm/dispute controls; Settings links here) |
| B4 | Light experiments (map-first) | Done (`cognitive-experiments`, planner bias, Insights accept/decline, `verify:cognitive-experiments`) |
| B4.5 | Active coach/rewiring (end goal after trust) | Done (`cognitive-active-coach`, planner/reward auto-rewire, Insights panel, `tests/unit/cognitive-active-coach.test.cjs`) |
| B5 | Longitudinal trajectory + weekly reckoning | Done (history snapshots, trends, weekly cognitive question, `verify:cognitive-history`) |

### Locked product decisions

1. Primary traits first: **Pressure Dependency Index** + **Voluntary Start Rate**.
2. Surface home: **elevate `/insights`** into Brain Map (not a buried Settings panel).
3. Intervention path: **map first + light experiments**, then **active coach/rewiring** once metrics are trusted.
4. Deterministic extractors own numbers; AI only narrates and proposes hypotheses.
5. Never fight true deadline days when pressure is the only available fuel — log and protect performance.

### Tier B finish criteria

1. Open Insights and answer when/how/why you work and how pressure-dependent you are — with evidence.
2. PDI, voluntary start rate, start lag, crisis bonus computed (or explicitly low-confidence when sparse).
3. At least one identity hypothesis can be confirmed/disputed and changes later agent/planner language.
4. Planner/Guardian uses COM for at least one pressure-aware or rewiring-aware choice (not only day mode).
5. Weekly view shows pressure-dependency trajectory.
6. Tier A scenario suite still passes.

### Core traits (B1+)

| Trait | Definition |
| --- | --- |
| Pressure Dependency Index (PDI) | How strongly first starts and focus minutes cluster near deadlines |
| Voluntary Start Rate | Share of linked sessions started with no near deadline |
| Activation Energy | Mean days from task create → first linked focus |
| Avoidance Age | Mean days overdue at first focus when work goes late |
| Crisis Performance Bonus | Focus score delta: near-deadline sessions vs calm sessions |

---

## Requirement evidence audit (Tier A)

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Shared context spine across major backend/agent paths | Personalization snapshot used broadly | Strong; still needs rendered surface audit |
| Time-based task completion | Final scenario fixtures + task-time verifier | Strong |
| Next-day planning from sleep/wake/mood/energy/calendar/tasks | Next-day + final + evening-journal verifiers | Strong backend proof |
| Calendar/backend sync | Fake Google Calendar CRUD | Strong deterministic; live OAuth unverified |
| Adaptive notifications | Alert feedback, planned-focus, protect-focus | Strong backend proof |
| Feedback/self-model loop | Multiple learning verifiers; live extraction key issues | Good; live AI extraction flaky locally |
| Adaptive rewards | Recovery/deadline reward reasoning | Good |
| Whole rendered app feels personalized | Dashboard + Guardian Playwright smokes | Partial |
| Tier B cognitive traits | `cognitive-traits` extractors + self-model wiring | B1 |

---

## Done or strong (Tier A)

- Shared personalization context exists and is used across major paths.
- Notifications, planner feedback, Guardian session feedback, and evening journal signals change later behavior.
- Time-session task completion and planned Guardian session completion are verified.
- Recovery, deadline, planning-evening, and protect-focus final fixtures prove linked task completion.
- Calendar create/update/delete verified through fake Google Calendar mode.
- Rendered smoke exists for dashboard and Guardian adaptive states.

---

## Verification commands

### Tier A

```bash
npm run verify:task-time-sessions
npm run verify:next-day-planner
npm run verify:calendar-sync
npm run verify:alert-feedback-learning
npm run verify:planner-feedback-learning
npm run verify:session-feedback-planning
npm run verify:evening-journal-planning
npm run verify:planned-focus-alerts
npm run verify:planned-session-flow
npm run verify:adaptive-calendar-policy
npm run verify:adaptive-activity-policy
npm run verify:final-recovery-day
npm run verify:final-deadline-day
npm run verify:final-planning-evening
npm run verify:final-protect-focus
npm run verify:rendered-adaptive-planner
npm run verify:rendered-deadline-protect
npm run verify:live-evening-extraction
npx tsc --noEmit --pretty false
```

### Tier B (formal suite preferred)

```bash
# Real runtime unit/integration (node:test + temp SQLite + production lib code)
npm run test:cognitive

# Real browser e2e (Next server + Playwright Chromium on /insights Brain Map)
npm run test:e2e:brain-map

# Full cognitive gate
npm run test:cognitive:all

# Legacy ad-hoc verifiers (still valid; suite is the source of truth)
npm run verify:cognitive-traits
npm run verify:cognitive-trait-stance
npm run verify:cognitive-experiments
npm run verify:cognitive-history
```

Verification note: prior `verify:*` scripts **do** execute production code against isolated DBs (not build-only). The formal suite adds `describe`/`it` structure, API handler tests, planner coverage for both experiment kinds, and Playwright UI coverage.

---

## Suggested remaining commit stack

1. `docs: split personalization Tier A vs Cognitive Self-Map Tier B`
2. `feat: deterministic pressure dependency + voluntary start metrics`
3. `feat: self-model beliefs + API exposure for cognitive traits`
4. `test: pressure-wired vs steady-starter cognitive trait fixtures`
5. `feat: hypothesis confirm/dispute + memory promotion` (B2)
6. `feat: elevate Insights into Brain Map` (B3)
7. `feat: light experiments then active rewiring coach` (B4 → B4.5)
8. `docs: final Tier B completion audit`
