# Guardian Repair Status

Captured after local implementation; real-device results remain pending.

## Implemented and Locally Verified

- Central production API authentication with scoped browser/device credentials
- Origin allow-list, CSRF checks, OAuth state, and admin reauthentication
- Throttled login, media-size limits, and authenticated diagnostics
- `TelemetryEventV1`, strict validation, idempotent storage, and batch ingestion
- Chrome interval closure on tab/app focus, idle, lock, and service-worker gaps
- Persisted offline telemetry queue and Chrome 150 alarm persistence
- Existing tab-group preservation and explicit Guardian grouping
- Extension screenshot pipeline retirement
- ScreenCaptureKit frontmost-window capture with sensitive-window exclusion
- Clipboard simulation retirement and native device authentication
- PTT in-flight cleanup, response-text preservation, one playback owner, and TTS fallback
- `AssessmentClaimV1` freshness, sample, distinct-day, relative-date, and confirmation gates

## Still Unverified

- Mac Mini environment, launchd state, production database backup, and deployed commit over SSH
- Chrome extension reload and a real browser interval matrix
- Screen Recording, Microphone, Accessibility, and Input Monitoring permissions
- At least 60 labelled frontmost-window captures and quantitative vision gates
- Indian-English PTT word error rate and realtime latency/interruption/reconnect gates
- Live Vertex model discovery and Gemini Live canary promotion
- Full 18-page and current API-route Playwright workflow suite
- Two-way Google Calendar reconciliation against the real account
- Cross-surface correction propagation beyond the Guardian insights boundary
- The selected 14-day longitudinal study

## Remaining Findings

| Priority | Finding |
| --- | --- |
| P0 | Temporary SSH is unavailable, so the 17 GB historical daemon error log cannot yet be rotated or root-caused on the Mac Mini. |
| P0 | Production secrets and allowed origins must be configured before deploying the fail-closed auth boundary. |
| P1 | Existing legacy ingestion routes still need parity adapters into `TelemetryEventV1` before duplicate tables can be retired. |
| P1 | Vision inference still needs decoded-pixel perceptual hashing and strict model-output integration on every screenshot route. |
| P1 | Realtime Gemini Live remains disabled and has no real-device promotion evidence. |
| P1 | Claim/correction propagation must be extended from Guardian insights to planner, notifications, chat, rewards, and analytics. |
| P2 | The extension iframe sidebar needs an authenticated embedded-session design; its health request is authenticated, but iframe cookie behavior is browser-policy dependent. |
| P2 | Log rotation is deployment-triggered until a dedicated periodic launchd job is installed. |

## Honest Completion Estimate

These percentages describe evidence-backed readiness, not feature marketing.

| Area | Readiness |
| --- | ---: |
| Telemetry | 58% |
| Guardian runtime | 42% |
| Push-to-talk voice | 55% |
| Realtime voice | 15% |
| Vision | 45% |
| Intelligence | 38% |
| Personalization propagation | 40% |
| Security | 72% |
| Deployment and operations | 48% |
| General product workflows | 55% |

Weighted overall readiness: **47%**. The largest remaining portion is
real-device validation, cross-surface integration, legacy adapter retirement,
and the elapsed 14-day study.
