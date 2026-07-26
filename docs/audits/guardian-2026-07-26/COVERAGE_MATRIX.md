# Guardian Audit Coverage Matrix

This matrix is the executable inventory for the post-repair audit. A row moves
to **Pass** only when it has an automated trace or a retained redacted
real-device result.

## Product Surfaces

| Surface | Primary workflows | Automation | Real device |
| --- | --- | --- | --- |
| Dashboard | Fresh state, provenance, corrections, recommendations | Pending | Pending |
| Activity | Interval totals, idle/lock boundaries, source breakdown | Pending | Pending |
| Analytics | Deterministic metrics, claim freshness | Pending | Pending |
| Calendar | Read sync, write sync, edit/delete reconciliation | Pending | Pending |
| Chat | Evidence-aware answers, feedback persistence | Pending | Pending |
| Extension sidebar | Timed task progress, session linkage | Pending | Pending |
| Goals | Timed task roll-up and completion | Pending | Pending |
| Guardian | Session lifecycle, screen context, override, reconnect | Pending | Pending |
| Habits | CRUD, day boundaries | Pending | Pending |
| Insights | Claim evidence, confidence, expiry, correction | Pending | Pending |
| Knowledge graph | Provenance and deletion | Pending | Pending |
| Memory | CRUD, source trace, sensitive-data handling | Pending | Pending |
| Next-day planner | Calendar constraints, sleep adjustment, edits | Pending | Pending |
| Settings | Authentication, protected mutation, capability state | Pending | Pending |
| Store | Reward pricing and balances | Pending | Pending |
| Study plan | Task-specific session rules | Pending | Pending |
| Tasks | Time-target completion and linked focus sessions | Pending | Pending |

## API Classes

| Class | Routes | Required checks |
| --- | ---: | --- |
| Personal data reads | 31 | Authentication, ownership, cache policy, redaction |
| Mutations | 28 | Authentication, CSRF, validation, idempotency |
| Device ingestion | 3 | Device token, size limits, deduplication, rate limit |
| Voice/media | 5 | Authentication, media limits, lifecycle, retention |
| OAuth/calendar | 4 | State, callback binding, token storage, sync reconciliation |
| Admin/destructive | 3 | Authentication, re-authentication, audit record, disposable DB |

Route counts are classification targets and must be reconciled against the
current 74-route inventory by the route audit script.

## Real-Device Session Matrix

| Scenario | Expected evidence |
| --- | --- |
| Browser research | Focused Chrome interval, relevant tabs only, no grouped user tabs |
| Coding | Frontmost editor interval and aligned Guardian assessment |
| Paper reading | Reading classification without false creation signal |
| Productive video | Goal-aligned media classification |
| Distraction | Unaligned interval, confidence, intervention trace |
| App switch | Prior interval closes at switch timestamp |
| Chrome loses focus | No dwell continues against the last tab |
| Lock | Locked state closes active interval and prevents capture |
| Sleep/wake | One closed pre-sleep interval and a fresh post-wake interval |
| Chrome restart | Persisted state resumes without duplicate duration |
| Network outage | Local queue retries idempotently |
| Session completion | Focus intervals link to timed task and advance its target |

## Quantitative Gates

| Capability | Gate |
| --- | --- |
| Screen category | Macro-F1 at least 0.85 over at least 60 labelled captures |
| Task alignment | Mean absolute error at most 10 points |
| Screen privacy | Zero sensitive captures |
| Static screen handling | Zero static screens classified as active creation |
| PTT transcription | Word error rate at most 15% in quiet conditions |
| Realtime first audio | p95 at most 1.5 seconds |
| Realtime interruption | Playback stops within 300 ms |
| Realtime reconnect | Session usable within 5 seconds |
| Claim freshness | Zero expired claims driving decisions |
| Correction retention | 100% across all listed consumers |

## Longitudinal Study

The 14-day study begins only after contract, security, and real-device gates
pass. Daily fixtures record sleep, mood, calendar, planned work, completed
intervals, feedback, and correction events. Results measure calibration,
stale-claim rate, correction retention, cross-surface consistency,
notification usefulness, session recommendation fit, and observable
day-to-day decision changes.
