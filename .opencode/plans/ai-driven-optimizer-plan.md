# AI-Driven Optimizer Plan

## Vision

Replace all hardcoded rules, static weights, and regex-based calibration in LifeOS Guardian with a fully **context-aware, intent-driven, self-improving** system. Every scoring decision, every intervention, and every calibration adjustment must be derived from:

1. **Context** — what the UIL (Unified Intelligence Layer) knows about the user right now (energy, patterns, goals, deadlines, recent behavior).
2. **Intent** — what the user is actually trying to accomplish in this specific session (deep writing, urgent bug fix, research, exam cram).

No two sessions should be scored identically. The system must learn from every feedback cycle and never make the same mistake twice.

---

## Current State Assessment

### What exists today

| Component | File | Current Behavior | Problem |
|-----------|------|------------------|---------|
| Focus Score | `src/lib/focus-score.ts` | Weighted composite: continuity(35%), switches(25%), dwell(20%), distraction-revisit(15%), idle(5%). Weights read from `GuardianPolicyBundle` but bundle is static. | Weights are the same for every session regardless of intent. Tab switching is equally penalized for coding (where it's productive) and writing (where it's scattered). |
| Default Policy | `src/lib/guardian-artifacts.ts` | Single `DEFAULT_GUARDIAN_POLICY_BUNDLE` with hardcoded weights and thresholds. | Every session gets the same policy bundle regardless of topic or energy. |
| Calibration | `src/lib/guardian-calibration.ts` | Regex-based `extractSignals()` matches keywords like "distracted", "focused". Adjusts weights by ±0.02 `LEARNING_RATE`. | Brittle. "I wasn't distracted" triggers the "distracted" keyword. No understanding of context or nuance. |
| Intent Engine | `src/lib/intent-engine.ts` | Gemini Flash parses voice transcript → `{ topic, durationMinutes, mood }`. | Only used at session start for voice. Never wired into focus scoring or policy generation. |
| UIL (Intelligence) | `src/lib/intelligence.ts` | Gemini Pro synthesizes full `UserIntelligenceProfile` with `adaptiveThresholds`, `distractionTriggers`, `avoidancePatterns`, `goalMomentum`, etc. | Used for nudges and briefings, but **never wired into the focus algorithm or the guardian runtime**. |
| Optimizer | `src/lib/guardian-optimizer.ts` | LLM generates policy mutations, evals against hardcoded test cases, promotes best candidate. | Eval suite is static (`DEFAULT_GUARDIAN_EVAL_CASES`). Doesn't learn from real user sessions. |
| Eval Harness | `src/lib/guardian-eval.ts` | Simulates sessions against policy bundles using `classifyUrlSync`. | URL classification is domain-cache-only, no session context awareness. |
| Memory Extractor | `src/lib/memory-extractor.ts` | LLM-powered Mem0-style ADD/UPDATE/DELETE/NOOP on semantic facts. | Already intelligent. But extracted facts are not fed into policy generation. |
| Energy Composite | `src/lib/energy-composite.ts` | 4-signal weighted composite from semantic profile. Weights already per-user and calibrated. | Good model. But its output (`energyComposite`) is stored on the session but not used to modify focus scoring behavior. |

### What is missing

1. **Context-to-Policy Pipeline** — no code path exists where UIL + Intent → dynamic policy bundle.
2. **LLM Calibration** — no code path where Gemini interprets feedback nuance instead of regex.
3. **Self-Evolving Eval Suite** — no code path where real user corrections become permanent eval cases.
4. **Session-Type Awareness** — no concept of "work mode" (deep work vs research vs urgent sprint vs recovery).

---

## Implementation Plan

### Phase O6A: Context-Aware Policy Generation

**Goal:** When a session starts, dynamically generate a bespoke `GuardianPolicyBundle` tailored to the user's current context, intent, and energy — instead of using the static default.

#### Subtask O6A-1: Define `SessionIntentProfile` type

**File:** `src/lib/guardian-types.ts`

Add a new type that captures what we know about the user's intent at session start:

```typescript
export type WorkMode = 'deep_work' | 'research' | 'urgent_sprint' | 'learning' | 'recovery';

export interface SessionIntentProfile {
  workMode: WorkMode;
  topic: string;
  goalId: string | null;
  goalTitle: string | null;
  deadlineUrgency: 'none' | 'this_week' | 'today' | 'overdue';
  energyAtStart: 'high' | 'medium' | 'low';
  coachingStyle: 'direct' | 'balanced' | 'gentle';
  recentDistractionTriggers: string[];
  recentAvoidancePatterns: string[];
  optimalSprintMinutes: number;
}
```

**Acceptance Criteria:**
- Type compiles without errors.
- No existing types are modified or broken.

---

#### Subtask O6A-2: Build `resolveSessionIntent()` function

