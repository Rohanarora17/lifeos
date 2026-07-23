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

Overall goal status: about 90-91% complete.

Implemented product behavior: about 85-90% complete. The shared personalization spine is now used broadly across the scheduler, notifications, Telegram agent, analytics, rewards, memory extraction, adaptive policy generation, task linking, calendar helpers, and guardian flows.

Verified end-to-end behavior: about 88-90% complete. Isolated scenario gates now prove time-target task completion, planned Guardian session start/end completion flow, recovery-day planning behavior, deadline-day planning and reminder behavior, planning-evening intake plus edit sync, protect-focus alert and completion behavior, next-day planning persistence, planner create/edit/cancel backend sync, calendar create/update/delete sync through the Google Calendar CRUD boundary, adaptive alert feedback learning, and repeated feedback being distilled into memory.

User-facing hardcoded fallback cleanup: about 90-93% complete for the surfaces inspected so far. Dashboard, analytics, activity, calendar, store, planner, memory, Telegram, settings, voice, reward, notification fallback copy, and major setup/error paths now have substantially more contextual behavior, but a final rendered/manual audit is still needed.

## Done Or Strong

- Shared personalization context exists and is no longer isolated to one page.
- Notifications and alert decisions now use day-aware context instead of one-size-fits-all reminder copy.
- Alert feedback is verified to change later notification behavior: weak feedback softens future reminders, repeated dismissals suppress low-value alerts, and feedback is written into memory.
- Time-session task infrastructure exists, including logic that can link focus sessions to tasks and complete time-target tasks from accumulated minutes.
- Time-session task completion is verified with a repeatable isolated scenario.
- Planned Guardian sessions are verified to lock to a soft-watch commitment, complete the planned focus session, credit linked task minutes, and finish the time-target task.
- Recovery-day, deadline-day, planning-evening, and protect-focus scenario fixtures now prove that day state changes task choice, block size, reward reasoning, reminder posture, tomorrow intake, calendar-backed edit sync, routine alert suppression, task-reminder linking, live protect-focus mode, and linked session completion.
- Next-day planning infrastructure exists and accounts for sleep, wake, mood, energy, calendar context, task candidates, and schedule fit.
- Next-day planning persistence, session creation, edit/cancel backend sync, adaptive task-specific session rules, and calendar conflict avoidance are verified with repeatable isolated scenarios.
- Calendar create/update/delete sync is verified through the Google Calendar CRUD boundary using deterministic fake-calendar mode; live OAuth still needs a real-account smoke check.
- Agent and LLM prompts now receive personalization context in several key paths.
- Reward pricing and reward history fallback copy adapt to current mode and learned context.
- Empty and degraded states across major visible surfaces are less generic and more tied to the user's current day, including Calendar and Activity Timeline policy states.
- Planner, optimizer, memory extraction, Telegram, analytics, and dashboard paths now share the same direction instead of each inventing local assumptions.

## Remaining Work

- Run rendered/manual browser smoke checks for recovery day, deadline day, planning evening, and protect-focus day.
- Audit whether every focus session created from the planner links cleanly back to the intended task or goal.
- Extend planned-session completion evidence inside the recovery, deadline, and planning-evening fixtures rather than relying on the shared completion verifier plus protect-focus fixture.
- Confirm session feedback and evening journal signals alter later planning choices beyond alert learning.
- Consolidate any repeated local adaptive-copy helpers into shared utilities if the final audit shows drift.
- Run a final high-impact hardcoded fallback search and either adapt or explicitly justify each remaining default.
- Verify live calendar behavior with the user's actual Google OAuth account or documented ICS setup.

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

1. `test: add personalization scenario fixtures`
2. `test: verify final recovery-day scenario`
3. `test: verify feedback affects later planning`
4. `refactor: centralize adaptive empty state helpers`
5. `docs: record final personalization completion audit`
