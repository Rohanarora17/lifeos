# LifeOS Guardian: Final Execution Plan

## Summary
- Build LifeOS around a **session-scoped guardian runtime** that is silent and non-observant when inactive, becomes a hard guardian only during explicit study sessions, and improves only through **eval-gated artifact promotion**.
- Treat the current guardian layer as the merge center. The canonical runtime lives around `guardian-runtime` / `guardian-types`; older `agent-loop` and `session-state` become compatibility adapters until removed.
- Keep the system in four planes:
  - **Realtime plane**: extension, guardian runtime, live dashboard, override flow, voice transport
  - **Memory plane**: working, episodic, semantic, procedural memory plus knowledge graph reads
  - **Reasoning plane**: intent parsing, override adjudication, reflection, day briefing, tutor submode
  - **Optimizer plane**: constrained autoresearch loop over versioned policy artifacts only
- Incorporate the existing LiveKit work as an **optional voice transport layer**, not as the source of truth. Guardian decisions remain runtime-owned.

## Architecture And Decisions
- **Source of truth**
  - `guardian-runtime` owns active session state, focus score, intervention cooldowns, block/unblock decisions, explainability, override state, event fanout, and policy application.
  - `agent-loop`, `session-state`, and legacy `/api/agent/*` routes become wrappers that delegate to guardian-runtime.
  - SSE and LiveKit are transport layers only; neither owns state.
- **Guardian authority**
  - Inactive: no tab processing, no mic processing, no guardian network chatter, no interventions.
  - Active: hard blocking allowed for distractions.
  - Every block must carry a reason, category, source event, and suggested alternative action.
  - Override requests are AI-assisted but must resolve to a scoped target plus TTL; no blanket disable.
- **Voice posture**
  - V1 input is **push-to-talk**.
  - Primary voice architecture: local-first audio pipeline with `whisper.cpp` + `Silero VAD` + `Kokoro`.
  - Existing LiveKit slice remains as an optional realtime room transport for browser voice sessions and future remote surfaces.
  - `say` remains bootstrap fallback only.
  - No always-listening wake word in v1.
- **Autonomy posture**
  - Self-improvement is restricted to **policy artifacts**:
    - intervention prompt pack
    - focus-score weights and thresholds
    - override rubric
    - retrieval/memory-selection prompt pack
    - session planning policy
    - voice phrasing policy
    - red-team defense rules
  - The optimizer may not edit route code, DB schema, extension permissions, auth logic, or runtime plumbing.
- **Memory model**
  - Working memory: current session state, active task, concept, recent interventions, override status.
  - Episodic memory: full session traces, interventions, overrides, outcomes, reflections.
  - Semantic memory: stable preferences, schedule patterns, recurring distractions, tone preferences.
  - Procedural memory: currently active promoted policy bundle and eval history.
- **Guardian reasoning model**
  - Deterministic first: event classification, focus score, cooldowns, and block eligibility should be rule/model-table driven.
  - LLM only for bounded tasks: intent extraction, ambiguous-case override reasoning, phrasing, reflection summaries, day briefings, tutor responses.
  - Tutor mode is explicit; the guardian does not lecture unprompted during flow.

## Public Interfaces And Data Contracts
- Standardize all guardian surfaces around these types:
  - `GuardianEvent`
  - `GuardianState`
  - `GuardianDecision`
  - `GuardianCommand`
  - `GuardianIntervention`
  - `OverrideRequest`
  - `OverrideDecision`
  - `GuardianPolicyBundle`
  - `GuardianArtifactVersion`
  - `GuardianEvalCase`
  - `GuardianEvalRun`
  - `GuardianCanaryResult`
- Consolidate API ownership to these routes:
  - `POST /api/guardian/session/start`
  - `POST /api/guardian/session/end`
  - `POST /api/guardian/events`
  - `GET /api/guardian/stream`
  - `POST /api/guardian/override`
  - `GET /api/guardian/day-briefing`
  - `POST /api/voice/push-to-talk`
  - `GET /api/voice/livekit/config`
  - `POST /api/voice/livekit/token`
  - `POST /api/guardian/optimize`
- Keep legacy routes temporarily, but make them thin delegates and mark them deprecated.
- Normalize event taxonomy:
  - session lifecycle
  - tab active / tab switch / dwell / idle
  - user intent / lock-in
  - intervention emitted
  - block applied / block lifted
  - override requested / override resolved
  - reflection submitted
  - voice transcript accepted
  - day-briefing requested
- Persist these entities explicitly:
  - guardian sessions
  - event log
  - interventions
  - overrides
  - semantic profile
  - policy artifact versions
  - eval cases
  - eval runs
  - promotions
  - canary results

## Implementation Plan
### Phase 1: Stabilize The Core Runtime
- Freeze guardian-runtime as the only write-owner of live guardian state.
- Refactor older guardian/session modules into adapters instead of peers.
- Remove decision logic from pages, extension clients, and route handlers; those surfaces only collect input or render runtime output.
- Make the runtime load exactly one active policy bundle from procedural memory.
- Add explicit explainability fields to every guardian decision and intervention.

### Phase 2: Unify The Realtime Contract
- Make extension, push-to-talk, LiveKit, and web UI all emit normalized `GuardianEvent`s.
- Make all command outputs from runtime use `GuardianCommand` and `GuardianDecision`.
- Fix extension contract drift:
  - unify message names between popup, sidebar, and background scripts
  - remove duplicate focus/guardian command vocabulary
  - ensure extension only sends events during active sessions
- Fix extension/server auth and CORS so authorized extension requests work consistently.
- Keep the extension dumb:
  - no focus scoring in extension
  - no autonomous policy in extension
  - no passive monitoring when inactive

