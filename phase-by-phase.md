# LifeOS Guardian: Phase-By-Phase Execution Plan

## Summary
- Execute the guardian rebuild in **8 phases**, but only implement **one phase at a time**.
- A phase is allowed to start only if:
  - inputs are clear
  - touched surfaces are bounded
  - acceptance tests are defined
  - estimated confidence is at least `95%`
- If a phase drops below `95%` confidence because of product ambiguity, integration risk, or conflicting repo state, stop and resolve it before coding.
- The next implementation target should be **Phase 1: Stabilize The Core Runtime**. It has the highest leverage and the lowest ambiguity.

## Execution Rules
- **One phase at a time**
  - do not start the next phase until the current phase passes its acceptance criteria
  - do not mix voice transport, optimizer logic, and runtime refactors in the same change set
- **Confidence gate**
  - `95%+`: implement
  - `80-94%`: clarify or reduce scope
  - `<80%`: do not implement
- **Change discipline**
  - prefer adapters over big-bang replacement
  - keep legacy routes alive until replacements are verified
  - avoid parallel edits on already-hot guardian files unless ownership is explicit
- **Verification gate per phase**
  - typecheck on touched surfaces
  - build passes or touched-surface equivalent
  - targeted behavior tests pass
  - manual scenario checklist passes
- **Rollback rule**
  - every phase must be mergeable or reversible without DB rescue work

## Phase Breakdown

### Phase 1: Stabilize The Core Runtime
**Goal**
- Make `guardian-runtime` the single live decision-maker and reduce older guardian/session code to compatibility wrappers.

**Subtasks**
1. Inventory runtime ownership
   - map all current sources of guardian/session truth
   - identify every place making focus, session, block, override, or intervention decisions
2. Freeze canonical contracts
   - finalize `GuardianEvent`, `GuardianState`, `GuardianDecision`, `GuardianCommand`, `OverrideRequest`, `OverrideDecision`
   - identify missing fields for explainability and TTL handling
3. Centralize runtime writes
   - route all session state mutations through `guardian-runtime`
   - move any direct state mutations in routes/components/helpers behind runtime APIs
4. Convert legacy modules into adapters
   - make `agent-loop` delegate instead of own logic
   - make `session-state` delegate instead of own logic
   - keep public behavior compatible
5. Add decision explainability
   - every intervention/block/override result must include reason metadata
6. Load one active policy bundle
   - runtime reads one active procedural bundle
   - no scattered threshold constants in live decision path
7. Document live ownership boundaries
   - runtime owns state
   - routes accept input / return output
   - UI renders only
   - extension emits events only

**Acceptance Criteria**
- exactly one runtime owns live guardian state
- legacy paths delegate to runtime
- every live decision has explainability fields
- no page/component directly owns guardian decision logic
- active policy bundle is read from one runtime-owned source

**Confidence**
- `95%+`
- This is the correct first implementation phase.

---

### Phase 2: Unify The Realtime Contract
**Goal**
- Make web, extension, and legacy APIs all speak one guardian event/decision language.

**Subtasks**
1. Normalize inbound events
   - session start/end
   - tab active/switch
   - dwell
   - idle
   - voice transcript accepted
   - override requested
   - reflection submitted
2. Normalize outbound commands
   - block
   - unblock
   - classify
   - session state
   - intervention message
3. Reconcile extension command drift
   - unify `FOCUS` vs `GUARDIAN` command naming
   - remove duplicate command vocabularies
4. Fix extension auth/CORS path
   - verify authorized extension requests work on every active route
5. Convert legacy `/api/agent/*` surfaces into delegates
   - no duplicated business logic
6. Make SSE transport-only
   - stream runtime state, do not derive state from stream layer
7. Add event validation boundary
   - reject malformed or out-of-session events

**Acceptance Criteria**
- extension, web, and API use the same event/command contracts
- extension emits nothing when inactive
- no duplicate decision logic between agent and guardian route families
- SSE only reflects runtime state

**Confidence**
- `90-95%`
- Start only after Phase 1 is complete because this phase depends on canonical contracts.

---

### Phase 3: Finish The Voice Plane
**Goal**
- Support reliable push-to-talk voice without making transport the source of truth.

**Subtasks**
1. Define voice service boundary
   - transcript in
   - speech request out
   - guardian event mapping
2. Keep LiveKit optional
   - treat current LiveKit work as browser transport
   - do not couple runtime to LiveKit room semantics
3. Implement local input path
   - push-to-talk capture lifecycle
   - transcript handoff into guardian event flow
4. Implement output path
   - TTS adapter interface
   - Kokoro primary
   - `say` fallback
5. Add turn-taking policy
   - acknowledgement timing
   - interruption rules
   - queue policy
6. Map voice intents
   - start session
   - ask guardian status
   - request override
   - tutor mode
   - reflection
7. Keep inactive-mode privacy hard
   - no passive mic capture when inactive

**Acceptance Criteria**
- push-to-talk reaches guardian-runtime end to end
- voice intents become normalized guardian events
- playback never overlaps itself
- urgent speech may interrupt normal speech
- LiveKit path works as optional transport, not required runtime dependency

**Confidence**
- `85-90%`
- Likely needs one clarification only if you want LiveKit prioritized over fully local path in implementation order.

---

### Phase 4: Build The Longitudinal Intelligence Layer
**Goal**
- Turn session traces into usable memory and planning signals.

**Subtasks**
1. Define memory boundaries
   - working
   - episodic
   - semantic
   - procedural
