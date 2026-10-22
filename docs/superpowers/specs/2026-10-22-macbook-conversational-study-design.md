# MacBook conversational study accountability

Status: approved and implemented in the local `codex/macbook-study-chat` working tree. Production server deployment and installation of the updated MacBook client remain pending. See `docs/MACBOOK_STUDY_CHAT.md` for operation and activation.

Builder review (22 October 2026): independent review found “nothing important left” to clarify before implementation planning. The user approved this text-chat delivery and its reminder defaults with “yes do it.” Final implementation review and verification are recorded in the accompanying plan.

## Intent and agreed requirements

Rohan wants ongoing back-and-forth conversation with LifeOS: explain what he is doing or where he is going, discuss the impact, and rebalance the remaining study accordingly. He avoids study by continuing ordinary routines and watching videos/reels. He is not primarily asking for resistance to deliberately uninstalling the client.

Focus on the existing MacBook client and LifeOS server. Defer iPhone development. The daily target remains eight hours through 13 November 2026 inclusive, Asia/Kolkata. Probability is on 10 November; ADSA is on 13 November. Attended Probability/ADSA classes count toward the target. Other classes remain protected commitments. Neither a calendar entry nor saying “I'm back” proves studied minutes.

Study must fit around classes, meals, necessary travel and the agreed sleep window. A meal, a class, and an unexplained absence require different responses. LifeOS must remember an expected return and notice an overdue return without mistaking an offline device for proof of avoidance.

## First delivery and scope

Deliver one working MacBook loop: conversation → stored agreement → adjusted remaining plan → native return prompt → follow-up conversation → measured restart.

The primary interaction is a **native text chat box on the MacBook**, following the existing on-screen presence-check panel pattern. Rohan explicitly prefers this to push-to-talk. The chat must work without an active Guardian session and without microphone access. Open it from the LifeOS menu, and bring it forward when a study-start or return conversation is due. Existing web chat can use the same study actions and history. General planning/check-in turns do not require a screenshot. Existing voice/screen-help features retain their current behavior and are not expanded by this delivery.

The panel has a scrollable conversation and an editable message composer. Follow-up questions and replies stay in the same conversation; submitting a message must not close the panel. Preserve draft text during heartbeat refreshes, retries and minimization. Present proactive prompts without stealing typing focus from another application; typing begins after Rohan explicitly activates the composer. A minimized panel remains reopenable from the menu, and minimization does not resolve an unanswered return agreement.

Only one proactive LifeOS prompt should demand attention at a time. Existing presence-check deadlines and verified/unscored accounting remain intact: prioritize a pending presence check, then show a queued return prompt after it resolves. Opening chat or writing an unrelated reply must not silently confirm presence or earn study minutes. Reuse the existing native panel conventions rather than replacing the collector or creating a second Mac app.

This delivery uses existing Guardian distraction protection during study sessions. System-wide application restrictions, OS login locking, administrator changes and phone enforcement are separate decisions, not implied by approving conversational planning. The earlier proposed two-hour restriction-release policy remains a possible later enforcement layer; this delivery must not claim it is enforced.

## Conversation behavior

- “I'm going for lunch.” If no return time or user-approved duration is known, ask when he expects to return. A proposed break remains pending until that essential detail is supplied; the pending question itself does not grant indefinite quiet time.
- “Back in forty minutes.” Resolve the pending lunch conversation using the current server time in IST. Save the activity, departure, expected return and plan revision. Explain the resulting next study block and any effect on remaining capacity.
- “I need another twenty minutes.” Extend the current break rather than creating a second break. Supersede its old reminder. Show the effect; if this makes the target infeasible or conflicts with a protected commitment, discuss the trade-off instead of silently squeezing other commitments.
- “I'm back.” Close the declared absence and propose the next concrete task. Starting or resuming Guardian follows an explicit user request such as “start” or a clear acceptance of that proposal; mere acknowledgement earns no time.
- “My class ran late.” Resolve the referenced class from the current conversation/calendar. Ask if ambiguous. Protect the revised interval and move only future blocks.
- “I attended Probability.” Identify the specific class and ask about attendance duration when unclear. Record confirmed attendance as self-reported class time, capped to the actual declared attendance interval and matched class occurrence. Do not credit unrelated classes or scheduled-but-unattended events.

Follow-ups such as “yes,” “another twenty,” and “make it ADSA instead” refer to the latest unresolved proposal. Conversation history alone is not a successful mutation: the assistant reports a changed plan only after the corresponding validated action succeeds. A correction updates the current agreement and retains its history.

## State and responsibilities