**File:** Create `src/lib/session-intent-resolver.ts`

This function is called at session start. It takes the raw `GuardianStartRequest` + the current `UserIntelligenceProfile` and produces a `SessionIntentProfile`.

**Logic:**
1. Extract `topic`, `mood`, `durationMinutes` from the start request.
2. Load the UIL profile via `getIntelligenceProfile()`.
3. Check deadline urgency by querying `tasks` table for tasks matching the topic/goal that are due soon.
4. Determine `workMode` using an LLM call to Gemini Flash:
   - **Prompt:** Given the session topic, the user's goals, their current energy, and their recent session history, classify the work mode. "Fixing API auth bug due today" → `urgent_sprint`. "Reading ZK proofs paper" → `research`. "Writing essay" → `deep_work`. "Tired, just need to review notes" → `recovery`.
   - **Fallback:** If LLM is unavailable, use keyword heuristics: topic contains "fix/bug/urgent/due" → `urgent_sprint`; contains "read/research/explore" → `research`; contains "write/draft/design" → `deep_work`; mood = low → `recovery`.
5. Return the complete `SessionIntentProfile`.

**Dependencies:** `guardian-types.ts` (O6A-1), `intelligence.ts`, `ai.ts`, `models.ts`, `db.ts`.

**Acceptance Criteria:**
- Function returns a valid `SessionIntentProfile` for any combination of topic + energy.
- LLM call uses `MODEL_FLASH` with `responseMimeType: 'application/json'`.
- Fallback works when LLM is unavailable.
- Function completes in <3 seconds (Flash model target).

---

#### Subtask O6A-3: Build `generateDynamicPolicy()` function

**File:** Create `src/lib/dynamic-policy-generator.ts`

This is the core function. It takes a `SessionIntentProfile` and produces a complete `GuardianPolicyBundle` optimized for that specific session.

**Logic:**
1. Start from the active policy bundle (via `getActiveGuardianPolicyBundle()`).
2. Call Gemini Pro with the intent profile and ask it to adjust weights and thresholds:

   **Prompt Template:**
   ```
   You are a focus-scoring policy optimizer. Generate an optimized GuardianPolicyBundle
   for this specific session:

   SESSION INTENT:
   - Work mode: {workMode}
   - Topic: "{topic}"
   - Deadline urgency: {deadlineUrgency}
   - Energy level: {energyAtStart}
   - Coaching style: {coachingStyle}
   - Distraction triggers: {recentDistractionTriggers}
   - Avoidance patterns: {recentAvoidancePatterns}
   - Optimal sprint: {optimalSprintMinutes} min

   CURRENT BASELINE POLICY:
   {JSON.stringify(activePolicy)}

   ADJUSTMENT RULES BY WORK MODE:
   - deep_work: Increase dwell weight (user should stay on one page). Penalize tab switches heavily.
     Lower idle threshold (idle = broke flow). Shorter speech cooldown (intervene faster on scatter).
   - research: Lower tab switch penalty (switching between papers/docs is normal).
     Increase distraction revisit penalty (revisiting Twitter is NOT research).
     Higher idle threshold (thinking while reading is normal).
   - urgent_sprint: Lower all thresholds for intervention (be aggressive about protecting the sprint).
     Shorter speech cooldown. Lower flow silence threshold. Block faster on distraction revisit.
   - learning: Increase dwell weight (deep reading). Tolerate YouTube if topic-relevant.
     Higher idle threshold (absorbing content takes pauses).
   - recovery: Maximum leniency. Highest idle threshold. Longest speech cooldown.
     Gentle coaching style. Only block on severe distraction revisits.

   DEADLINE URGENCY MODIFIERS:
   - today/overdue: Treat as urgent_sprint regardless of stated workMode.
   - this_week: Slightly tighter thresholds. Suggest shorter sprints.

   ENERGY MODIFIERS:
   - low: Increase idle threshold by 50%. Decrease speech frequency. Use gentle coaching.
   - medium: Default behavior.
   - high: Tighter thresholds acceptable. User can handle more structure.

   HARD CONSTRAINTS:
   - Weights must sum to exactly 1.0 (tolerance ±0.01)
   - Each weight must be in [0.05, 0.60]
   - Thresholds must stay within bounds defined in guardian-optimizer.ts
   - redTeamRules must be preserved verbatim
   - Do not change retrievalPrompt or sessionPlannerPrompt

   Return ONLY a complete JSON GuardianPolicyBundle with ALL fields.
   ```

3. Validate the LLM output using the existing `validatePolicyBundle()` function from `guardian-optimizer.ts`.
4. If validation fails, fall back to the active policy bundle with only minor adjustments based on the work mode (hand-coded fallback).

**Fallback rules (when LLM is down):**

