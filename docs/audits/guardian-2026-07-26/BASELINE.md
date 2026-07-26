# Guardian Audit Baseline

Captured: 2026-07-26, Asia/Kolkata

Repository baseline: `6ce8cf22253dd0c325634be764c7d9ccec109781`

Deployment URL: `http://100.99.194.80:3000`

This document separates observations made against the repository, the deployed
Mac Mini API, and the local MacBook. It does not infer one baseline from another.
Sensitive response bodies, tokens, environment values, and journal content are
intentionally excluded.

## Evidence Rules

- **Pass**: the expected result was observed and has a reproducible trace.
- **Partial**: part of the capability worked, but an important boundary failed.
- **Fail**: the observed result contradicted the expected result.
- **Unverified**: required access, elapsed time, hardware, or labelled data was
  unavailable.

No capability is considered working from source inspection alone.

## Baseline Findings

| Area | Status | Evidence | Immediate risk |
| --- | --- | --- | --- |
| API authentication | Fail | Personalization and Guardian endpoints returned data without credentials. Destructive admin routes use only request-body confirmation strings. | P0 |
| CORS | Fail | `src/proxy.ts` returns `Access-Control-Allow-Origin: *` for every API. | P0 |
| Production diagnostics | Partial | `/api/health` exposes process, database, scheduler, and log details, but does not authenticate or prove deployed commit/model readiness. | P0 |
| Mac Mini storage | Fail | Health response reported `daemon-error.log` at approximately 17.5 GB and OS memory at 98.08% used. | P0 |
| Realtime voice | Fail | `/api/voice/livekit/config` reported `enabled=false` and `realtimeConversationReady=false`. | P1 |
| Push-to-talk | Partial | Local Whisper was configured, but lifecycle and real-device accuracy thresholds were not exercised. | P1 |
| MacBook capture | Fail | `com.lifeos.client.plist.disabled` exists, service was not loaded, and deployed vision status reported no connected MacBook client. | P1 |
| Guardian freshness | Fail | Latest sampled observations were dated 2026-04-22 while the dashboard made present-tense claims on 2026-07-26. | P1 |
| Browser dwell accounting | Fail | Window blur is ignored, idle is emitted as one fixed 60-second event, and in-memory state is lost on MV3 worker restart. | P1 |
| Tab grouping | Fail | Updated and newly-created tabs can be moved into the Guardian group without checking existing groups or relevance confidence. | P1 |
| Screenshot pipeline | Fail | Extension screenshots and native vision use separate assessment paths; only one updates live Guardian state. | P1 |
| Screen privacy | Partial | Temporary frames are deleted in some paths, but full-display capture, clipboard simulation, and weak sensitive-window exclusion remain. | P0 |
| Intelligence claims | Fail | Stale relative dates, invalid profile enum values, learned-looking defaults, and unsupported identity claims were returned. | P1 |
| Mood and energy provenance | Partial | Explicit check-in provenance exists in current local changes, but correction propagation across all consumers is unverified. | P1 |
| Calendar sync | Partial | Local calendar data is consumed, but a complete authenticated two-way real-device sync trace was not captured in this audit. | P1 |
| Deployment workflow | Fail | Deployment pulls in place and restarts selected services without a test gate, atomic release, or voice-service verification. | P1 |

## Baseline Counts

- Application pages: 17
- API routes: 74
- Library modules: 90
- Unit test files at baseline: 11
- Existing end-to-end test files at baseline: 1
- Stored session summaries reported by production health: 21
- Stored memory facts reported by production health: 86
- Stored screen observations reported by Guardian status: 4,943
- Screen observations reported in the last hour: 0

Counts are point-in-time observations, not durable product metrics.

## Environment Boundaries

### Mac Mini

Read-only HTTP evidence was collected. Temporary SSH could not be established:
the host rejected available authentication methods. Launchd configuration,
database backup integrity, environment flags, installed model inventory, and
server-side permission state therefore remain unverified.

### MacBook

- macOS 15.1, Apple Silicon
- Google Chrome 150.0.7871.184
- LifeOS Tracker extension visible in Chrome
- Native client configuration points to the deployed Mac Mini URL
- Native launch agent is disabled

Screen Recording, Microphone, Accessibility, and Input Monitoring permission
states were not changed during baseline collection.

## Acceptance Gates Not Yet Run

- 60 labelled frontmost-window captures
- Screen category macro-F1 at least 0.85
- Task-alignment mean absolute error at most 10 points
- Zero sensitive captures
- PTT word error rate at most 15% in quiet conditions
- Realtime first-audio p95 at most 1.5 seconds
- Realtime interruption stop at most 300 ms
- Realtime reconnection within 5 seconds
- Full 17-page and 74-route authenticated workflow matrix
- Selected 14-day longitudinal study

These remain **unverified**, not failed, until the corresponding harness and
real-device evidence exist.