Persist a day activity with type (study, meal, class, break, other commitment), declared start, expected return/end, source, calendar occurrence where relevant, status, and revision. Distinguish a pending clarification, an agreed protected interval, return due, overdue/unconfirmed return, and resumed study. Persist conversation turns and pending proposals across app/server restarts. Keep planned, declared and measured facts separate.

AI interprets natural language, asks clarifying questions and explains options. Typed server actions validate times, calendar conflicts, credits and state transitions. The existing planner owns scheduled focus blocks. The existing ledger owns earned minutes. The Mac client presents the shared conversation and prompts; it does not maintain a competing daily goal or independently invent time credits.

Use a shared study-action boundary for native text chat and web chat. Resolve context against the latest activity/plan revision, reject stale mutations, and use request IDs so retries cannot extend a break or credit a class twice. Native access uses scoped device authorization, not an administrator API token.

## Rebalancing the day

Load fresh configured calendar data, explicit day commitments, meal/return agreements, sleep constraints, verified study, and confirmed attendance. Refresh/reconcile the existing app's ICS/OAuth calendar mirror before trusting a free window. The local mirror inspected on 22 October was empty even though connected Google Calendar exposed class occurrences; empty data is not evidence of a free day. Connected MCP calendar tools are reconnaissance, not a runtime dependency for LifeOS.

Preserve completed work and the actual active session. Declaring a meal pauses Guardian through its existing lifecycle. Resuming uses existing readiness checks. Move or split unstarted future study around protected intervals, including user-supplied travel buffers. Reuse current session-duration preferences and task/subject information. Preserve both subjects before Probability finishes; after that, prioritize ADSA. Do not invent a syllabus, mandatory subject-hour ratio, class attendance, travel duration or meal duration.

Replace fixed wall-clock accountability checkpoints with follow-through checks tied to the agreed study blocks and return commitments. Existing 12/16/20/22 reminders must not fire independently during protected commitments. Routine generic coaching should consume the same activity state so it cannot contradict an agreed meal/class pause.

Compute remaining target from non-overlapping measured study, self-reported paper work and confirmed class intervals. Show their sources separately. Count an interval once even if Guardian and attendance overlap. If available time cannot fit the remaining target plus breaks, present the shortfall and ask which future commitment/window should change. Do not silently lower eight hours, cancel class, extend sleep, or claim an infeasible schedule is achievable.

Rebalancing LifeOS's internal plan is authorized by an explicit conversational update. External calendar writes remain on the existing explicit calendar-sync path; no new third-party notifications or calendar writes are introduced implicitly by a casual check-in.

## Return follow-through and builder defaults

The approved implementation defaults are: show one native return prompt at the agreed deadline, allow a five-minute grace period, and repeat an unanswered overdue prompt no more often than every ten minutes during the agreed waking/study window. Preserve the original departure time so “you left two hours ago” remains accurate after an extension; say how far past the latest agreement he is, rather than pretending every absence is unexplained.

If another protected commitment immediately follows a break, carry the protection through that commitment and its declared travel interval. If the calendar is stale or availability is uncertain, say so and ask a concise question. If the client is asleep/offline, retain the pending return and show it on the next active heartbeat; do not count sleep as study or claim physical location. Offline check-ins must show “not yet saved” unless durable local queuing with idempotent reconciliation is actually implemented. Never claim a server-side replan succeeded while disconnected.

The Mac client obtains versioned pending prompts through its existing heartbeat/polling integration, acknowledges them to avoid duplicate windows, and uses the conversation for a response. The web banner can show the same pending return. Native client installation/update is an explicit operational step: a server change does not update the MacBook binary.

## Verification and remaining work

Required scenarios: lunch→clarification→agreed return; extension→superseded reminder; overdue→reply→restart; class immediately after lunch; class running late; fresh/stale/empty calendar; relevant attended class credit and overlapping Guardian evidence; app/server restart; duplicate and stale requests; no active Guardian session; missing capture permission (chat still works, measured study readiness remains required); disconnected check-in; infeasible remaining day; IST midnight and final campaign expiry. Verify chat without microphone permission, draft retention across polling, window minimization/reopening, keyboard focus, same-thread follow-ups, and a presence check competing with a return prompt. Exercise actual action/state persistence and a compiled native client, not only AI prose.

Implementation, isolated API/browser checks and compiled native diagnostics are complete; final verification results are recorded in the implementation plan. Pending operational work is deployment to the Mac Mini, installation of client 0.4.0 on the MacBook and acceptance with the live calendar and collector. No new enforcement has been enabled on the installed client. No fixed lunch/dinner times are required to begin: the conversation obtains each departure and return as the day unfolds.