| Work Mode | Weight Shifts | Threshold Shifts |
|-----------|--------------|-----------------|
| deep_work | continuity +0.05, switches +0.05, dwell +0.05, distractionPenalty -0.05, idlePenalty -0.05 | idleConcernSeconds: -60, speechCooldownMs: -15000 |
| research | switches -0.10, distractionPenalty +0.05, dwell -0.05, idlePenalty -0.05 | idleConcernSeconds: +120, distractionRevisitBlockCount: +1 |
| urgent_sprint | distractionPenalty +0.10, idlePenalty +0.05, continuity -0.05, switches -0.05, dwell -0.05 | speechCooldownMs: -30000, flowSilenceThreshold: -10, distractionRevisitBlockCount: -1 |
| learning | dwell +0.10, switches -0.05, continuity -0.05 | idleConcernSeconds: +180 |
| recovery | idlePenalty -0.10, distractionPenalty -0.05, continuity +0.05, dwell +0.05 | idleConcernSeconds: +300, speechCooldownMs: +60000 |

After applying shifts, re-normalize weights to sum to 1.0.

**Dependencies:** `guardian-types.ts`, `guardian-optimizer.ts` (for `getActiveGuardianPolicyBundle` and `validatePolicyBundle`), `ai.ts`, `models.ts`, `session-intent-resolver.ts`.

**Acceptance Criteria:**
- Returns a valid `GuardianPolicyBundle` for every `WorkMode` + energy combination.
- Weights always sum to 1.0.
- LLM uses `MODEL_PRO` with `responseMimeType: 'application/json'`.
- Fallback produces at least mode-appropriate weight shifts when LLM is down.
- Validation rejects any policy that violates bounds.

---

#### Subtask O6A-4: Wire dynamic policy into `startGuardianSession()`

**File:** `src/lib/guardian-runtime.ts`

Modify the session creation flow:

1. After `createSessionState()`, call `resolveSessionIntent()` with the start request + UIL profile.
2. Store the `SessionIntentProfile` on the `GuardianState` (add a new field `intentProfile: SessionIntentProfile | null`).
3. Call `generateDynamicPolicy(intentProfile)` to get a session-specific policy bundle.
4. Store the dynamic policy on the `GuardianState` (add a new field `sessionPolicy: GuardianPolicyBundle | null`).
5. In `tickGuardianSession()`, when calling `computeFocusScore()`, pass `session.sessionPolicy ?? getActiveGuardianPolicyBundle()` instead of always using the active bundle.
6. In the decision table logic, also use `session.sessionPolicy`.

**Type changes to `GuardianState` in `guardian-types.ts`:**
```typescript
// Add to GuardianState interface:
intentProfile: SessionIntentProfile | null;
sessionPolicy: GuardianPolicyBundle | null;
```

**Dependencies:** O6A-1, O6A-2, O6A-3.

**Acceptance Criteria:**
- Starting a session with topic "Fix bug in auth API" and energy=low produces a policy with lowered tab switch penalty and higher idle threshold.
- Starting a session with topic "Write essay" and energy=high produces a policy with high dwell weight and strict tab switch penalty.
- Existing sessions (no intent profile) fall back to the active policy bundle gracefully.
- Focus score computed during the session uses the dynamic policy, not the global default.
- `npm run build` passes.

---

### Phase O6B: LLM-Powered Calibration

**Goal:** Replace the regex-based `extractSignals()` with an LLM call that understands nuance, context, and the specific work mode of the session.

#### Subtask O6B-1: Define `LLMCalibrationSignal` type

**File:** `src/lib/guardian-types.ts`

```typescript
export interface LLMCalibrationSignal {
  focusOverEstimated: boolean;
  focusUnderEstimated: boolean;
  energyOverEstimated: boolean;
  energyUnderEstimated: boolean;
  workModeMismatch: boolean;
  suggestedWorkMode: WorkMode | null;
  specificComplaints: string[];
  weightAdjustments: Array<{
    component: string;
    delta: number;
    reason: string;
  }>;
  thresholdAdjustments: Array<{
    threshold: string;
    suggestedValue: number;
    reason: string;
  }>;
  overallSessionQuality: 'excellent' | 'good' | 'mediocre' | 'poor';
  selfAwarenessScore: number;
}
```

**Acceptance Criteria:**
- Type compiles without errors.

---

#### Subtask O6B-2: Build `extractLLMCalibrationSignals()` function

**File:** `src/lib/guardian-calibration.ts`

Add a new async function alongside the existing `extractSignals()`. The old function will be kept as fallback.

