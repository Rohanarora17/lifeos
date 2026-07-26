# Guardian Repair Status

Updated after production deployment and the first MacBook real-device vision
session on 2026-07-27.

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
- Session-only native vision polling through an authenticated MacBook LaunchAgent
- Native `.app` packaging with a stable bundle identifier and explicit-update installation
- Pre-capture communication-app denial plus server-side sensitive-app rejection
- Decoded-pixel screenshot hashing and strict model-assessment validation
- Clipboard simulation retirement and native device authentication
- PTT in-flight cleanup, response-text preservation, one playback owner, and TTS fallback
- `AssessmentClaimV1` freshness, sample, distinct-day, relative-date, and confirmation gates

## Still Unverified

- Full browser interval matrix across lock, sleep, restart, and network loss
- Microphone, Accessibility, and Input Monitoring permissions
- User-controlled Terminal, lock/sleep, and multi-display capture scenarios
- Indian-English PTT word error rate and realtime latency/interruption/reconnect gates
- Live Vertex model discovery and Gemini Live canary promotion
- Full 18-page and current API-route Playwright workflow suite
- Two-way Google Calendar reconciliation against the real account
- Cross-surface correction propagation beyond the Guardian insights boundary
- The selected 14-day longitudinal study

## Remaining Findings

| Priority | Finding |
| --- | --- |
| P1 | Existing legacy ingestion routes still need parity adapters into `TelemetryEventV1` before duplicate tables can be retired. |
| P1 | Realtime Gemini Live remains disabled and has no real-device promotion evidence. |
| P1 | Claim/correction propagation must be extended from Guardian insights to planner, notifications, chat, rewards, and analytics. |
| P1 | Vision passed the controlled 60-frame benchmark, but still needs a diverse real-application matrix before population-level accuracy claims. |
| P1 | Synthetic Guardian sessions need an enforced non-learning storage attribute or disposable database routing; descriptive session context alone does not prevent personalization contamination. |
| P1 | A zero-row disposable run inferred a severe one-minute-abort history from rapidly ended audit sessions and used it in later decisions; audit provenance must be excluded from memory, UIL, policy, and session-intent consumers. |
| P2 | The native app is ad-hoc signed because no Apple code-signing identity is installed; explicit binary updates can require Screen Recording reauthorization. |
| P2 | The extension iframe sidebar needs an authenticated embedded-session design; its health request is authenticated, but iframe cookie behavior is browser-policy dependent. |
| P2 | Log rotation is deployment-triggered until a dedicated periodic launchd job is installed. |
| P2 | Deployment is not atomic: replacing `.next` while the prior process is live caused a transient `ChunkLoadError` during the benchmark. |
| P2 | Vision assessments do not persist the actual model/version used, so fallback-free logs cannot establish per-assessment model provenance. |

## Mac Mini Evidence Refresh

SSH evidence was collected on 2026-07-26 without reading secret values.

- Deployed commit: `6ce8cf22253dd0c325634be764c7d9ccec109781`
- Remote worktree: two staged launch wrapper scripts; no tracked-file diff
- Active services: `com.lifeos.server` and `com.lifeos.daemon`
- Production database: 4,694,016 bytes; `PRAGMA integrity_check` returned `ok`
- Verified backup: `backups/audit/lifeos-20260726-235750.db`
- Disposable audit copy: `backups/audit/lifeos-audit-20260726-235750.db`
- Historical daemon error log: 17,506,789,922 bytes, dominated by Telegram
  network timeouts; a redacted tail was retained and the live log was
  truncated to release disk space
- Latest screen observation: 2026-04-22 05:06:44
- Latest Guardian session: 2026-04-21 17:28:23
- Latest calendar sync: 2026-07-26 17:14:16
- Installed Chrome extension ID:
  `ojookmlbandlakahfppanbidiahfhojf`

### 2026-07-27 production refresh

- Deployed commit reached `a3ed7c557cdbceb1541c4e30387566e2eec1ca73`;
  later vision commits were pushed and await the same workflow verification.
- API, device, admin reauthentication, origin, and extension security variables
  are configured; unauthenticated and disallowed-origin probes fail closed.
- Browser telemetry is fresh and uses `telemetry_events_v1`.
- The MacBook `com.lifeos.copilot` LaunchAgent is running with an owner-only
  credential file and production reports its heartbeat as connected.
- Screen Recording is enabled for `LifeOSCopilot`.
- A controlled session proved screenshot upload, model inference, and database
  persistence. It also exposed a private communication-window capture.
- The session was stopped immediately. Three derived observation rows and
  matching server-log lines were redacted, SQLite was checkpointed/vacuumed,
  and `PRAGMA integrity_check` remained `ok`.
- The repaired real-device privacy regression produced two sanitized skip rows
  and zero screenshot uploads. A forged server-side WhatsApp capture was also
  rejected with `reason=sensitive_app`.
- The client now runs from `LifeOSCopilot.app` with bundle identifier
  `com.lifeos.copilot`. Ordinary installer reruns preserve the installed binary;
  replacement requires the explicit `--update` flag.
- A controlled TextEdit capture passed end to end: the native client uploaded
  the frontmost window, production persisted one `screen_vision` assessment,
  and unchanged follow-up frames did not create duplicate analyzed observations.
  The synthetic fixture was assessed as active creation with alignment 100 and
  confidence 0.95. This validates flow, not population-level accuracy.
- Final diagnostics on commit `6f0bb6141dbf1e619c3e087ecc8960df2f54ff56`
  reported fresh browser and screen telemetry, configured security, a ready
  database, and an idle Guardian after clean session completion.
- The first controlled 60-frame benchmark failed category, alignment, and
  static-screen gates. It exposed insufficient same-template change detection
  and a contradictory idle fixture.
- After combining decoded pixels with app/window state and correcting the idle
  fixture, the repeated 60-frame plus 12-static-repeat run passed all gates:
  macro-F1 1.00, alignment MAE 6.35, zero capture/title/schema failures, and
  zero static creation false positives.
- No raw frames were retained. Seventeen exact synthetic audit sessions and all
  linked production rows were removed transactionally after aggregate evidence
  was retained. SQLite integrity remained `ok`, with zero matching sessions or
  orphaned screen/telemetry rows.
- The final benchmark code was deployed at
  `f78e971955b5d200ec539003c11863212ce2a036`.
- A 40-case matrix across six real applications passed with macro-F1 1.00,
  alignment MAE 4.25, zero capture/title/schema failures, and four of four
  communication apps denied before pixels were acquired.
- The native app now enforces expected app/window metadata inside the
  ScreenCaptureKit provider. The installed bundle passed a deliberate mismatch
  probe with no frame created and its LaunchAgent remained running.
- Terminal, lock/sleep, and multi-display behavior remain unverified. The test
  Mac had one built-in display.

## Honest Completion Estimate

These percentages describe evidence-backed readiness, not feature marketing.

| Area | Readiness |
| --- | ---: |
| Telemetry | 64% |
| Guardian runtime | 48% |
| Push-to-talk voice | 65% |
| Realtime voice | 25% |
| Vision | 88% |
| Intelligence | 38% |
| Personalization propagation | 40% |
| Security | 88% |
| Deployment and operations | 85% |
| General product workflows | 55% |

Weighted overall readiness: **62%**. The largest remaining portion is
real-device validation, cross-surface integration, legacy adapter retirement,
and the elapsed 14-day study.
