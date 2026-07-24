# Personalization Goal Assessment

Date: 2026-07-23

## Goal

LifeOS should stop behaving like every day is the same. The application and agent should make informed choices from the user's schedule, focus history, task type, mood, sleep, feedback, calendar context, rewards, and memory. Hardcoded defaults are acceptable only as cold-start fallbacks when there is not enough signal yet.

This goal is finite. It is complete when the core product can repeatedly plan, run, adapt, and learn from a day without relying on generic assumptions where personalized context exists.

## Completion Bar

The goal is done when these checkpoints are true:

1. Shared context spine: every major product and agent surface consumes a common personalization snapshot or an explicit domain policy derived from it.
2. Time-based task model: tasks are defined by target minutes, and linked focus-session minutes complete them automatically when the accumulated target is reached.
3. Next-day planning loop: the evening flow collects tomorrow intent, likely sleep/wake changes, mood, energy, calendar constraints, and task priorities before generating sessions.
4. Calendar and backend sync: generated sessions are editable, reschedulable, and kept consistent between LifeOS storage and calendar events.
5. Adaptive notification policy: reminders account for current mode, planned focus, deadline pressure, alert fatigue, recovery needs, and prior feedback.
6. Feedback/self-model loop: session feedback, evening journal, mood, sleep, alert reactions, and task outcomes update future prompts and policies.
7. Reward policy: XP, coins, and reward pricing adapt to task type, effort, timing, deadline pressure, energy, and user overrides.
8. Surface audit: high-impact empty states, fallback prompts, notification copy, and agent replies are contextual whenever a personalization snapshot is available.
9. Verification gates: TypeScript passes, targeted scenario checks pass, and hardcoded fallback audits show no major remaining generic behavior in personalized surfaces.

## Current Assessment

Overall goal status: about 84-87% complete.

Implemented product behavior: about 86-90% complete for the backend and agent paths inspected so far. The shared personalization spine is now used broadly across the scheduler, notifications, Telegram agent, analytics, rewards, memory extraction, adaptive policy generation, task linking, calendar helpers, and guardian flows.

Verified backend behavior: about 86-89% complete. Isolated scenario gates prove time-target task completion, planned Guardian session start/end completion flow, recovery-day planning plus linked task completion, deadline-day planning plus linked task completion, planning-evening intake/edit/calendar sync plus linked task completion, protect-focus alert and completion behavior, evening-journal signals changing the next generated plan, next-day planning persistence, planner create/edit/cancel backend sync, calendar create/update/delete sync through the Google Calendar CRUD boundary, adaptive alert feedback learning, task recommendation feedback changing later planning choices, Guardian session feedback shortening later planning blocks, and repeated feedback being distilled into memory. This is strong backend evidence, but it is not the same as proving the full rendered application experience.

User-facing hardcoded fallback cleanup: about 72-80% complete. Dashboard, analytics, activity, calendar, store, planner, memory, Telegram, settings, voice, reward, notification fallback copy, and major setup/error paths now have substantially more contextual behavior. The remaining risk is not just copy: rendered browser smoke checks, live AI extraction, live calendar sync, and a complete component-by-component fallback audit are still missing.

Assessment correction on 2026-07-24: the prior 91-92% estimate was too high because it weighted isolated backend verifiers too heavily. The user goal says the whole application and agent should feel adaptive across all layers. Current evidence proves many core mechanisms, but not every visible surface, not every final scenario criterion in each scenario, and not the live external integrations.

## Requirement Evidence Audit

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Shared context spine across major backend/agent paths | Personalization snapshot is used in planner, notifications, Telegram, rewards, analytics, memory, guardian, scheduler paths. | Strong but still needs rendered surface audit |
| Time-based task completion | `verify:task-time-sessions`, `verify:planned-session-flow`, and all four final scenario fixtures prove credited focus minutes complete linked tasks. | Strong |
| Next-day planning from sleep/wake/mood/energy/calendar/tasks | `verify:next-day-planner`, `verify:final-planning-evening`, `verify:final-recovery-day`, and `verify:evening-journal-planning`. | Strong backend proof |
| Calendar/backend sync | Fake Google Calendar CRUD and planning-evening edit sync are verified. | Strong deterministic proof; live OAuth unverified |
| Adaptive notifications | Alert feedback, deadline alerts, planned-focus suppression, evening planner, and protect-focus task reminder linking are verified. | Strong backend proof |
| Feedback/self-model loop | Alert feedback, task recommendation feedback, Guardian session feedback, memory distillation, and deterministic evening-journal planning are verified. | Good; live AI extraction still unverified |
| Adaptive rewards | Recovery and deadline scenarios assert reward reasoning; reward pricing policy exists. | Good; not all final scenarios assert rewards |
| Whole rendered app feels personalized | Static searches show many adaptive empty states, but no current Playwright/manual rendered smoke pass proves the experience. | Incomplete |
| Every final scenario demonstrates every finish-criteria bullet | All four final scenarios now prove linked time completion. Some still rely on separate fixtures for full calendar CRUD, live personalized agent response, and learning feedback loops. | Partial |