**Logic:**
1. Takes: `rawText` (user feedback), `SessionMetrics`, `SessionIntentProfile | null`, `GuardianPolicyBundle` (the session-specific policy used).
2. Calls Gemini Pro with a structured prompt:

   **Prompt Template:**
   ```
   You are calibrating a focus guardian AI. The user just finished a session and gave
   free-text feedback. Analyze whether the system's scoring and intervention behavior
   was fair given the session context.

   SESSION CONTEXT:
   - Topic: "{topic}"
   - Work mode: {workMode}
   - Energy at start: {energyAtStart}
   - Duration: {elapsed_minutes} min (planned: {planned_minutes} min)

   SYSTEM MEASUREMENTS:
   - Focus score: {system_focus_score}/100
   - Energy composite: {system_energy_composite}/100
   - Distraction events: {system_distraction_events}
   - Interventions: {system_intervention_count}
   - Overrides: {system_override_count}

   POLICY USED FOR THIS SESSION:
   - Tab switch weight: {weights.switches}
   - Continuity weight: {weights.continuity}
   - Dwell weight: {weights.dwell}
   - Distraction revisit penalty weight: {weights.distractionPenalty}
   - Idle penalty weight: {weights.idlePenalty}
   - Idle concern threshold: {thresholds.idleConcernSeconds}s
   - Block after N distraction revisits: {thresholds.distractionRevisitBlockCount}

   USER FEEDBACK: "{rawText}"

   Analyze:
   1. Was the focus score fair for this type of work? (e.g., tab switching is normal
      for research but bad for writing — was it penalized appropriately?)
   2. Were interventions too frequent or too rare?
   3. Was the energy estimate accurate?
   4. Did the work mode classification match what the user actually did?
   5. What specific weight or threshold adjustments would make scoring fairer?

   Return ONLY valid JSON matching the LLMCalibrationSignal schema.
   ```

3. Validate the response shape. If invalid or LLM unavailable, fall back to the existing `extractSignals()`.

**Dependencies:** O6B-1, `ai.ts`, `models.ts`.

**Acceptance Criteria:**
- Nuanced feedback like "I wasn't distracted, I was researching" correctly results in `focusOverEstimated: true` with a `weightAdjustments` delta of `-0.05` on `switches` (instead of the regex mistakenly seeing "distracted" and doing the opposite).
- Falls back to `extractSignals()` when LLM is unavailable.
- Function is async and returns within 5 seconds.

---

#### Subtask O6B-3: Update `processSessionFeedback()` to use LLM signals

**File:** `src/lib/guardian-calibration.ts`

Modify the main `processSessionFeedback()` function:

1. Change signature to also accept `intentProfile: SessionIntentProfile | null` and `sessionPolicy: GuardianPolicyBundle | null`.
2. Replace the `extractSignals()` call with `await extractLLMCalibrationSignals()` (with regex fallback).
3. Apply `weightAdjustments` from the LLM response directly, instead of the current hardcoded `LEARNING_RATE = 0.02` binary adjustments. The LLM provides specific deltas per component (e.g., `switches: -0.10`).
4. Apply `thresholdAdjustments` similarly — the LLM can suggest specific threshold values.
5. If `workModeMismatch: true`, store this as a fact in `mem_facts` via the memory extractor so future sessions with similar topics are classified correctly.
6. Keep all existing persistence logic (`session_feedback`, `calibration_history`, `guardian_semantic_profiles` updates).
7. Update the `prediction_error_focus` calculation: instead of binary +1/-1 based on regex, use a continuous value derived from `overallSessionQuality` mapping (excellent=-1, good=-0.5, mediocre=+0.5, poor=+1) when `focusOverEstimated` or `focusUnderEstimated` is true.

**Weight application logic:**

```typescript
// Current: hardcoded binary adjustments with LEARNING_RATE = 0.02
// New: apply LLM-suggested deltas directly, clamped and normalized

function applyWeightAdjustments(
  currentWeights: Record<string, number>,
  adjustments: Array<{ component: string; delta: number; reason: string }>
): Record<string, number> {
  const WEIGHT_KEY_MAP: Record<string, string> = {
    continuity: 'focus_weight_continuity',
    switches: 'focus_weight_tab_switches',
    dwell: 'focus_weight_dwell',
    distractionPenalty: 'focus_weight_distraction_revisit',
    idlePenalty: 'focus_weight_idle',
  };

  const result = { ...currentWeights };
  for (const adj of adjustments) {
    const key = WEIGHT_KEY_MAP[adj.component];
    if (key) {
      // Clamp delta to ±0.10 maximum per adjustment (safety bound)
      const clampedDelta = Math.max(-0.10, Math.min(0.10, adj.delta));
      result[key] = clamp(result[key] + clampedDelta);
    }
  }
  return normalise(result);
}
```

**Dependencies:** O6B-2, `guardian-types.ts`, `memory.ts`.

