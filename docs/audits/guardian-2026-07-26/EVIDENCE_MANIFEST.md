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

## Reproduction Constraints

The baseline checks were read-only apart from the recorded backup, disposable
audit copy, and historical log truncation. On 2026-07-27, explicitly approved
real-device Guardian sessions exercised screenshot capture and device ingestion
against production. A private communication window was captured before the
missing exclusion was discovered; the session was stopped immediately, derived
database rows and matching logs were redacted, and no raw frame was persisted by
LifeOS. Subsequent privacy tests retained only sanitized skip records and sent
zero image uploads.

The post-repair evidence run must use a disposable audit database and generated
fixtures before any explicitly approved real session.
