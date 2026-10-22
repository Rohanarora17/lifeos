# Endsem Lock-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Hold Rohan accountable for eight hours of Probability/ADSA study daily from 22 October through 13 November 2026.

**Architecture:** Extend the existing Next.js/SQLite app and Guardian evidence pipeline. A deterministic study ledger clips and unions measured intervals and separately labelled paper logs; a persisted scheduler loop emits actionable reminders without using AI to invent time. Existing Guardian handles capture, session lifecycle and distraction blocking.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript, better-sqlite3, node:test, Playwright.

**Spec:** Rules proposed and explicitly approved in this chat on 21 October 2026: eight hours each day including exam days; Probability on 10 November and ADSA on 13 November; paper work explicitly self-reported; no break/distraction credit; editable IST checkpoints at 12/16/20/22 for 2/4/6/8 hours; Start now / Delay 10 minutes / Record a blocker; repeated prompts; truthful daily history; nightly review and next start.

## Global Constraints

- Preserve unrelated dirty files and the existing Guardian architecture.
- Eight hours is 28,800 seconds per day. No borrowing between days.
- Campaign dates are inclusive in Asia/Kolkata. Today is setup, first full day is 22 October.
- Probability remains available on its exam date until explicitly marked finished; after 10 November default to ADSA. Never infer an exam time.
- Count only productive, active, counted, score-eligible canonical evidence; finalized authoritative slices replace legacy intervals, never add to them.
- Self-reported paper intervals require a subject, actual past start/end, and work notes. Overlapping time counts once.
- Reminders run on the app server, not a separate Codex automation. No external message is sent during tests.
- Keep interruptions within 08:00–23:00 IST; suppress during measured active study. Existing pause control remains available.

## Review Focus

1. Cross-midnight and duplicate evidence must not inflate time.
2. Authoritative/shadow/legacy pipelines must select exactly one source.
3. Snoozes, restarts and repeated ticks must retain their state and deduplicate alerts.
4. Missing Telegram/capture must be visible; failed delivery must not claim success.
5. Campaign end, exam transitions, and paper log validation must remain deterministic.

### Task 1: Deterministic ledger and persistence

**Files:** Create migration `053_endsem_lock_in.sql`, `src/lib/endsem-contract.ts`, `src/lib/endsem-study.ts`, `tests/unit/endsem-study.test.cjs`.

**Interfaces:** `getEndsemState(now?: Date): EndsemState`; `recordEndsemAction(input, now?: Date)`; shared JSON types in the contract.

- [x] Write failing tests for date bounds, midnight clipping, overlap, productive eligibility, authoritative source selection, self-reported logs and subject priority.
- [x] Run `node --test tests/unit/endsem-study.test.cjs` and confirm missing implementation fails.
- [x] Implement ledger, singleton configuration, response history and validated actions.
- [x] Rerun tests; require all assertions to pass.

### Task 2: Accountability loop and API

**Files:** Create `src/lib/endsem-accountability.ts`, `src/app/api/endsem/route.ts`, `tests/unit/endsem-accountability.test.cjs`; modify `src/lib/scheduler.ts`.

**Interfaces:** `runEndsemAccountability({now?, send?})`; authenticated GET state and POST validated actions.

- [x] Test behind-target nudges, 10-minute repeats, snooze, active-study suppression, quiet hours, end date, deduplication/restart and delivery failure.
- [x] Implement persisted in-app alerts and existing Telegram transport; register a one-minute job.
- [x] Test API invalid inputs and successful paper/blocker/checkpoint updates against isolated SQLite.

### Task 3: Study controls and rendered verification

**Files:** Create `src/components/EndsemLockIn.tsx`; modify `src/app/study-plan/page.tsx` and `src/app/page.tsx`; add operational documentation.

- [x] Show eight-hour progress, subject totals/exams, next 50-minute Guardian start, delay/blocker controls, paper log, editable checkpoints, nightly reflection/next start and day history.
- [x] Show transport/capture limitations and distinguish measured from self-reported minutes.
- [x] Run targeted tests, `npm test`, `npx tsc --noEmit --pretty false`, lint changed files and browser smoke with isolated data.
- [x] Inspect final diff; report verification, remaining live setup and commands. Leave changes uncommitted for review.

Execution: implement inline in this chat under the user's explicit “Build it with these rules” authorization; no second approval round.

## Implementation ledger

- Tasks 1–2 implemented; 16 new ledger/accountability/API tests pass, including RED/GREEN reproductions for stale delivery and unresolved snoozes found in independent review.
- Ruling: mount the counter in `LayoutWrapper` rather than separately on dashboard and study pages, so accountability stays visible across the app without duplicated feature code. Full controls appear only on Study Plans.
- Ruling: pass a lightweight commitment directive into the existing shared personalization snapshot; do not repeatedly load all study evidence for every AI prompt.
- Ruling: verify against isolated SQLite and disable the scheduler in the browser test server; do not mix synthetic study with real history or send external notifications during verification.
- Independent whole-change review: two reminder findings fixed with regression tests; follow-up review reports no new findings.
- TypeScript and targeted ESLint pass. Full suite: 274/275 pass just after IST midnight; existing `activity-correction.test.cjs` expects a full ten-minute interval in today’s activity even when its start belongs to yesterday. The same failure reproduces when loading the original HEAD personalization context in place of the changed module. No unrelated production code was changed to mask it.
- Browser environment: Turbopack watcher hit EMFILE and missed all routes; the temporary server uses existing Next webpack mode and polling instead. `localhost` is its canonical origin; `127.0.0.1` POSTs are rejected by the existing origin check. No auth/origin protections were weakened.

- Browser smoke passed with the real API on an isolated database: delay and blocker persistence, separately labelled paper credit, nightly reflection and next-start commitment. Native time fields now use input events so values survive controlled rerenders. The saved preview contains only test-database study.
- Final targeted verification: 16/16 tests; TypeScript, scoped ESLint and `git diff --check` pass. No product decisions remain open; live capture and scheduled Telegram delivery remain operational checks.