**Acceptance Criteria:**
- Calibration from nuanced feedback correctly adjusts weights in the right direction.
- `calibration_history` table records the LLM's reason for each adjustment.
- `guardian_semantic_profiles` weights are updated and normalized (sum = 1.0).
- Work mode mismatches are stored as memory facts.
- Regex fallback still works when LLM is unavailable.
- `npm run build` passes.

---

#### Subtask O6B-4: Wire calibration into session end flow

**File:** `src/lib/guardian-runtime.ts`

In `endGuardianSession()`, after the session summary is persisted:

1. Load the `intentProfile` and `sessionPolicy` from the session state.
2. When the Telegram bot or voice agent prompts for feedback, pass these to the feedback handler.
3. Update the call to `processSessionFeedback()` in the Telegram feedback handler (`telegram-agent.ts`) to include the intent profile and session policy.

**Dependencies:** O6A-4, O6B-3.

**Acceptance Criteria:**
- Ending a session triggers the LLM calibration path when feedback is received.
- The feedback handler has access to the session's intent profile and policy.
- All callers of `processSessionFeedback` are updated to the new signature.

---

### Phase O6C: Self-Evolving Eval Suite

**Goal:** The optimizer's eval suite must grow autonomously from real user corrections. When the Guardian makes a mistake, that scenario becomes a permanent test case.

#### Subtask O6C-1: Build `extractEvalCaseFromFeedback()` function

**File:** Create `src/lib/eval-case-extractor.ts`

When calibration detects a significant Guardian mistake (hard failure, false positive block, missed distraction, work mode mismatch), this function converts the session trace into a `GuardianEvalScenario`.

**Logic:**
1. Takes: `sessionId`, the `LLMCalibrationSignal`, and the session's `GuardianPolicyBundle`.
2. Loads the session's tab event log from `guardian_event_log`.
3. Converts events into the `GuardianEvalScenario.events` format:
   - `tab` events → `{ type: 'tab', url, title, dwellSeconds }`
   - `idle` events → `{ type: 'idle', idleSeconds }`
   - `heartbeat` events → `{ type: 'heartbeat' }`
4. Determines `expected` outcome based on the calibration signal:
   - `focusOverEstimated && specificComplaints includes "shouldn't have blocked"` → `{ mustBlock: false, maxBlockCount: 0 }`
   - `focusUnderEstimated && specificComplaints includes "didn't catch distraction"` → `{ mustBlock: true }`
   - `workModeMismatch` → `{ finalClassification: 'on_topic' }` (if the user was doing research but was scored for deep work)
5. Classifies the scenario type: `false_positive_guard`, `missed_distraction`, `work_mode_mismatch`, `over_intervention`.
6. Persists to `guardian_eval_cases` table.

**Dependencies:** `guardian-types.ts`, `db.ts`.

**Acceptance Criteria:**
- A session where the user was blocked while doing productive research creates a `false_positive_guard` eval case.
- A session where the Guardian missed repeated distraction revisits creates a `missed_distraction` eval case.
- Cases are inserted with `active = 1` so the optimizer sees them.
- The `caseName` is descriptive (e.g., `real_false_positive_research_blocked`).

---

#### Subtask O6C-2: Wire eval extraction into calibration flow

**File:** `src/lib/guardian-calibration.ts`

In `processSessionFeedback()`, after the LLM calibration signals are extracted:

1. Check if the signal indicates a significant Guardian mistake:
   - `focusOverEstimated && specificComplaints includes block-related complaint`
   - `focusUnderEstimated && overallSessionQuality === 'poor'`
   - `workModeMismatch`
2. If any of these are true, call `extractEvalCaseFromFeedback()` to create a new eval case.
3. Log the extraction in `calibration_history` with a note: "Generated eval case from user feedback."

**Dependencies:** O6C-1, O6B-3.

**Acceptance Criteria:**
- When a user reports "I was researching and you blocked me", a new eval case is created that will prevent future policies from making the same mistake.
- The optimizer's `listGuardianEvalCases()` now returns both the original hardcoded cases AND the user-derived cases.

---

#### Subtask O6C-3: Add session-trace replay eval source

**File:** `src/lib/guardian-optimizer.ts`

Currently the optimizer only uses `DEFAULT_GUARDIAN_EVAL_CASES` and `CANARY_EVAL_CASES`. Add a third source: **replayed real sessions**.

**Logic:**
1. In `scoreBundleAgainstSuite()`, also load the top 5 most recent user-derived eval cases (from `guardian_eval_cases` where `scenario_type LIKE 'real_%'`).
2. Run these alongside the existing suite cases.
3. Weight real cases at 1.5x in the scoring (they represent actual user corrections, so they matter more than synthetic cases).

**Implementation detail in `scoreBundleAgainstSuite()`:**