2. Persist episodic trace structure
   - events
   - interventions
   - overrides
   - outcomes
   - reflections
3. Add semantic extraction flow
   - recurring distractions
   - schedule patterns
   - tone preferences
   - energy windows
4. Add day briefing generation
   - recent sessions
   - goals
   - deadlines
   - concept pressure
5. Narrow knowledge access
   - typed read models only
   - no raw SQL in live guardian path
6. Separate tutor mode from guardian mode
   - explicit invocation only

**Acceptance Criteria**
- session traces persist in usable form
- semantic profile updates from trace summaries, not ad hoc writes
- day briefing reflects memory layers
- live guardian tools are typed and bounded

**Confidence**
- `90%`
- Depends on final typed read-model design after Phase 1 and 2.

---

### Phase 5: Harden Policies And Blocking
**Goal**
- Make guardian intervention behavior precise, explainable, and less noisy.

**Subtasks**
1. Define distraction taxonomy
   - blocked distractor
   - ambiguous context
   - productive support
   - short-lived justified deviation
2. Formalize focus score inputs
   - tab/domain category
   - dwell
   - idle
   - task alignment
   - override context
3. Add cooldown and anti-spam logic
4. Formalize override rubric
   - reason
   - target
   - duration
   - context
   - trust signal
5. Enforce TTL behavior
   - approved override auto-expires
   - re-block happens automatically
6. Add explainable intervention templates
7. Add non-intrusive guardian silence rules
   - do not interrupt productive deep work unnecessarily

**Acceptance Criteria**
- hard blocks happen only in active sessions
- every block has rationale
- overrides are scoped and auto-expire
- false-positive intervention rate is reduced on replay scenarios

**Confidence**
- `90-93%`
- Safe after runtime/event contract is stable.

---

### Phase 6: Build The Optimizer Plane
**Goal**
- Make the guardian improve through eval-gated artifact promotion only.

**Subtasks**
1. Freeze mutable artifact surface
   - prompt pack
   - thresholds
   - override rubric
   - retrieval selection policy
   - phrasing policy
   - defense rules
2. Define eval entities
   - eval cases
   - runs
   - promotions
   - canaries
3. Build three eval sources
   - scripted cases
   - replayed traces
   - adversarial override cases
4. Define scoring function
   - intent accuracy
   - block quality
   - false positive penalty
   - over-intervention penalty
   - override quality
   - tone/trust
   - session outcome proxy
5. Add hard-fail gates
   - privacy violation
   - inactive intervention
   - broken override expiry
   - unsafe blocking
6. Build keep-or-revert loop
   - baseline
   - one mutation
   - fixed budget
   - promote or revert
7. Add canary activation and rollback
8. Keep optimizer off live hot path

**Acceptance Criteria**
- optimizer edits only artifacts
- experiments are reproducible and logged
- promotions require score improvement and zero hard failures
- canary failure restores prior bundle cleanly

**Confidence**
- `88-92%`
- Needs the eval metric formula locked during implementation, but the architecture is clear.

---

### Phase 7: Product Surface Consolidation
**Goal**
- Make each surface minimal and role-specific.

**Subtasks**
1. Web cockpit
   - live guardian state
   - logs
   - reflections
   - day briefing
   - override review
2. Extension
   - browser sensing
   - block/unblock UX
   - scoped override request
3. Mac helper
   - local voice runtime
   - session heartbeat
   - local orchestration boundary
4. Phone/PWA
   - notifications
   - status view
   - override/reflection submission
5. Remove duplicated guardian/tutor UX
   - unify overlapping chat surfaces where needed

**Acceptance Criteria**
- each surface has a single clear job
- no surface owns guardian decision logic
- duplicated guardian-facing UX is reduced

**Confidence**
- `85-90%`
- Best done after runtime, voice, and memory paths are stable.

---

### Phase 8: Cleanup, Hardening, And Productionization
**Goal**
- Remove prototype debt that would undermine the guardian architecture.

**Subtasks**
1. Deprecate raw-SQL model tools from chat path
2. Remove startup-side-effect ownership of live guardian orchestration
3. Replace dev-style LaunchAgent runtime assumptions
4. Improve lint/type/build quality gates on guardian surfaces
5. Remove stale legacy routes and duplicated command paths
6. Add operational monitoring for guardian failures
7. Document deployment and rollback behavior

**Acceptance Criteria**
- no critical guardian path depends on prototype-only infrastructure
- guardian startup/runtime model is explicit
- touched guardian surfaces meet meaningful quality gates
- legacy route split is reduced or removed safely

**Confidence**
- `90%`
- Depends on earlier phases landing cleanly.

## Cross-Phase Interfaces To Lock Early
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

## Global Test Matrix
- inactive privacy
- active session start/end
- realtime focus updates
- hard block with rationale
- scoped override with TTL
- override expiry and re-block
- push-to-talk intent routing
- no speech overlap
- day briefing correctness
- semantic memory update correctness
- optimizer keep-or-revert correctness
- canary rollback correctness
- extension disconnect/reconnect
- productive-scatter false positive case
- tired-day low-energy case
- manipulative override case

## Assumptions And Defaults
- Phase 1 is the first implementation target.
- LiveKit stays optional; fully local voice remains supported.
- macOS + Chrome/Brave + single-user + Mac Mini remain the v1 operating assumptions.
- Push-to-talk only in v1.
- Hard guardian during active sessions, but always with scoped override.
- Self-improvement remains bounded to artifact promotion only.
- If a phase reveals unresolved product ambiguity, stop and ask before coding rather than guessing.
