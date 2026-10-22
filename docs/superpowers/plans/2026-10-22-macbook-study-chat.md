# MacBook Study Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for independent implementation tasks and reviews. Preserve unrelated working changes; do not commit or push automatically.

**Goal:** Deliver persistent native text conversations that update study/meal/class agreements, rebalance the remaining day, and follow up on missed returns.

**Architecture:** Shared typed study actions and SQLite state serve native and web chat. Reuse Guardian for measured study and the existing planner tables for scheduled sessions. AI interprets language; deterministic actions own dates, credit, conflict checks and reminders.

**Tech Stack:** Existing Next.js/TypeScript/better-sqlite3 backend and Swift 6 AppKit MacBook client.

**Spec:** `docs/superpowers/specs/2026-10-22-macbook-conversational-study-design.md`, approved by “yes do it.”

## Global Constraints

- MacBook and existing web app only; native text chat is primary and requires no active session or microphone.
- Eight hours daily, 22 October–13 November inclusive, IST; Probability 10 November; ADSA 13 November.
- Attended relevant classes count only after confirmation, labelled self-reported, without overlapping other credit.
- Calendar, meals, travel and explicit sleep constraints protect real commitments. Do not silently invent missing constraints or lower the target.
- Persist agreements, pending questions, revisions, request IDs, chat history and reminders. Superseded reminders cannot fire.
- Five-minute grace; overdue repeats at most every ten minutes. Presence checks retain priority and their existing accounting/deadlines.
- General chat sends text, without screenshots/microphone. Preserve existing voice and collector paths.
- No implicit external calendar writes, third-party notifications, OS locking or administrator changes.

## Review Focus

1. Duplicate/stale/concurrent requests cannot repeat a credit, extend a break twice, or apply a proposal to the wrong activity.
2. Calendar freshness, DST-free IST midnight, all-day events, infeasible schedules and chained commitments cannot invent free time.
3. Unknown return time cannot become indefinite protection; extensions invalidate old prompts; offline chat cannot claim successful saves.
4. User drafts, keyboard focus, session-independent chat and presence/return prompt arbitration survive native polling.
5. Class credit and measured activity cannot double count, and generic coaching cannot contradict protected activities.

### Task 1: Shared state, actions, intent and API (parent)

Files: `054_study_chat.sql`, `study-chat-contract.ts`, `study-chat-store.ts`, `study-chat-intent.ts`, `study-chat.ts`, `/api/study-chat/route.ts`, tests `study-chat*.test.cjs`; narrow integration in Endsem ledger, scheduler/auth and coaching policy.

Interfaces: `getStudyChatState(now?): StudyChatState`; `processStudyChatMessage({message,requestId,revision,date},options?): Promise<StudyChatState>`; `runStudyChatAccountability(now?): void`; shared contract below. POST `{action:'message',message,requestId,revision,date}` (date binds the revision to the intended IST day) or `{action:'ack_prompt',promptId,deviceId}`. GET returns state. Errors use `{error,state?}` with 400/409/503 as appropriate; normal state includes `ok:true`.

- [x] Write and run failing runtime tests for lunch clarification, duration follow-up, extension, return/start, revision/idempotency, attendance, missing AI/calendar and late classes.
- [x] Implement persisted state and typed validated actions. AI parsing has a deterministic supported-command fallback; never claim a mutation from prose alone.
- [x] Wire the class ledger and coordinated schedule-aware reminders, retaining Guardian readiness and presence semantics.
- [x] Prove state/API/security behavior on isolated databases; no outbound notifications.

### Task 2: Remaining-day planner (planner implementer)

Files owned: `src/lib/study-day-planning.ts`, `tests/unit/study-day-planning.test.cjs`, narrow freshness updates in `src/lib/calendar.ts` only.

Interfaces: `refreshStudyCalendar(now?: Date): Promise<StudyCalendarSnapshot>` reads configured app calendar data and reports fresh/stale/unconfigured; `rebalanceStudyDay(input:{now:Date; calendar:StudyCalendarSnapshot; protectedIntervals:StudyProtectedInterval[]; subject:StudySubject; revision:number}): StudyDayPlan`; `readStudyDayPlan(now?:Date): StudyDayPlan | null`. Persist plan JSON in `study_chat_days.plan_json` and schedule through existing `daily_plans`/`planned_focus_sessions`, marking owned sessions in `rule_json.studyChat`.

