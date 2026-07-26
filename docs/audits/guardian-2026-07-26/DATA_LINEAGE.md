# LifeOS Decision Data Lineage

The target architecture separates observations, deterministic facts,
assessment claims, and decisions. A generative model may explain evidence, but
it must not silently promote an observation into a user fact.

```mermaid
flowchart LR
    subgraph Sources
        CAL["Calendar events"]
        TASK["Timed tasks"]
        JOURNAL["Journal and check-ins"]
        SLEEP["Sleep reports"]
        BROWSER["Browser intervals"]
        NATIVE["Frontmost-window intervals"]
        SCREEN["Guardian window captures"]
        VOICE["Voice turns"]
        FEEDBACK["Feedback and corrections"]
    end

    subgraph Contracts
        TELEMETRY["TelemetryEventV1"]
        OUTCOME["SessionOutcomeV1"]
        CLAIM["AssessmentClaimV1"]
    end

    subgraph Evidence
        RAW["Idempotent event store"]
        METRICS["Deterministic metrics"]
        UIL["Validated user intelligence layer"]
        SNAPSHOT["Personalization snapshot"]
    end

    subgraph Decisions
        PLANNER["Next-day planner"]
        GUARDIAN["Guardian policy"]
        ALERTS["Notifications"]
        CHAT["Chat and voice"]
        REWARDS["Rewards"]
        ANALYTICS["Analytics"]
    end

    CAL --> SNAPSHOT
    TASK --> SNAPSHOT
    JOURNAL --> CLAIM
    SLEEP --> CLAIM
    BROWSER --> TELEMETRY
    NATIVE --> TELEMETRY
    SCREEN --> CLAIM
    VOICE --> OUTCOME
    FEEDBACK --> CLAIM

    TELEMETRY --> RAW
    RAW --> METRICS
    OUTCOME --> METRICS
    CLAIM --> UIL
    METRICS --> UIL
    UIL --> SNAPSHOT

    SNAPSHOT --> PLANNER
    SNAPSHOT --> GUARDIAN
    SNAPSHOT --> ALERTS
    SNAPSHOT --> CHAT
    SNAPSHOT --> REWARDS
    SNAPSHOT --> ANALYTICS

    FEEDBACK --> SNAPSHOT
```

## Required Boundaries

1. Source payloads carry device, source, event ID, observed interval, privacy
   decision, and provenance.
2. Duplicate event IDs are accepted idempotently and never count twice.
3. Raw screenshots and audio are deleted immediately after inference.
4. Unknown, malformed, expired, or unsupported claims cannot affect decisions.
5. Deterministic metrics are authoritative; model prose is explanatory.
6. User corrections supersede model claims and propagate through the shared
   snapshot.
7. Every decision records the evidence references and snapshot version it used.

## Capture Policy

| Context | Browser/app metadata | Screenshot | Audio |
| --- | --- | --- | --- |
| Outside waking hours | Off | Off | User initiated only |
| Waking hours, no focus session | Low-detail intervals | Off | User initiated only |
| Active Guardian focus session | Goal-aware intervals | Frontmost window, privacy-filtered | User initiated or explicit realtime session |
| Locked or asleep | Locked state only | Off | Off |

Existing tab groups are user-owned. LifeOS may group a tab only when LifeOS
opened it or when session relevance is at least 0.85, and it must never move an
already-grouped tab automatically.
