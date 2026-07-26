# Redacted Evidence Manifest

The audit evidence bundle records metadata and redacted summaries only. It must
never contain API tokens, OAuth credentials, raw screenshots, raw audio, journal
text, clipboard text, calendar descriptions, or full personalization payloads.

| ID | Baseline | Source | Collected | Redaction |
| --- | --- | --- | --- | --- |
| PROD-HEALTH-001 | Mac Mini deployment | `GET /api/health` | 2026-07-26 | Response summarized; paths and user data omitted |
| PROD-VOICE-001 | Mac Mini deployment | `GET /api/voice/livekit/config` | 2026-07-26 | Provider configuration values summarized |
| PROD-VISION-001 | Mac Mini deployment | `GET /api/guardian/vision` | 2026-07-26 | Connection and active-state flags only |
| PROD-GUARDIAN-001 | Mac Mini deployment | `GET /api/guardian/status` | 2026-07-26 | Counts, timestamps, and source labels only |
| PROD-INTEL-001 | Mac Mini deployment | `GET /api/guardian/insights` | 2026-07-26 | Unsupported claim examples retained; personal narrative removed |
| REPO-SEC-001 | Committed repository | `src/proxy.ts` | 2026-07-26 | No secrets present |
| REPO-EXT-001 | Committed repository | `extension/background.js` | 2026-07-26 | No browsing history retained |
| REPO-VISION-001 | Committed repository | Screenshot and native capture implementations | 2026-07-26 | No image frames retained |
| REPO-VOICE-001 | Committed repository | Extension and LiveKit voice implementations | 2026-07-26 | No audio retained |
| DEVICE-CLIENT-001 | MacBook | LaunchAgent and client log metadata | 2026-07-26 | URLs summarized; log bodies not bundled |
| DEVICE-CHROME-001 | MacBook | Chrome version and extension presence | 2026-07-26 | Tab titles and browsing history omitted |
| ACCESS-SSH-001 | Mac Mini | SSH connection attempt | 2026-07-26 | Host retained; credentials omitted |
| PROD-SSH-002 | Mac Mini | Commit, worktree, launchd, and capability flags | 2026-07-26 | Environment values excluded |
| PROD-DB-001 | Mac Mini | SQLite integrity, table counts, and online backup | 2026-07-26 | Row contents excluded |
| PROD-LOG-001 | Mac Mini | Daemon error tail and log rotation | 2026-07-26 | Tokens and URLs redacted; only a bounded tail retained |
| PROD-FRESH-001 | Mac Mini | Maximum source timestamps | 2026-07-26 | Content and titles excluded |
| DEVICE-VISION-002 | MacBook | Native LaunchAgent, heartbeat, and Screen Recording state | 2026-07-27 | Credential values, titles, and frames excluded |
| DEVICE-PRIVACY-001 | MacBook and Mac Mini | Sensitive-window real-device regression | 2026-07-27 | Rule label and aggregate counts only; no frame or personal title retained |
| PROD-PRIVACY-001 | Mac Mini | Server-side sensitive-app rejection probe | 2026-07-27 | Synthetic app and title only |
| PROD-REDACT-001 | Mac Mini | Incident-row and log redaction verification | 2026-07-27 | Counts and integrity result only |
| REPO-VISION-002 | Committed repository | Decoded-pixel hash and strict assessment tests | 2026-07-27 | Generated pixel fixtures only |
| DEVICE-VISION-003 | MacBook and Mac Mini | Bundled TextEdit capture and inference smoke test | 2026-07-27 | Synthetic document, aggregate score, and app label only; frame excluded |
| DEVICE-TCC-001 | MacBook | Native bundle identity and Screen Recording authorization | 2026-07-27 | Bundle identifier and signing class only |
| PROD-FRESH-002 | Mac Mini | Post-session authenticated diagnostics | 2026-07-27 | Freshness states and capability flags only |
| DEVICE-VISION-004 | MacBook and Mac Mini | Initial 60-frame controlled native benchmark | 2026-07-27 | Aggregate metrics and synthetic labels only; no frames retained |
| DEVICE-VISION-005 | MacBook and Mac Mini | Repaired 60-frame plus 12-repeat benchmark | 2026-07-27 | Aggregate metrics and synthetic labels only; no frames retained |
| PROD-CLEANUP-001 | Mac Mini | Exact audit-session cleanup and SQLite verification | 2026-07-27 | Aggregate deleted-row counts and integrity result only |
| DEVICE-VISION-006 | MacBook | 40-case diverse real-application matrix on disposable database | 2026-07-27 | Aggregate labels, scores, app names, and synthetic titles only; no frames retained |
| DEVICE-PRIVACY-002 | MacBook | Installed native expected-window and communication-app denial probes | 2026-07-27 | Rule names and aggregate results only; no frames retained |
| AUDIT-INTEL-001 | Disposable database | Audit-session personalization contamination trace | 2026-07-27 | Unsupported narrative summarized; generated text and session contents excluded |
| DEVICE-VOICE-002 | MacBook and Mac Mini | Native silence and fixed-phrase push-to-talk checks | 2026-07-27 | Signal level, normalized accuracy, and latency only; raw audio deleted |
| VERTEX-VOICE-001 | MacBook and Vertex AI | Direct Gemini Live model and latency canary | 2026-07-27 | Model IDs, status, and latency only; response audio discarded |
| DEVICE-BROWSER-001 | MacBook Chrome and Mac Mini | Real late-night active, unfocused, redacted, and bounded telemetry intervals | 2026-07-27 | URLs and titles omitted; states, privacy reasons, durations, and duplicate count only |
| TEST-GUARDIAN-001 | Disposable database | Guardian start, browser event, persistence, state, and completion lifecycle | 2026-07-27 | Synthetic topic and aggregate result only |
| TEST-PLANNER-001 | Disposable databases | Six task-time and next-day planner verification flows | 2026-07-27 | Synthetic task data and aggregate pass results only |
| PROD-ROUTES-001 | Mac Mini deployment | Ten authenticated critical API read probes | 2026-07-27 | Status and latency only; response bodies excluded |
| DEVICE-PAGES-001 | Isolated Chromium | Dashboard, activity, tasks, planner, calendar, and Guardian render checks | 2026-07-27 | Route, title, body size, and error counts only |
| TEST-MEMORY-001 | Disposable database | Duplicate consolidation and stale-reference purge regression | 2026-07-27 | Synthetic fact IDs and pass result only |
| TEST-GATE-001 | Committed repository | Full unit, static audit, and extension syntax gate | 2026-07-27 | 107-test and 10-check aggregate result only |

## Reproduction Constraints

The baseline checks were read-only apart from the recorded backup, disposable
audit copy, and historical log truncation. On 2026-07-27, explicitly approved
real-device Guardian sessions exercised screenshot capture and device ingestion
against production. A private communication window was captured before the
missing exclusion was discovered; the session was stopped immediately, derived
database rows and matching logs were redacted, and no raw frame was persisted by
LifeOS. Subsequent privacy tests retained only sanitized skip records and sent
zero image uploads.

The controlled 60-frame run used production ingestion before it was confirmed
that the session's non-learning context was descriptive rather than enforced.
After retaining aggregate evidence, all 17 exact audit sessions and their linked
rows were removed transactionally. Integrity checks passed and no orphaned
screen or telemetry rows remained. Future generated-fixture runs must use a
disposable audit database or a storage-level non-learning attribute before any
explicitly approved real session.