- [x] Test no class/meal overlap, relevant future classes, expired/active sessions, no side-effecting calendar writes, explicit day end required, empty/stale calendars, partial blocks, infeasibility, subject preservation and no past rewriting.
- [x] Refresh ICS freshness including successful empty sync; read mirror only when known fresh. OAuth fallback may use a read-only mirror refresh. Never use connected MCP tools at runtime.
- [x] Rebalance owned unstarted work that still has remaining time, including missed proposed starts; preserve active/completed work and explicit constraints. Record calendar-sync-pending metadata rather than write external calendars.
- [x] Run targeted tests and report interfaces and verification.

### Task 3: Native text conversation (native implementer)

Files owned: `macos/LifeOSCopilot/**`, `scripts/install-native-copilot.sh` version updates only. Do not edit backend/UI files.

Wire contract in `study-chat-contract.ts` is authoritative. Add optional Codable fields as needed to accept response shape. GET/POST `/api/study-chat` with existing device authorization. `StudyChatState` includes revision/date/messages/activity/pendingPrompt/plan; do not require a Guardian session. Existing presence panel wins over proactive chat prompts.

- [x] Write meaningful Swift tests for wire decoding, draft/retry state, revision handling and prompt arbitration; show RED before implementation.
- [x] Implement a floating native chat panel, editable composer, persistent conversation/draft and safe retries; menu entry opens it. Proactive display must not steal keyboard focus.
- [x] Poll alongside existing heartbeat, never block collectors, queue while presence prompt visible, acknowledge displayed prompt but do not resolve it on minimization.
- [x] Compile and test with caches under `/tmp` when needed. Prepare updated client installation without modifying installed apps or granting permissions.

### Task 4: Web surface, review and delivery (parent + reviewers)

- [x] Add the same conversation to Study Plans and shared chat actions to Jarvis; remove fixed checkpoint controls when conversational mode owns the day.
- [x] Exercise real API/browser flows with isolated state, compile native code, run scoped lint, TypeScript and full unit suite.
- [x] Review each implementation task and the final integrated flow; fix findings with regression tests.
- [x] Update operational docs and approved spec status with implemented/verified boundaries and exact continuation commands. Leave unrelated files intact.

## Decisions and progress

- Ruling: continue the existing checkout on a new `codex/macbook-study-chat` branch. The prior Endsem feature and unrelated user changes are uncommitted here; no destructive clean/reset/stash or separate checkout that loses them.
- Execution authorized by the user; no further plan approval round. Parent owns integration, with disjoint native and planning agents and independent review.
- Shared migration/contract is established before parallel tasks. Agents must not commit the mixed working tree.

## Final verification — 23 October 2026

All implementation tasks are complete in the local working tree. Final independent scoped review cleared the missed-start rebalance and corrected-attendance-identity findings. The regression sequence advances time through lunch, return, ADSA correction and an actual isolated Guardian start linked to the concrete planned block. An exact calendar export of superseded work cannot re-block later turns; moved exports remain protected. Tests use synthetic calendar/readiness evidence and earn no captured study credit.

Fresh parent checks on the final source:

- `LIFEOS_DISABLE_SCHEDULER=true npm test`: **350/350 passed**, zero failures (79 suites).
- `npx tsc --noEmit --pretty false` and scoped ESLint: passed.
- Isolated production `npm run build -- --webpack`: passed, including `/api/study-chat`.
- Native `StudyChatCoreTests`: **11 checks passed**. Native release compilation and actual AppKit diagnostics passed earlier, including **9 UI checks** against the local server.
- Final built production server with isolated SQLite: scoped device GET succeeds; lunch persists a return-time question without Guardian/earned credit; the identical retry preserves the revision.
- Earlier isolated browser acceptance verified word durations, extensions, return/subject/start, persistent cross-page drafts, offline unconfirmed saves and idempotent retry. No private calendar, production capture or installed-client activation is inferred from those fixtures.

Parent logs: `/tmp/lifeos-study-chat-completion-tests.log`, `/tmp/lifeos-study-chat-completion-build.log`, `/tmp/lifeos-study-chat-completion-types.log`, `/tmp/lifeos-study-chat-completion-lint.log`, `/tmp/lifeos-study-chat-completion-native.log`. Review/fix evidence is retained under `.superpowers/sdd/2026-10-22-macbook-study-chat/`.

Pending operational work: deploy the reviewed source through the existing backed-up Mac Mini deployment path, update the intended MacBook client with `bash scripts/install-native-copilot.sh --update`, then check live calendar freshness, a normal conversation and collector readiness. Local code has not changed either running installation. No unresolved product/architecture choice remains for this delivery; iPhone and OS-lock enforcement remain deferred. No commits or pushes were made; unrelated working changes remain intact. See `docs/MACBOOK_STUDY_CHAT.md` for continuation commands.