### Phase 3: Finish The Voice Plane
- Keep the current LiveKit work but reposition it as optional browser transport.
- Add a local voice service boundary that turns audio into normalized guardian events and guardian speech requests into playback.
- Implement turn-taking rules:
  - push-to-talk capture start/stop
  - acknowledgement emission
  - interruption rules for urgent guardian speech
  - no overlapping playback
- Route transcripts through intent parsing into session start, override, tutoring, or reflection workflows.
- Keep TTS behind an adapter so Kokoro, `say`, or future voice engines can be swapped without changing runtime logic.

### Phase 4: Build The Longitudinal Intelligence Layer
- Add per-session reflection generation and storage.
- Add daily briefing generation using episodic + semantic memory + current goals.
- Build stable preference and behavioral-pattern extraction from repeated sessions.
- Keep knowledge graph access typed and read-model based; do not expose raw SQL to the live agent.
- Narrow the chat surface so the live guardian and tutor call only typed tools.

### Phase 5: Harden Policies And Blocking
- Define distraction classification categories and allowed actions for each.
- Add cooldowns and anti-spam rules for interventions.
- Make focus-score inputs explicit and tunable through the policy bundle.
- Define override adjudication rubric:
  - requested target
  - reason
  - requested duration
  - session context
  - decision
  - rationale
  - expiry behavior
- Ensure approved overrides re-block automatically when TTL expires.

### Phase 6: Build The Optimizer Plane
- Use a Karpathy-style bounded loop with:
  - one mutable surface: guardian policy bundle
  - one primary metric: `guardian_eval_score`
  - one fixed eval budget per run
  - automatic keep-or-revert
  - full run history
- Build eval suites from three sources:
  - scripted held-out study scenarios
  - replayed real session traces
  - adversarial override and loophole scenarios
- Score composition should include:
  - intent accuracy
  - distraction interception quality
  - false-positive block penalty
  - over-intervention penalty
  - override judgment quality
  - trust/tone score
  - session-outcome proxy
- Add hard failure gates:
  - privacy violation
  - intervention while inactive
  - broken override expiry
  - regression on critical scenarios
  - unsafe block behavior
- Promotion rules:
  - baseline first
  - one candidate artifact mutation per experiment
  - promote only on improved score with zero hard failures
  - tie-break toward simpler artifact bundles
  - canary the promoted bundle before full activation
  - instant rollback on canary failure

### Phase 7: Product Surfaces
- Web app:
  - primary cockpit for state, logs, session launch, override review, day briefing, reflections, and policy visibility
- Extension:
  - browser sensor/actuator only
  - hard block surface with explainability and scoped override request
- Mac helper / daemon:
  - local voice runtime
  - session heartbeat
  - local-first orchestration boundary
- Phone/PWA:
  - notifications
  - view live guardian status
  - submit override or reflection
  - no phone-side tracking in v1

### Phase 8: Cleanup And De-risking
- Deprecate and later remove raw-SQL model tooling from the chat route.
- Stop relying on startup side effects for live guardian ownership.
- Separate prototype-era dashboard logic from guardian runtime responsibilities.
- Replace the LaunchAgent dev-oriented runtime with a hardened local service model once guardian-runtime is stable.
- Make lint and typecheck meaningful quality gates for touched guardian surfaces.

## Test Plan
- **Privacy / inactive mode**
  - no extension event emission while inactive
  - no mic path while inactive
  - no guardian interventions while inactive
  - no optimizer activity on live-session hot path
- **Session lifecycle**
  - lock-in starts correct session
  - end session flushes state and trace
  - reconnecting stream restores current guardian state
- **Realtime guardian**
  - productive events raise score correctly
  - distraction events lower score correctly
  - hard block fires only under active session policy
  - every block is explainable
  - cooldown prevents repeated nagging
- **Override flow**
  - valid override yields scoped target + TTL
  - denied override returns rationale
  - approved override auto-expires and re-blocks
  - no override can disable entire guardian globally
- **Voice flow**
  - push-to-talk transcript reaches guardian runtime
  - intent mapping works for “start session”, “override”, “reflect”, and “tutor”
  - urgent guardian speech may interrupt queued speech
  - speech queue never overlaps itself
- **Memory / learning**
  - session traces persist
  - semantic profile updates only from approved extraction logic
  - daily briefing reflects recent episodes without leaking raw irrelevant trace detail
- **Optimizer safety**
  - candidate edits only policy artifacts
  - fixed eval suite is reused within a run
  - failed candidates revert cleanly
  - canary failure rolls back active bundle
- **Regression scenarios**
  - tired-day lock-in
  - justified short override
  - manipulative loophole request
  - productive scatter mistaken for distraction
  - long silent deep-work stretch
  - browser idle with active session
  - disconnected extension during active session

## Acceptance Criteria
- Guardian runtime is the only live decision-maker.
- Inactive mode is observably silent.
- Active sessions can hard block distractions with explanations and scoped overrides.
- Voice, extension, and web UI all speak the same guardian contract.
- The live guardian no longer depends on raw SQL tools.
- Policy behavior is externally versioned and can be promoted or rolled back without code changes.
- An offline optimizer can run end-to-end against held-out cases and safely promote only better bundles.

## Assumptions And Defaults
- Local-first privacy is mandatory for raw audio, transcripts, and behavioral traces by default.
- Single-user, macOS, Chrome/Brave, and Mac Mini are the v1 target environment.
- Push-to-talk is the only supported voice mode in v1.
- LiveKit is retained as optional transport, not required for all deployments.
- Guardian authority is hard during active sessions but always has a scoped override path.
- Tutor behavior is explicit, not ambient.
- Bounded autonomy is the only allowed self-improvement mode.
- Existing in-flight guardian files are treated as the merge center; implementation should extend them instead of restarting from the older route split.