## Done Or Strong

- Shared personalization context exists and is no longer isolated to one page.
- Notifications and alert decisions now use day-aware context instead of one-size-fits-all reminder copy.
- Alert feedback is verified to change later notification behavior: weak feedback softens future reminders, repeated dismissals suppress low-value alerts, and feedback is written into memory.
- Planner feedback is verified to change later planning choices: positive recommendation feedback lifts a task into the plan, negative feedback keeps the task visible but unscheduled, and candidate reasons cite the learned signal.
- Guardian session feedback is verified to change later planning shape: similar reading blocks are shortened after the user reports they were too long and low-focus.
- Evening journal signals are verified to change later planning: late sleep, low mood/energy, and day events move the next plan into recovery mode, prioritize lighter work, shorten the block, defer optional high-energy work, and keep the check-in linked as the plan source.
- Time-session task infrastructure exists, including logic that can link focus sessions to tasks and complete time-target tasks from accumulated minutes.
- Time-session task completion is verified with a repeatable isolated scenario.
- Planned Guardian sessions are verified to lock to a soft-watch commitment, complete the planned focus session, credit linked task minutes, and finish the time-target task.
- Recovery-day, deadline-day, planning-evening, and protect-focus scenario fixtures now prove that day state changes task choice, block size, reward reasoning, reminder posture, tomorrow intake, calendar-backed edit sync, routine alert suppression, task-reminder linking, live protect-focus mode, and linked session completion. All four final fixtures now prove linked task completion inside the fixture itself.
- Next-day planning infrastructure exists and accounts for sleep, wake, mood, energy, calendar context, task candidates, and schedule fit.
- Next-day planning persistence, session creation, edit/cancel backend sync, adaptive task-specific session rules, and calendar conflict avoidance are verified with repeatable isolated scenarios.
- Calendar create/update/delete sync is verified through the Google Calendar CRUD boundary using deterministic fake-calendar mode; live OAuth still needs a real-account smoke check.
- Agent and LLM prompts now receive personalization context in several key paths.
- Reward pricing and reward history fallback copy adapt to current mode and learned context.
- Empty and degraded states across major visible surfaces are less generic and more tied to the user's current day, including Calendar and Activity Timeline policy states.
- Planner, optimizer, memory extraction, Telegram, analytics, and dashboard paths now share the same direction instead of each inventing local assumptions.

## Remaining Work

- Run rendered/manual browser smoke checks for recovery day, deadline day, planning evening, and protect-focus day.
- Audit whether every focus session created from the planner links cleanly back to the intended task or goal outside the final fixtures.
- Confirm the non-deterministic AI extraction path from raw evening prose with a live Gemini key; deterministic extracted-signal planning is now verified.
- Consolidate any repeated local adaptive-copy helpers into shared utilities if the final audit shows drift.
- Run a final high-impact hardcoded fallback search and either adapt or explicitly justify each remaining default.
- Verify live calendar behavior with the user's actual Google OAuth account or documented ICS setup.
- Add at least one rendered smoke check that proves the dashboard/planner/guardian surfaces expose the adaptive state, not only backend payloads.

## Finish Criteria

The personalization goal can be called complete when these four scenario runs pass:

1. Recovery day: low sleep or low mood produces smaller focus blocks, gentler reminders, recovery-safe rewards, and non-generic agent guidance.
2. Deadline day: urgent work gets higher-priority scheduling, more protective notifications, stronger reward pricing, and reduced optional distractions.
3. Planning evening: the app asks for tomorrow's intent, accounts for late sleep or schedule shifts, creates sessions, syncs them to calendar, and keeps edits consistent.
4. Protect-focus day: the app learns the best session length and timing from past performance, then schedules and reminds around that pattern.

Each scenario must demonstrate:

- Time-target task completion from linked accumulated focus minutes.
- Calendar and backend session sync after create, edit, reschedule, and delete.
- Adaptive reminder behavior.
- Personalized agent response using current context.
- Reward or XP choice that reflects task effort and day context.
- Feedback, mood, sleep, or journal signal influencing a later decision.

## Verification Commands

Run these before the goal is closed:

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
npx tsc --noEmit --pretty false
git diff --check
rg -n "No .*found|No .*yet|fallback|default|not configured|LLM is offline|manual planned-session|No tasks found" src/lib src/app src/components --glob '!**/*.js'
```

## Suggested Remaining Commit Stack

These should stay narrow and reviewable:

1. `test: verify rendered planner adaptive state`
2. `test: verify live/prose evening extraction when Gemini key is available`
3. `refactor: centralize adaptive empty state helpers`
4. `docs: record final personalization completion audit`
