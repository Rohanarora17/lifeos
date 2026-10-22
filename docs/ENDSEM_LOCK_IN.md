# Endsem Lock-In

Eight hours of actual Probability/ADSA study per day, **22 October–13 November 2026 inclusive**, in **Asia/Kolkata**. Probability is on **10 November**; ADSA is on **13 November**. Both are highest priorities until Probability is explicitly finished on its exam day (or its date has passed), then ADSA becomes the priority. Exam times are intentionally unspecified.

The [MacBook study conversation](MACBOOK_STUDY_CHAT.md) extends this counter with native text check-ins, meal/class return agreements and remaining-day replanning. After its first accepted message, conversational follow-through replaces the fixed checkpoint reminder loop described below.

## What changed

- Every normal LifeOS page has a compact daily counter and next-block action. **Study Plans** contains the full controls and daily record.
- Start a 50-minute block (or the smaller remaining target) through existing Guardian. Its collector readiness checks, session controls and distraction protection remain authoritative. An already active session is opened in Guardian rather than replaced.
- Productive, active, counted, score-eligible intervals in clearly named Probability/ADSA sessions count. Authoritative sessions use finalized authoritative slices; legacy/shadow sessions use the legacy timeline. Uncertain, idle, private, disconnected, neutral and distracting time do not count.
- Intervals are clipped at IST midnight and the campaign bounds. Overlap across collectors, sessions, subjects and paper declarations counts once. Measured evidence takes precedence over paper declarations.
- Paper study requires actual past start/end times, a subject and work notes, and is labelled **self-reported**. It contributes to the daily total but is never presented as measured evidence. No AI estimates study minutes.
- Confirmed attended Probability/ADSA classes can be logged through Study Chat using a known calendar occurrence and actual past attendance times. They are labelled self-reported class time and deduplicated against measured and paper evidence. A scheduled class alone earns nothing.
- Checkpoints default to **12/16/20/22 IST** for **2/4/6/8 hours**, and are editable. Delays last ten minutes; blockers and delays earn no credit. A delayed start is resolved when eligible study resumes, while its delay count remains visible.
- The app server checks every minute. It creates persistent in-app prompts and sends them through existing Telegram credentials when enabled. Behind-target prompts repeat at ten-minute intervals, within 08:00–23:00 IST. Measured active study, an unexpired delay, or the explicit pause control suppresses interruptions.
- Failed Telegram delivery is retained honestly and retried after five minutes only while the trigger and progress snapshot remain current. A restart does not reset delays or create duplicate alerts.
- The last checkpoint asks for a nightly reflection and tomorrow's first start. A missed committed first start is checked after five minutes. Missed daily targets remain visible, with no borrowing from another day.
- The shared personalization context carries the exam commitment into existing AI coaching, Guardian and planning prompts. Block size may adapt; the fixed daily target must not silently shrink.

## Start and use

```bash
cd /Users/rohan/.gemini/antigravity/scratch/lifeos
WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=true npm run dev -- --webpack
```

Open [Study Plans](http://localhost:3000/study-plan). Migration `053_endsem_lock_in.sql` is applied by normal database initialization. Existing credentials and study history are preserved. Keep the LifeOS server running for scheduled prompts; loading the page alone does not run the reminder loop.

For continuous operation, use the existing LaunchAgent instructions in the README. A deployment to another machine requires updating and restarting that machine's server; this change does not remotely deploy itself.

For computer study, run the existing LifeOSCopilot client and Chrome extension and grant the required Screen Recording permission. The panel reports missing collector readiness. Telegram configuration can come from environment variables or Settings; the panel reports missing/disabled configuration and the last successful delivery. No Telegram message was sent as part of the isolated tests.

## Verification and pending work

```bash
node --test tests/unit/endsem-*.test.cjs
npm test
npx tsc --noEmit --pretty false
npx eslint src/lib/endsem-*.ts src/app/api/endsem/route.ts src/components/EndsemLockIn.tsx src/components/LayoutWrapper.tsx src/lib/personalization-context.ts
```

The original counter suite has 16 tests. The conversational extension adds runtime, route, planner, Guardian and native checks; the final 23 October integrated run passed **350/350 tests**, with production build, TypeScript and scoped ESLint also passing. An earlier full-suite test exposed an existing midnight-sensitive `activity-correction.test.cjs` fixture; that earlier failure was not masked by changing unrelated code. Full evidence and operational activation limits are recorded in the approved implementation plan.

The retained test cases cover midnight clipping, overlapping evidence, pipeline selection, eligibility, paper validation/retries, no carry-over, deadline transitions, snooze/pause, quiet hours, deduplication, failed/stale delivery and API actions. Browser smoke uses a separate temporary database and disables the scheduler, so test actions do not alter real study history or send notifications.

Pending operational verification: a real Guardian capture session and a real scheduled Telegram delivery on the machine hosting the app. The temporary browser test database has no connected collector. Actual comprehension and paper work cannot be established from computer telemetry.

Unresolved product decisions: none blocking the approved implementation. No syllabus, mastery targets, exam start times or mandatory subject-hour split were invented.
