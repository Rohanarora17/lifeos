# Native Vision Benchmark

Run on 2026-07-27 against the production Guardian API using the installed
MacBook `LifeOSCopilot.app` ScreenCaptureKit path.

## Method

- 60 labelled, balanced browser fixtures: 12 each for `active_creation`,
  `active_learning`, `passive_consumption`, `idle`, and `distraction`
- 12 exact static repeats after creation fixtures
- Real headful Chrome windows captured through the native frontmost-window
  provider
- Production authentication, session lifecycle, upload, inference, validation,
  and persistence paths
- Temporary JPEGs deleted immediately after each request
- Aggregate JSON retained locally with mode `0600`; no raw frames retained

This is a controlled synthetic corpus. It validates transport, classification,
alignment, change detection, and static-screen behavior under repeatable
conditions. It does not establish accuracy across arbitrary real applications,
window layouts, languages, or personal workflows.

## Initial Run

| Measure | Result | Gate |
| --- | ---: | --- |
| Labelled captures | 60 | At least 60 |
| Macro-F1 | 0.7244 | At least 0.85 |
| Alignment MAE | 16.28 | At most 10 |
| Capture failures | 0 | 0 |
| Title mismatches | 0 | 0 |
| Invalid assessments | 0 | 0 |
| Static creation false positives | 1 | 0 |

The run failed three gates. Every analyzed category prediction was correct, but
24 changed fixtures were skipped as `no_change`. The decoded pixel hash was not
sufficiently sensitive to same-template content changes. The idle fixture also
displayed goal-related content while expecting a low alignment score.

## Repairs

- Expanded perceptual hashing to a 64 by 64 luminance sample.
- Combined pixel differences with frontmost app and window-title state.
- Forced analysis when app or title metadata changes.
- Suppressed minor same-window jitter within two seconds as
  `rapid_duplicate`.
- Replaced the contradictory idle fixture with neutral content and a five-point
  expected alignment.

## Repaired Run

| Measure | Result | Gate |
| --- | ---: | --- |
| Labelled captures | 60 | Pass |
| Static repeats | 12 | Pass |
| Macro-F1 | 1.0000 | Pass |
| Alignment MAE | 6.35 | Pass |
| Per-class precision/recall | 1.0000 | Pass |
| Capture failures | 0 | Pass |
| Title mismatches | 0 | Pass |
| Invalid assessments | 0 | Pass |
| Static creation false positives | 0 | Pass |
| Raw frames retained | 0 | Pass |

The bounded production log check reported zero fallback events for the run.
The configured target was `gemini-3.1-pro-preview`; the persisted assessment
schema does not yet record the model that produced each individual result, so
the benchmark cannot prove per-assessment model provenance. Preview-model
results remain canary evidence rather than a supported-production claim.

## Production Hygiene

The benchmark initially used production session storage. The session context's
"exclude from personalization" text was not an enforced database policy.
Seventeen exact audit sessions and all rows linked by their session IDs were
therefore removed after aggregate evidence was retained:

- 121 screen observations
- 26 telemetry events
- 309 session ticks
- Generated summaries, reflections, classifications, energy readings, one
  synthetic habit check-in, and explanation rows

The cleanup ran in one transaction. SQLite checkpoint, vacuum, and
`PRAGMA integrity_check` completed successfully. Follow-up queries found zero
matching audit sessions and zero orphaned screen or telemetry rows.

## Remaining Validation

- Label diverse real applications: editor, terminal, PDF reader, video,
  research tabs, messaging denial, lock, sleep/wake, and multi-display use.
- Persist actual model/version provenance with every assessment.
- Move future synthetic runs to a disposable audit database or enforce an
  explicit non-learning session attribute in storage and downstream queries.
- Make deployment atomic. Updating `.next` while the old server was running
  caused a transient `ChunkLoadError` during this run.

## Diverse Real-Application Matrix

A second matrix ran on 2026-07-27 against a never-before-used disposable
database. Before capture, the native provider required the expected app and
window title to match. A mismatch returned a skip result before ScreenCaptureKit
acquired pixels.

The final balanced corpus contained 40 labelled captures, eight for each
category, across Cursor, Preview, QuickTime Player, Microsoft Edge, Google
Chrome, and Brave Browser. It covered code and notes creation, interactive
research, read-only papers, productive tutorial videos, paused/idle screens,
and unrelated entertainment.

| Measure | Result | Gate |
| --- | ---: | --- |
| Labelled captures | 40 | Pass |
| Macro-F1 | 1.0000 | Pass |
| Alignment MAE | 4.25 | Pass |
| Per-class precision/recall | 1.0000 | Pass |
| Capture failures | 0 | Pass |
| App/title mismatches | 0 | Pass |
| Invalid assessments | 0 | Pass |
| Communication-app denials | 4 of 4 | Pass |
| Sensitive frames produced | 0 | Pass |
| Raw frames retained | 0 | Pass |

Intermediate runs were retained as aggregate local evidence only. They exposed
non-deterministic TextEdit, Terminal, Preview, and QuickTime window activation.
The final matrix excludes TextEdit and Terminal from quantitative claims,
launches each video in a fresh audit-owned QuickTime process, narrows Preview to
one reader case, and uses isolated browser processes for the remaining labels.
Terminal, lock/sleep transitions, and multi-display behavior remain unverified.
The test Mac had one built-in display during collection.

The installed `LifeOSCopilot.app` was updated with the pre-capture expectation
guard. A deliberate wrong-app probe returned `unexpected_frontmost_app`, wrote
no image, and left the LaunchAgent running.

The disposable run also exposed an intelligence-boundary defect. Rapidly ended
audit sessions caused later session decisions to describe a severe history of
one-minute aborts, despite the database starting with zero Guardian sessions.
Future audit sessions need an enforced non-learning provenance flag that all
personalization and memory consumers honor.