```typescript
function scoreBundleAgainstSuite(policy: GuardianPolicyBundle, suiteName: string = DEFAULT_SUITE_NAME): GuardianEvalSummary {
  const syntheticCases = listGuardianEvalCases(suiteName);
  
  // NEW: Load user-derived real cases
  const realCases = loadUserDerivedEvalCases(5);
  
  const syntheticResults = syntheticCases.map((r) =>
    evaluateGuardianPolicyScenario(r.id, r.caseName, policy, JSON.parse(r.inputPayload) as GuardianEvalScenario)
  );
  
  const realResults = realCases.map((r) =>
    evaluateGuardianPolicyScenario(r.id, r.caseName, policy, JSON.parse(r.inputPayload) as GuardianEvalScenario)
  );
  
  // Weight real cases at 1.5x
  const syntheticScore = syntheticResults.reduce((s, r) => s + r.score, 0);
  const realScore = realResults.reduce((s, r) => s + r.score * 1.5, 0);
  const totalCount = syntheticResults.length + realResults.length * 1.5;
  
  const scenarioScore = round2((syntheticScore + realScore) / Math.max(1, totalCount));
  
  // ... rest of blending with calibration accuracy
}
```

**Dependencies:** O6C-2, `guardian-eval.ts`.

**Acceptance Criteria:**
- The optimizer scores candidates against both synthetic AND real-user-derived test cases.
- Real cases carry 1.5x weight in the final score.
- If a candidate fails a real-user case, it is a hard failure (not promoted).

---

### Phase O6D: Bind UIL Adaptive Thresholds to Focus Scoring

**Goal:** The UIL already computes `adaptiveThresholds` (e.g., `focusDropAlertScore`, `distractionAlertMinutes`). Wire these directly into the focus scoring and intervention logic so they actually drive behavior.

#### Subtask O6D-1: Pass UIL thresholds into dynamic policy generation

**File:** `src/lib/dynamic-policy-generator.ts`

In `generateDynamicPolicy()`:

1. Load the UIL profile.
2. Map `adaptiveThresholds` to policy thresholds:
   - `focusDropAlertScore` → informs `lowFocusThreshold`
   - `distractionAlertMinutes` → informs `idleConcernSeconds` (multiply by 60)
   - `sessionDurationSweetSpot` → informs recommended sprint duration (used in session start suggestions)
   - `cognitiveLoadThreshold` → used in the prompt to the LLM so it knows if the user is overloaded
3. Pass these as context to the LLM prompt so it can make informed threshold decisions.

**Dependencies:** O6A-3, `intelligence.ts`.

**Acceptance Criteria:**
- If UIL says `distractionAlertMinutes: 20` (user takes longer to refocus), the dynamic policy sets `idleConcernSeconds: 1200` (20 min).
- If UIL says `focusDropAlertScore: 50` (user's focus drops are more severe), the dynamic policy sets `lowFocusThreshold: 50`.
- These are suggestions to the LLM, not hard overrides — the LLM may adjust further.

---

#### Subtask O6D-2: Make `focus-score.ts` fully policy-driven

**File:** `src/lib/focus-score.ts`

Currently, `computeFocusScore()` already accepts an optional `policy` parameter and reads `policy.weights`. But there are still hardcoded formulas:

1. **Switch score:** `if (switchesPerMin >= 3) switchScore = 0; else switchScore = 100 - (switchesPerMin * 33);`
   - This is a linear formula with a hard cutoff at 3. For research mode, 3 switches/min is fine.
   - **Change:** Use `policy.thresholds.highScatterSpeakThreshold` as the zero-point instead of hardcoded 3.
   - New formula: `switchScore = 100 - (switchesPerMin / policy.thresholds.highScatterSpeakThreshold) * 100`

2. **Dwell score:** `dwellScore = Math.min(100, (avgDwell / 180) * 100);`
   - The 180-second (3-min) target is hardcoded. For deep work it should be higher; for research it should be lower.
   - **Change:** Add `policy.thresholds.dwellDepthTargetSeconds` (new threshold field, default 180). Use it instead of the hardcoded 180.

3. **Idle penalty:** `if (idleMinutes > 10) idlePenalty = 30; else if (idleMinutes > 5) idlePenalty = 15;`
   - Hardcoded thresholds. Should use `policy.thresholds.idleConcernSeconds / 60`.
   - **Change:** Compute idle penalty as a fraction: `idlePenalty = (idleMinutes / (policy.thresholds.idleConcernSeconds / 60)) * 30` (caps at 30).

**Type changes to `GuardianPolicyBundle` in `guardian-types.ts`:**
```typescript
// Add to thresholds:
dwellDepthTargetSeconds: number; // default 180
```

**Dependencies:** O6A-1, O6A-3.

**Acceptance Criteria:**
- No hardcoded numbers remain in `computeFocusScore()`. All formula constants come from `policy.weights` or `policy.thresholds`.
- The new `dwellDepthTargetSeconds` field has a default of 180 in the default policy bundle.
- Existing test cases still pass (default policy preserves old behavior).
- `npm run build` passes.

---

#### Subtask O6D-3: Add fatigue curve to focus scoring

**File:** `src/lib/focus-score.ts`

Currently, idle time is penalized flatly. But on a low-energy day, a 5-minute pause is recovery, not distraction.

**Logic:**
1. Accept an optional `energyComposite: number | null` parameter in `computeFocusScore()`.
2. If `energyComposite < 35` (low energy):
   - Multiply idle penalty by 0.5 (halve it).
   - Multiply distraction revisit penalty by 0.7 (be more forgiving — they're already struggling).
3. If `energyComposite >= 85` (high energy):
   - Multiply idle penalty by 1.3 (they should be able to sustain focus).
   - Leave distraction revisit penalty as-is.

This implements the Yerkes-Dodson law: on tired days, the optimal arousal level is lower, so the guardian should be less demanding.

**Dependencies:** O6D-2, `energy-composite.ts`.

**Acceptance Criteria:**
- On a low-energy day (composite < 35), idle penalty is halved.
- On a high-energy day (composite >= 85), idle penalty is 1.3x.
- Normal energy: no change.
- `npm run build` passes.

---

### Phase O6E: Memory-Driven Policy Improvement Loop

**Goal:** Close the loop so that extracted memory facts (from `memory-extractor.ts`) influence policy generation. The Guardian should remember "this user does their best coding at night with music" and generate policies accordingly.

#### Subtask O6E-1: Inject semantic memory into policy generation

**File:** `src/lib/dynamic-policy-generator.ts`

In the `generateDynamicPolicy()` prompt:

1. Load the top 10 relevant memory facts via `queryRelevantFacts({ topic: sessionTopic, limit: 10 })` and `searchFactsByText(sessionTopic, 10)`.
2. Include them in the LLM prompt as a section:

   ```
   KNOWN FACTS ABOUT THIS USER (from long-term memory):
   - [pattern] Does best coding sessions between 9-11pm with music playing
   - [preference] Prefers gentle nudges, not hard blocks, when energy is low
   - [constraint] Has ADHD — tab switching is common even during productive work
   ```

3. The LLM can then adjust the policy based on these facts (e.g., if the user has ADHD, lower the tab switch penalty across all modes).

**Dependencies:** O6A-3, `memory.ts`.

**Acceptance Criteria:**
- Policy generation prompt includes user's long-term memory facts.
- Facts about work patterns, preferences, and constraints influence the generated policy.
- If a user has a stored fact about preferring gentle nudges, the generated policy has a longer `speechCooldownMs`.

---

#### Subtask O6E-2: Store calibration corrections as memory facts

**File:** `src/lib/guardian-calibration.ts`

In `processSessionFeedback()`, after LLM calibration:

1. If `workModeMismatch: true`, call `insertFact()` or `supersedeFact()` with:
   - `category: 'pattern'`
   - `topic: session topic`
   - `content: "Sessions about '{topic}' should be classified as {suggestedWorkMode}, not {actualWorkMode}"`
   - `confidence: 0.8`
   - `source: 'calibration_correction'`

2. If `specificComplaints` mention a recurring issue (e.g., "you always block me when I'm researching"), store:
   - `category: 'constraint'`
   - `topic: 'guardian_behavior'`
   - `content: "User reports Guardian incorrectly blocks during research — adjust tab switch tolerance"`
   - `confidence: 0.7`

**Dependencies:** O6B-3, `memory.ts`, `memory-extractor.ts`.

**Acceptance Criteria:**
- Work mode mismatches are stored as persistent memory facts.
- These facts appear in future policy generation prompts via O6E-1.
- The Guardian "remembers" that certain topics are research, not deep work.

---

### Phase O6F: Integration Testing and Verification

**Goal:** Verify the entire loop works end-to-end: session start → dynamic policy → focus scoring → session end → LLM calibration → memory storage → eval case creation → optimizer improvement.

#### Subtask O6F-1: Update `GuardianState` and related code for new fields

**File:** `src/lib/guardian-types.ts`, `src/lib/guardian-runtime.ts`

Ensure all new fields (`intentProfile`, `sessionPolicy`) are properly initialized in `createSessionState()` and handled in `cloneSession()`, session restoration from DB, and SSE state serialization.

**Acceptance Criteria:**
- `GuardianState` includes `intentProfile` and `sessionPolicy`.
- Session creation initializes both to `null` (set later by O6A-4).
- Session clone preserves both.
- SSE stream includes work mode in state payload.
- `npm run build` passes.

---

#### Subtask O6F-2: Update all callers of `processSessionFeedback`

**Files:** `src/lib/telegram-agent.ts`, any other callers.

Update the function signature and all call sites to pass `intentProfile` and `sessionPolicy`.

**Acceptance Criteria:**
- All callers pass the new parameters.
- Null/undefined is handled gracefully when session data is unavailable.

---

#### Subtask O6F-3: End-to-end scenario testing

**Manual test checklist:**

1. **Deep work session:** Start session "Write research abstract" with energy=high.
   - Verify: Dynamic policy has high dwell weight, strict tab switch penalty.
   - Verify: Focus score drops correctly when switching tabs.

2. **Research session:** Start session "Read ZK proofs papers" with energy=medium.
   - Verify: Dynamic policy has lower tab switch penalty.
   - Verify: Focus score stays high despite moderate tab switching.

3. **Urgent sprint:** Start session "Fix auth bug due today" with deadline=overdue.
   - Verify: Dynamic policy has aggressive intervention thresholds.
   - Verify: Blocks fire faster on distraction.

4. **Low energy session:** Start session with energy=low.
   - Verify: Dynamic policy has lenient idle threshold.
   - Verify: Fatigue curve in focus scoring reduces idle penalty.

5. **LLM Calibration:** End session, give nuanced feedback "I was researching docs, not distracted".
   - Verify: LLM correctly identifies focus was over-estimated.
   - Verify: Tab switch weight is decreased in semantic profile.
   - Verify: Memory fact is stored about research pattern.

6. **Eval case creation:** Same as #5.
   - Verify: New eval case appears in `guardian_eval_cases`.
   - Verify: Optimizer sees the new case on next run.

7. **Optimizer cycle:** Run `npm run guardian:optimize`.
   - Verify: Candidate policies are scored against both synthetic AND real-user cases.
   - Verify: A candidate that fails a real-user case is not promoted.

8. **Backward compatibility:** Start session without specifying topic or mood.
   - Verify: Falls back to active policy bundle.
   - Verify: Focus scoring works identically to pre-refactor behavior.

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `src/lib/guardian-types.ts` | Add `WorkMode`, `SessionIntentProfile`, `LLMCalibrationSignal`, `dwellDepthTargetSeconds` threshold | O6A-1, O6B-1, O6D-2 |
| `src/lib/session-intent-resolver.ts` | **CREATE** — resolves intent at session start | O6A-2 |
| `src/lib/dynamic-policy-generator.ts` | **CREATE** — generates bespoke policy per session | O6A-3 |
| `src/lib/guardian-runtime.ts` | Wire dynamic policy into session start/tick, store intent profile | O6A-4, O6F-1 |
| `src/lib/guardian-calibration.ts` | Add `extractLLMCalibrationSignals()`, update `processSessionFeedback()` | O6B-2, O6B-3, O6E-2 |
| `src/lib/telegram-agent.ts` | Update `processSessionFeedback` call sites | O6B-4, O6F-2 |
| `src/lib/eval-case-extractor.ts` | **CREATE** — converts session traces to eval cases | O6C-1 |
| `src/lib/guardian-optimizer.ts` | Add real-user eval case source with 1.5x weight | O6C-3 |
| `src/lib/focus-score.ts` | Remove hardcoded numbers, use policy thresholds, add fatigue curve | O6D-2, O6D-3 |
| `src/lib/guardian-artifacts.ts` | Add `dwellDepthTargetSeconds: 180` to default bundle | O6D-2 |
| `src/lib/guardian-eval.ts` | Update `createEvalSession` to accept dynamic policy | O6C-3 |

## Execution Order

```
O6A-1 → O6A-2 → O6A-3 → O6A-4
                              ↓
O6B-1 → O6B-2 → O6B-3 → O6B-4
                              ↓
O6C-1 → O6C-2 → O6C-3
                        ↓
O6D-1 → O6D-2 → O6D-3
                        ↓
O6E-1 → O6E-2
              ↓
O6F-1 → O6F-2 → O6F-3
```

Each phase must pass its acceptance criteria before the next begins. No parallel edits on hot guardian files unless ownership is explicit. Build must pass after every subtask.

## Rollback Strategy

Every subtask is additive — new files, new fields, new function signatures with fallback defaults. If any subtask causes a regression:

1. The `sessionPolicy` and `intentProfile` fields are nullable on `GuardianState` — the system falls back to the existing active policy bundle.
2. The `extractLLMCalibrationSignals()` function falls back to the existing `extractSignals()` regex path.
3. The `dwellDepthTargetSeconds` threshold defaults to 180, preserving old behavior.
4. New eval cases are additive — they don't replace existing cases.

No DB migration is required. All new data fits in existing tables (`guardian_eval_cases`, `session_feedback`, `calibration_history`, `mem_facts`, `guardian_semantic_profiles`).
