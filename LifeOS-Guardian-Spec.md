**LifeOS**

Autonomous AI Guardian --- Full Implementation Spec

+-----------------------------------------------------------------------+
| *The guardian is silent when you\'re just living. It wakes the moment |
| you lock in.*                                                         |
|                                                                       |
| **Observe · Decide · Act · Reflect**                                  |
+-----------------------------------------------------------------------+

**Overview**

LifeOS is being transformed from a productivity dashboard into a
real-time AI guardian that runs alongside you during study sessions. It
watches, reads your behavioral signals, computes a live focus score, and
speaks at the right moments --- the way a Nike Run Club coach reads your
pace and speaks when it counts.

**Core principle:** The extension and agent are completely silent when
no session is active. No tab tracking, no AI calls, no data sent.
Guardian mode is a privilege the user explicitly grants.

  --------- ---------------------------------------------------------------------
  **KEY**   This is not a chatbot you talk to. It is a voice in your ear that
            reads you. Silence = trust. Jarvis speaks when it matters, not
            constantly.

  --------- ---------------------------------------------------------------------

**What changes from the original plan**

-   Tutor engine removed --- Jarvis does not answer questions, generate
    problems, or explain concepts

-   Agent loop is the centre of gravity --- observe, decide, act,
    reflect

-   Voice output is the primary interface during sessions, not the
    dashboard

-   Real-time SSE is the nervous system that connects everything

-   Focus score is a live 0--100 number, not an end-of-session grade

-   Timing governor ensures Jarvis never speaks too often

**Architecture --- 7 Layers**

  ------------------------ ----------------------------------------------
  **Layer**                **Purpose**

  0 --- Longitudinal       Always-on, no surveillance. Runs on historical
  intelligence             data between sessions. Detects goal drift,
                           energy patterns, schedule pressure.

  1 --- Input interfaces   Voice (Tier A: Web Speech API), Voice (Tier B:
                           Whisper local), Dashboard button, Schedule
                           trigger

  2 --- Intent + Emotion   Parses lock-in utterance. Extracts topic,
  engine                   duration, mood. Maps to knowledge graph.
                           Resolves ambiguity.

  3 --- Session            Activates guardian mode. Starts session
  orchestrator             record. Schedules check-ins. Opens SSE stream.

  4 --- Agent loop         The heartbeat. Runs every 30s during session.
                           Observe → Decide → Act → Reflect.

  5 --- Knowledge graph +  Mastery state per concept node. Personal
  behavioral memory        patterns, energy profile, tone preference.

  6 --- Self-evolution     Post-session recalibration. Updates focus
                           model, tone selector, threshold overrides.
  ------------------------ ----------------------------------------------

  -----------------------------------------------------------------------
  **Layer 0 --- Longitudinal Intelligence**

  -----------------------------------------------------------------------

Runs 24/7 on the Mac Mini. Never touches live browsing. Operates
entirely on data already in the database: session history, knowledge
graph state, daily plans, mood logs. This is what makes the guardian
feel like it knows you --- because it does.

**What it does**

-   Goal drift detection --- \"You listed ZK Proofs as priority 1 but
    have not touched it in 11 days\"

-   Energy forecasting --- builds a day-of-week, time-of-day
    productivity model from your session history

-   Schedule pressure detection --- reads exam dates or deadlines and
    computes coverage gap

-   Proactive daily message --- one message per day, morning. Not a push
    notification stream. One.

-   Pre-session briefing --- when lock-in starts, Jarvis opens with your
    current state: goal progress, last session performance, suggested
    focus for today

**New file --- src/lib/longitudinal-engine.ts**

+-----------------------------------------------------------------------+
| export interface DayBriefing {                                        |
|                                                                       |
| goalDriftWarnings: string\[\]; // goals not touched in N days         |
|                                                                       |
| energyForecast: \"high\" \| \"medium\" \| \"low\"; // based on time + |
| history                                                               |
|                                                                       |
| schedulePressure: PressureItem\[\];                                   |
|                                                                       |
| recommendedFocus: string; // top concept node to work on              |
|                                                                       |
| openingLine: string; // Jarvis pre-session speech                     |
|                                                                       |
| }                                                                     |
|                                                                       |
| export async function getDayBriefing(userId: string):                 |
| Promise\<DayBriefing\>                                                |
|                                                                       |
| export async function detectGoalDrift(userId: string):                |
| Promise\<string\[\]\>                                                 |
|                                                                       |
| export async function getEnergyForecast(userId: string, hour:         |
| number): Promise\<string\>                                            |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 1 --- Input Interfaces**

  -----------------------------------------------------------------------

**Tier A: Web Speech API (always available)**

Lightweight floating mic button. Zero cost. Runs natively in Chrome.
Handles all lock-in triggers and quick commands.

**New file --- src/components/VoiceButton.tsx**

-   Floating mic button, bottom-right corner of dashboard

-   Single press → listens → sends transcript to /api/jarvis/intent →
    speaks response via SpeechSynthesis

-   Wake phrases: \"hey lifeos\", \"let\'s lock in\", \"start
    studying\", \"lock in\"

-   All other speech → passed to intent engine for classification

**Tier B: Local Whisper (self-hosted, deep mode)**

Run whisper.cpp on the Mac Mini. No data leaves your network. Use for
extended voice conversations during sessions --- richer fidelity, better
accuracy on technical vocabulary (ZK proofs, polynomial commitments,
etc.).

**New file --- src/app/api/voice/transcribe/route.ts**

+-----------------------------------------------------------------------+
| // Accepts audio blob from browser                                    |
|                                                                       |
| // Pipes to local whisper.cpp via child_process                       |
|                                                                       |
| // Returns transcript                                                 |
|                                                                       |
| POST /api/voice/transcribe                                            |
|                                                                       |
| body: FormData { audio: Blob }                                        |
|                                                                       |
| returns: { transcript: string, confidence: number }                   |
+-----------------------------------------------------------------------+

  ---------- ---------------------------------------------------------------------
  **NOTE**   Do NOT use Gemini Live as the primary voice path. It creates vendor
             dependency and sends sensitive behavioral data to Google. Whisper +
             local TTS keeps everything on your Mac Mini.

  ---------- ---------------------------------------------------------------------

**TTS --- local voice output**

Use say (macOS built-in) for low latency, or Coqui TTS for higher
quality. Jarvis voice should be consistent --- pick one voice model and
keep it. The voice is part of the identity.

**New file --- src/lib/tts.ts**

+-----------------------------------------------------------------------+
| export async function speak(text: string, priority: \"normal\" \|     |
| \"urgent\" = \"normal\")                                              |
|                                                                       |
| // Queues speech. urgent = interrupts current speech.                 |
|                                                                       |
| // Never queues more than 2 messages --- drops oldest if queue full.  |
|                                                                       |
| // Prevents Jarvis from talking over itself.                          |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 2 --- Intent + Emotion Engine**

  -----------------------------------------------------------------------

Parses the lock-in utterance and extracts everything needed to start a
session. The user speaks naturally. The engine handles all the mapping.

**Intent extraction --- entities**

  --------------------- -------------------------------------------------
  **Entity**            **Example --- Fallback if missing**

  Topic / concept       \"polynomials IOP section\" --- Ask one targeted
                        question

  Goal mapping          Auto-inferred from knowledge graph --- Ask if two
                        candidates with equal recency

  Duration              \"90 minutes\" --- Jarvis suggests based on
                        energy forecast + topic complexity

  Mood / energy         \"I had a tiring day\" --- Default session plan;
                        no override

  Task link             \"finish my assignment on\...\" --- Create new
                        task or fuzzy-match existing
  --------------------- -------------------------------------------------

**Disambiguation rule**

If topic maps to more than one candidate node with similar recency,
Jarvis asks exactly one question. It surfaces both options by name and
asks which one. Never more than one clarifying question before starting.

**Emotion + energy handling**

Mood extracted from utterance is not just a one-time input --- it sets
the session\'s energy profile for the adaptive pacing engine. Examples:

-   \"I had a tiring day\" → shorter initial sprint (45 min), more break
    suggestions, softer tone

-   \"I\'m feeling sharp\" → 90-min default, fewer interruptions, push
    harder on drifts

-   No mood mentioned → use energy forecast from Layer 0 longitudinal
    engine

**New file --- src/lib/intent-engine.ts**

+-----------------------------------------------------------------------+
| export interface LockInIntent {                                       |
|                                                                       |
| rawTranscript: string;                                                |
|                                                                       |
| topic: string;                                                        |
|                                                                       |
| goalId: string \| null;                                               |
|                                                                       |
| conceptNodeId: string \| null;                                        |
|                                                                       |
| durationMinutes: number;                                              |
|                                                                       |
| mood: \"high\" \| \"medium\" \| \"low\" \| null;                      |
|                                                                       |
| taskId: string \| null;                                               |
|                                                                       |
| ambiguous: boolean;                                                   |
|                                                                       |
| clarifyQuestion: string \| null;                                      |
|                                                                       |
| }                                                                     |
|                                                                       |
| export async function parseLockInIntent(transcript: string, userId:   |
| string): Promise\<LockInIntent\>                                      |
|                                                                       |
| export async function resolveAmbiguity(transcript: string,            |
| candidates: ConceptNode\[\]): Promise\<string\>                       |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 3 --- Session Orchestrator**

  -----------------------------------------------------------------------

Once intent is resolved, the orchestrator takes over. It does everything
autonomously --- the user said \"lock in\", everything else is handled.

**Lock-in sequence (fully automated)**

1.  Map topic → goal → concept node in knowledge graph

2.  Create session record with sessionId, goalId, conceptNodeId,
    durationMinutes, mood, startTime

3.  Activate extension guardian mode via message to background.js

4.  Open SSE stream --- dashboard subscribes immediately

5.  Schedule check-in notifications at duration/2 and duration \* 0.8

6.  Speak opening line from Layer 0 briefing

7.  Hand off to agent loop (Layer 4)

**Session states**

  ---------------- ------------------------------------------------------
  **State**        **Description**

  INACTIVE         Default. Extension silent. No tracking. No AI calls.

  SOFT_WATCH       User said they\'ll study today but hasn\'t locked in.
                   Gentle reminders only. No tab tracking.

  ACTIVE           Full guardian mode. Tab tracking + blocking +
                   auto-classify + agent loop running.

  BREAK            Session paused. Tabs unblocked. Break timer running.
                   Returns to ACTIVE automatically.

  COMPLETE         Session ended. Reflect loop running. Graph updating.
  ---------------- ------------------------------------------------------

**Modified file --- src/app/api/sessions/route.ts**

Add startGuardianMode() and endGuardianMode() that toggle extension
state, open/close SSE stream, and trigger longitudinal engine refresh.

**New file --- src/app/api/agent/stream/route.ts**

SSE endpoint. Dashboard connects on session start. Receives guardian
events in real time.

+-----------------------------------------------------------------------+
| GET /api/agent/stream?sessionId=xxx                                   |
|                                                                       |
| // Event types streamed:                                              |
|                                                                       |
| { type: \"focus_score\", score: number, delta: number }               |
|                                                                       |
| { type: \"jarvis_speech\", text: string, tone: string }               |
|                                                                       |
| { type: \"intervention\", action: \"nudge\"\|\"block\"\|\"classify\", |
| payload: object }                                                     |
|                                                                       |
| { type: \"milestone\", label: string }                                |
|                                                                       |
| { type: \"session_stats\", elapsed: number, onTopicTime: number,      |
| distractions: number }                                                |
|                                                                       |
| { type: \"check_in\", message: string }                               |
|                                                                       |
| { type: \"session_end\", summary: SessionSummary }                    |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 4 --- Agent Loop (The Heartbeat)**

  -----------------------------------------------------------------------

This is the core. Runs every 30 seconds during an active session. The
entire intelligence of the guardian lives here. Everything is
session-scoped --- the loop does not run when no session is active.

**4A --- Observe**

Collects all available behavioral signals at the current tick. Builds a
SessionState snapshot.

**Signal sources**

  ---------------------- ------------------------------------------------
  **Signal**             **Source --- What it tells you**

  Current URL + title    Extension background.js --- on-topic,
                         distraction, or unknown

  Dwell time on current  Extension tab timer --- deep reading vs skim vs
  page                   stuck

  Tab switch count (last Extension event log --- scattered vs focused
  5 min)                 

  Distraction site       Session log --- is this person fighting the same
  revisit count          pull repeatedly

  Idle time              Extension inactivity detector --- away, stuck,
                         or overwhelmed

  Time elapsed vs        Session record --- pace, urgency, check-in
  planned                proximity

  Focus score history    Agent memory --- trend: rising, stable, or
  (last 10 ticks)        falling

  Behavioral memory      src/lib/behavior.ts --- personal thresholds,
                         energy profile
  ---------------------- ------------------------------------------------

**SessionState schema**

+-----------------------------------------------------------------------+
| export interface SessionState {                                       |
|                                                                       |
| sessionId: string;                                                    |
|                                                                       |
| tick: number; // incrementing heartbeat count                         |
|                                                                       |
| currentUrl: string;                                                   |
|                                                                       |
| currentTitle: string;                                                 |
|                                                                       |
| urlClassification: \"on_topic\" \| \"distraction\" \| \"unknown\";    |
|                                                                       |
| dwellSeconds: number; // time on current page                         |
|                                                                       |
| tabSwitchesLast5Min: number;                                          |
|                                                                       |
| distractionRevisits: number; // same distraction domain count this    |
| session                                                               |
|                                                                       |
| idleSeconds: number;                                                  |
|                                                                       |
| elapsedMinutes: number;                                               |
|                                                                       |
| plannedMinutes: number;                                               |
|                                                                       |
| focusScore: number; // 0--100 live                                    |
|                                                                       |
| focusScoreHistory: number\[\]; // last 10 ticks                       |
|                                                                       |
| focusTrend: \"rising\" \| \"stable\" \| \"falling\";                  |
|                                                                       |
| energyLevel: \"high\" \| \"medium\" \| \"low\";                       |
|                                                                       |
| mood: string \| null;                                                 |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**4B --- Focus Score Algorithm**

  ---------- ---------------------------------------------------------------------
  **CRIT**   This is the most important number in the system. It must feel
             accurate. If it feels off, the user stops trusting Jarvis.

  ---------- ---------------------------------------------------------------------

Focus score is a weighted composite of behavioral signals. Computed
every tick. Displayed live on dashboard. Referenced in every Jarvis
message.

**Score components**

  --------------------- ------------ ---------------------------------------
  **Component**         **Weight**   **Calculation**

  On-topic continuity   35%          Seconds on-topic this session ÷ total
                                     elapsed seconds

  Tab switch rate       25%          Inverse of switches/min. 0 switches =
                                     100. \>3/min = 0.

  Dwell depth           20%          Average dwell time per on-topic page.
                                     \>3 min = 100. \<30s = 0.

  Distraction revisit   15%          Each revisit to same distraction domain
  penalty                            = -8 points

  Idle penalty          5%           \>5 min idle = -15. \>10 min = -30.
  --------------------- ------------ ---------------------------------------

**Focus trend detection**

+-----------------------------------------------------------------------+
| // Compare current score to mean of last 10 ticks                     |
|                                                                       |
| if (current \> mean + 5) trend = \"rising\"                           |
|                                                                       |
| if (current \< mean - 5) trend = \"falling\"                          |
|                                                                       |
| else trend = \"stable\"                                               |
|                                                                       |
| // Trend is used by Decide layer to determine urgency of intervention |
+-----------------------------------------------------------------------+

**4C --- Decide**

The intelligence layer. Given the current SessionState, determines the
right action. The decision table is ordered by priority --- only the
first matching rule fires per tick.

**Decision table (evaluated top-to-bottom)**

  ------------------------ ---------------------- -----------------------
  **Condition**            **Action**             **Tone**

  distraction revisits ≥ 3 Block + speak          Direct push
  in 10 min                                       

  tabSwitches \> 4 in 5    Block + speak          Firm warning
  min AND on distraction                          

  tabSwitches \> 6 in 5    Speak only             Grounding nudge
  min (any sites)                                 

  idle \> 8 min during     Speak + ping extension Check-in concern
  session                                         

  focusScore drops \> 15   Speak only             Motivational push
  pts in 3 ticks                                  

  focusTrend = falling AND Speak only             Break suggestion
  score \< 60                                     

  elapsed = plannedMinutes Speak --- midpoint     Celebratory update
  × 0.5                    check-in               

  elapsed = plannedMinutes Speak --- closing      Final push
  × 0.8                    sprint                 

  on-topic url, dwell \> 4 Auto-classify + silent None
  min, score \> 85         mastery update         

  focus rising AND score   Speak --- flow         Celebratory
  \> 88 for 3+ ticks       confirmation           

  session personal best    Speak --- milestone    Celebratory
  focus score reached                             

  none of the above        Silence                ---
  ------------------------ ---------------------- -----------------------

**Timing governor --- the silence rule**

  ---------- ---------------------------------------------------------------------
  **RULE**   Minimum 90 seconds between any two Jarvis speech events.
             Block/extension actions are exempt. Silence is always considered
             first. If the focus score is \> 85 and stable, Jarvis never
             interrupts.

  ---------- ---------------------------------------------------------------------

+-----------------------------------------------------------------------+
| const SPEECH_COOLDOWN_MS = 90_000                                     |
|                                                                       |
| const FLOW_SILENCE_THRESHOLD = 85 // never interrupt if score \> this |
|                                                                       |
| function shouldSpeak(state: SessionState, lastSpeechAt: number):      |
| boolean {                                                             |
|                                                                       |
| const cooldownPassed = Date.now() - lastSpeechAt \>                   |
| SPEECH_COOLDOWN_MS                                                    |
|                                                                       |
| const notInFlow = state.focusScore \< FLOW_SILENCE_THRESHOLD          |
|                                                                       |
| return cooldownPassed && notInFlow                                    |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**4D --- Act**

Executes the decided action. Three output channels: voice, SSE,
extension.

**Action types**

  ------------------ ----------------------------------------------------
  **Action**         **Implementation**

  speak(text, tone)  Calls tts.speak(). Streams speech event via SSE.
                     Logs to session record.

  block(reason)      Posts to extension via /api/extension/command. SSE
                     event to dashboard.

  classify(url,      Calls auto-mapper. Updates mastery. SSE event with
  nodeId)            node name.

  nudge(text)        SSE notification only --- no voice. Used for
                     low-priority pings.

  silence()          Logs decision to reflect memory. No output. Valid
                     action, not a failure.
  ------------------ ----------------------------------------------------

**Voice message construction**

Messages are generated by the LLM but templated by tone. The score and
session stats are injected. The message is always short --- one or two
sentences maximum. Jarvis does not explain itself.

+-----------------------------------------------------------------------+
| const toneTemplates = {                                               |
|                                                                       |
| flow_confirmed: \"Locked in. {elapsed} clean minutes. Keep this       |
| pace.\",                                                              |
|                                                                       |
| direct_push: \"You\'ve hit {site} {count} times. Push through the     |
| next 10.\",                                                           |
|                                                                       |
| grounding_nudge: \"You\'re scattered. Close the other tabs. One       |
| thing.\",                                                             |
|                                                                       |
| break_suggestion: \"You\'re slowing down. Take {breakMins} minutes,   |
| then finish.\",                                                       |
|                                                                       |
| midpoint_checkin: \"Halfway. Score {score} --- {comparison}.          |
| {remaining} more.\",                                                  |
|                                                                       |
| final_push: \"{remaining} minutes left. Finish what you started.\",   |
|                                                                       |
| personal_best: \"That\'s your best session on this topic. Remember    |
| this feeling.\",                                                      |
|                                                                       |
| session_end: \"{elapsed} minutes. Score {score}. {topicName} covered. |
| That\'s a locked-in session.\",                                       |
|                                                                       |
| }                                                                     |
|                                                                       |
| // {comparison} = \"one of your best this month\" \| \"strong         |
| session\" \| \"above your average\"                                   |
|                                                                       |
| // Pulled from behavioral memory --- always specific, never generic   |
+-----------------------------------------------------------------------+

**4E --- Reflect**

Runs once at session end. Reconciles what happened against what was
planned. Updates all memory systems.

+-----------------------------------------------------------------------+
| export async function runSessionReflection(session: CompletedSession) |
| {                                                                     |
|                                                                       |
| // 1. Compute final focus score and session quality                   |
|                                                                       |
| const quality = computeSessionQuality(session)                        |
|                                                                       |
| // 2. Update behavioral memory (confidence-weighted)                  |
|                                                                       |
| await updateBehavioralMemory(session, quality)                        |
|                                                                       |
| // 3. Update mastery on mapped concept node                           |
|                                                                       |
| await updateMastery(session.conceptNodeId, session.elapsedMinutes,    |
| quality)                                                              |
|                                                                       |
| // 4. Recalibrate tone selector if 5+ sessions since last calibration |
|                                                                       |
| if (shouldRecalibrateTone(session.userId)) await                      |
| recalibrateTone(session.userId)                                       |
|                                                                       |
| // 5. Speak session end summary                                       |
|                                                                       |
| await speak(buildEndSummary(session, quality))                        |
|                                                                       |
| // 6. Store reflection record for longitudinal engine                 |
|                                                                       |
| await saveReflection(session, quality)                                |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 5 --- Knowledge Graph + Behavioral Memory**

  -----------------------------------------------------------------------

**5A --- Knowledge Graph**

The brain of the system. Every concept you study lives here. The agent
loop updates it in real time during sessions. The longitudinal engine
reads it between sessions.

**Node schema**

+-----------------------------------------------------------------------+
| interface ConceptNode {                                               |
|                                                                       |
| id: string                                                            |
|                                                                       |
| goalId: string                                                        |
|                                                                       |
| name: string                                                          |
|                                                                       |
| masteryScore: number // 0.0 -- 1.0                                    |
|                                                                       |
| lastStudied: Date \| null                                             |
|                                                                       |
| totalStudyMinutes: number                                             |
|                                                                       |
| prerequisites: string\[\] // other node IDs that must be ≥ 0.4        |
| mastery first                                                         |
|                                                                       |
| decayRate: number // mastery decay per day without study (default     |
| 0.02)                                                                 |
|                                                                       |
| bloomLevel: 1\|2\|3\|4\|5\|6 // 1=Remember → 6=Create                 |
|                                                                       |
| }                                                                     |
+-----------------------------------------------------------------------+

**Mastery update formula**

Mastery is not a raw counter. It is quality-weighted and time-decayed.
The active recall multiplier is the most important factor --- if you can
answer a check-in question about the node, the update is doubled.

+-----------------------------------------------------------------------+
| // Base increment per activity type                                   |
|                                                                       |
| const BASE_INCREMENT = {                                              |
|                                                                       |
| reading: 0.04, // passive                                             |
|                                                                       |
| watching: 0.05, // slightly more active                               |
|                                                                       |
| note_taking: 0.10, // active                                          |
|                                                                       |
| problem_solving: 0.20, // most active                                 |
|                                                                       |
| }                                                                     |
|                                                                       |
| // Final formula                                                      |
|                                                                       |
| const increment =                                                     |
|                                                                       |
| BASE_INCREMENT\[activityType\]                                        |
|                                                                       |
| \* qualityMultiplier // 0.5 -- 1.5 based on session focus score       |
|                                                                       |
| \* Math.min(studyMinutes / 30, 2.0) // capped time multiplier         |
|                                                                       |
| // Daily decay (runs in background job)                               |
|                                                                       |
| node.masteryScore \*= (1 - node.decayRate)                            |
+-----------------------------------------------------------------------+

**5B --- Behavioral Memory**

Stores everything Jarvis learns about you. Confidence-weighted and
time-decaying. An observation from 6 months ago has less weight than
last week.

**Memory schema**

+-----------------------------------------------------------------------+
| interface BehavioralMemoryEntry {                                     |
|                                                                       |
| type: MemoryType                                                      |
|                                                                       |
| value: string \| number                                               |
|                                                                       |
| confidence: number // 0.0 -- 1.0, increases with repeated observation |
|                                                                       |
| lastObserved: Date                                                    |
|                                                                       |
| observationCount: number                                              |
|                                                                       |
| }                                                                     |
|                                                                       |
| type MemoryType =                                                     |
|                                                                       |
| \| \"optimal_session_duration\" // minutes                            |
|                                                                       |
| \| \"peak_energy_hour\" // 0--23                                      |
|                                                                       |
| \| \"preferred_break_length\" // minutes                              |
|                                                                       |
| \| \"focus_threshold_deep\" // min dwell time to count as deep work   |
|                                                                       |
| \| \"coaching_style\" // \"direct\" \| \"encouraging\" \|             |
| \"data_driven\"                                                       |
|                                                                       |
| \| \"flow_score_baseline\" // personal average when fully focused     |
|                                                                       |
| \| \"distraction_wall_pattern\" // time into session when drift       |
| typically starts                                                      |
+-----------------------------------------------------------------------+

**Confidence update rule**

+-----------------------------------------------------------------------+
| // Each new observation moves confidence toward observed value        |
|                                                                       |
| // Bayesian-style weighted update                                     |
|                                                                       |
| entry.confidence = (entry.confidence \* entry.observationCount +      |
| newObservation)                                                       |
|                                                                       |
| / (entry.observationCount + 1)                                        |
|                                                                       |
| entry.observationCount += 1                                           |
|                                                                       |
| entry.lastObserved = new Date()                                       |
|                                                                       |
| // Time decay: confidence halves every 60 days without new            |
| observation                                                           |
|                                                                       |
| // Applied in background job nightly                                  |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Layer 6 --- Self-Evolution Engine**

  -----------------------------------------------------------------------

After every session, the agent reflects and updates itself. After every
5 sessions, it recalibrates its tone model. The system becomes more
accurate over time --- not in a vague \"AI learns\" way, but in
specific, auditable ways.

**What specifically changes after each session**

  -------------------------- ----------------------------------------------
  **What changes**           **How**

  optimal_session_duration   If session completed with score \> 80, update
                             with confidence += 0.1

  distraction_wall_pattern   Log the elapsed minute when focus first
                             dropped below 70. Average over sessions.

  coaching_style             Every 5 sessions, compare focus scores under
                             \"direct\" vs \"encouraging\" tone. Keep the
                             winner.

  flow_score_baseline        Rolling average of top-10% session scores.
                             Used to calibrate \"one of your best\"
                             threshold.

  peak_energy_hour           Log start hour of sessions with score \> 85.
                             Mode of last 20 = peak energy hour.
  -------------------------- ----------------------------------------------

**Explainability log**

  --------- ---------------------------------------------------------------------
  **KEY**   Every Jarvis suggestion must be auditable. The user can tap any
            suggestion and see the reasoning. This builds trust. Without this,
            adaptive AI feels creepy, not helpful.

  --------- ---------------------------------------------------------------------

+-----------------------------------------------------------------------+
| interface ExplainabilityEntry {                                       |
|                                                                       |
| sessionId: string                                                     |
|                                                                       |
| action: string // what Jarvis said or did                             |
|                                                                       |
| reason: string // human-readable: \"Your last 3 sessions of 90 min    |
| had focus \> 85\"                                                     |
|                                                                       |
| dataPoints: string\[\] // specific observations that led to this      |
|                                                                       |
| confidence: number                                                    |
|                                                                       |
| timestamp: Date                                                       |
|                                                                       |
| }                                                                     |
|                                                                       |
| // Stored per session. Accessible from dashboard.                     |
|                                                                       |
| // Jarvis never says \"I think\" --- it says \"Based on your last 8   |
| sessions\...\"                                                        |
+-----------------------------------------------------------------------+

**Modified file --- src/lib/behavior.ts**

-   Add getAdaptiveThresholds() --- replaces all hardcoded constants
    with behavioral memory lookups

-   Add runSelfCalibration() --- runs post-session, updates memory with
    confidence weighting

-   Add getExplainabilityText(action) --- generates the \"why did Jarvis
    say this\" explanation

  -----------------------------------------------------------------------
  **Extension --- Guardian Mode Only**

  -----------------------------------------------------------------------

  ---------- ---------------------------------------------------------------------
  **CRIT**   Remove ALL passive monitoring. Every listener that fires when no
             session is active must be stripped. This is a privacy guarantee, not
             a feature flag.

  ---------- ---------------------------------------------------------------------

**Modified file --- extension/background.js**

Current state: the extension polls context and sends data on every tab
update. This must change.

+-----------------------------------------------------------------------+
| // REMOVE: activeContext, refreshContext(), any polling outside       |
| session                                                               |
|                                                                       |
| // REMOVE: chrome.tabs.onUpdated listener firing when session is      |
| inactive                                                              |
|                                                                       |
| // NEW pattern:                                                       |
|                                                                       |
| let guardianActive = false                                            |
|                                                                       |
| chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =\> {      |
|                                                                       |
| if (!guardianActive) return // hard stop --- zero processing          |
|                                                                       |
| if (changeInfo.status !== \"complete\") return                        |
|                                                                       |
| reportTabActivity(tab.url, tab.title)                                 |
|                                                                       |
| })                                                                    |
|                                                                       |
| chrome.runtime.onMessage.addListener((msg) =\> {                      |
|                                                                       |
| if (msg.type === \"START_GUARDIAN\") { guardianActive = true;         |
| sessionContext = msg.context }                                        |
|                                                                       |
| if (msg.type === \"STOP_GUARDIAN\") { guardianActive = false;         |
| sessionContext = null }                                               |
|                                                                       |
| })                                                                    |
+-----------------------------------------------------------------------+

**New file --- extension/guardian.js**

-   Tab activity reporter --- sends URL + title + dwell time to
    /api/agent/tab-event

-   Idle detector --- uses chrome.idle API, reports to agent loop

-   Block overlay --- renders when agent loop fires a block action

-   Auto-classify handler --- receives nodeId from server, shows brief
    \"Studying: \[concept\]\" overlay for 3 seconds

  -----------------------------------------------------------------------
  **SSE Architecture --- The Nervous System**

  -----------------------------------------------------------------------

SSE is the wire that connects everything. The dashboard subscribes once
on session start and receives a live stream for the entire session. The
agent loop writes to it. The extension writes to it. The voice system
reads from it.

**Connection lifecycle**

+-----------------------------------------------------------------------+
| // 1. Session starts → server opens SSE channel keyed to sessionId    |
|                                                                       |
| // 2. Dashboard connects: GET /api/agent/stream?sessionId=xxx         |
|                                                                       |
| // 3. Extension connects: lightweight POST /api/agent/tab-event (not  |
| SSE)                                                                  |
|                                                                       |
| // 4. Agent loop reads tab events → decides → writes to SSE channel   |
|                                                                       |
| // 5. Dashboard receives events → updates live focus score + renders  |
| Jarvis messages                                                       |
|                                                                       |
| // 6. Session ends → SSE channel closed → dashboard shows session     |
| summary                                                               |
+-----------------------------------------------------------------------+

**Dashboard real-time UI --- src/components/GuardianDashboard.tsx**

This is the live session view. Not a static page --- it pulses with the
session.

-   Large live focus score (0--100) in the centre. Color transitions:
    green \> 80, amber 60--80, red \< 60

-   Focus score sparkline --- last 20 ticks, so you can see the trend at
    a glance

-   Jarvis message feed --- last 3 messages, newest on top, with tone
    badge (push / celebrate / warn)

-   Session timer + on-topic time percentage

-   Current concept node being studied

-   Distraction count for session (not prominent --- informational only)

  -------- ---------------------------------------------------------------------
  **UX**   The dashboard should feel like a cockpit, not a report card.
           Everything is live. The user glances at it, gets the picture, looks
           back at their work.

  -------- ---------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Complete File Change Map**

  -----------------------------------------------------------------------

**New files**

  --------------------------------------- ---------- ------------------------------------
  **File**                                **Type**   **Purpose**

  src/lib/agent-loop.ts                   NEW        Core heartbeat: observe, decide,
                                                     act, reflect

  src/lib/intent-engine.ts                NEW        Parse lock-in utterance, extract
                                                     entities

  src/lib/longitudinal-engine.ts          NEW        Between-session intelligence, day
                                                     briefing

  src/lib/focus-score.ts                  NEW        Live focus score computation

  src/lib/tts.ts                          NEW        TTS abstraction, speech queue,
                                                     speak()

  src/lib/auto-mapper.ts                  NEW        URL + title → concept node mapping

  src/app/api/agent/stream/route.ts       NEW        SSE endpoint for live dashboard

  src/app/api/agent/tab-event/route.ts    NEW        Receives tab activity from extension

  src/app/api/agent/heartbeat/route.ts    NEW        Internal: triggers agent loop tick

  src/app/api/voice/transcribe/route.ts   NEW        Whisper local STT endpoint

  src/components/VoiceButton.tsx          NEW        Floating mic button, Tier A voice

  src/components/GuardianDashboard.tsx    NEW        Live session view, SSE consumer

  extension/guardian.js                   NEW        Tab reporting, block overlay, idle
                                                     detection
  --------------------------------------- ---------- ------------------------------------

**Modified files**

  ------------------------------- ---------- ------------------------------------
  **File**                        **Type**   **Change**

  src/lib/behavior.ts             MODIFY     Add getAdaptiveThresholds(),
                                             runSelfCalibration(),
                                             getExplainabilityText()

  src/app/api/sessions/route.ts   MODIFY     Add startGuardianMode(),
                                             endGuardianMode()

  src/app/api/chat/route.ts       MODIFY     Add Jarvis tools: startFocusSession,
                                             mapTopicToGraph,
                                             getStudyRecommendation

  extension/background.js         MODIFY     Remove all passive monitoring.
                                             Session-scoped only.
  ------------------------------- ---------- ------------------------------------

  -----------------------------------------------------------------------
  **Database Schema Changes**

  -----------------------------------------------------------------------

**New tables**

+-----------------------------------------------------------------------+
| \-- Session heartbeat log (one row per agent loop tick)               |
|                                                                       |
| CREATE TABLE session_ticks (                                          |
|                                                                       |
| id uuid PRIMARY KEY DEFAULT gen_random_uuid(),                        |
|                                                                       |
| session_id uuid REFERENCES sessions(id),                              |
|                                                                       |
| tick int,                                                             |
|                                                                       |
| focus_score float,                                                    |
|                                                                       |
| url text,                                                             |
|                                                                       |
| classification text, \-- on_topic \| distraction \| unknown           |
|                                                                       |
| action_taken text, \-- speak \| block \| classify \| silence          |
|                                                                       |
| created_at timestamptz DEFAULT now()                                  |
|                                                                       |
| );                                                                    |
|                                                                       |
| \-- Behavioral memory                                                 |
|                                                                       |
| CREATE TABLE behavioral_memory (                                      |
|                                                                       |
| id uuid PRIMARY KEY DEFAULT gen_random_uuid(),                        |
|                                                                       |
| user_id uuid REFERENCES users(id),                                    |
|                                                                       |
| type text NOT NULL,                                                   |
|                                                                       |
| value text NOT NULL,                                                  |
|                                                                       |
| confidence float DEFAULT 0.5,                                         |
|                                                                       |
| obs_count int DEFAULT 1,                                              |
|                                                                       |
| last_observed timestamptz DEFAULT now(),                              |
|                                                                       |
| UNIQUE(user_id, type)                                                 |
|                                                                       |
| );                                                                    |
|                                                                       |
| \-- Explainability log                                                |
|                                                                       |
| CREATE TABLE jarvis_explanations (                                    |
|                                                                       |
| id uuid PRIMARY KEY DEFAULT gen_random_uuid(),                        |
|                                                                       |
| session_id uuid REFERENCES sessions(id),                              |
|                                                                       |
| action text,                                                          |
|                                                                       |
| reason text,                                                          |
|                                                                       |
| data_points jsonb,                                                    |
|                                                                       |
| confidence float,                                                     |
|                                                                       |
| created_at timestamptz DEFAULT now()                                  |
|                                                                       |
| );                                                                    |
+-----------------------------------------------------------------------+

  -----------------------------------------------------------------------
  **Build Order --- Implementation Sequence**

  -----------------------------------------------------------------------

Build in this order. Each phase is independently testable. Do not start
Phase 2 until Phase 1 is verified.

**Phase 1 --- Foundation (Week 1--2)**

8.  Strip extension passive monitoring --- verify zero network calls
    when session inactive

9.  Build focus-score.ts with mock data --- validate score feels
    accurate against real browsing

10. Build SSE endpoint --- verify dashboard receives live events

11. Build session state machine (INACTIVE → ACTIVE → BREAK → COMPLETE)

**Phase 2 --- Agent Loop (Week 3--4)**

12. Build observe() --- wire extension tab events to SessionState

13. Build decide() --- implement decision table, timing governor,
    silence logic

14. Build act() --- voice output, SSE events, extension block commands

15. Build GuardianDashboard.tsx --- live focus score, Jarvis feed,
    session stats

16. End-to-end test: lock in → session runs → Jarvis speaks → session
    ends

**Phase 3 --- Intelligence (Week 5--6)**

17. Build intent-engine.ts --- lock-in utterance parsing

18. Build VoiceButton.tsx --- Tier A voice with wake phrase detection

19. Wire local Whisper endpoint --- Tier B voice

20. Build longitudinal-engine.ts --- daily briefing, goal drift
    detection

21. Build reflect() + self-calibration

**Phase 4 --- Evolution (Week 7+)**

22. Build behavioral memory with confidence weighting and time decay

23. Build tone selector backed by behavioral memory

24. Build explainability log + UI to surface it

25. A/B test coaching styles across real sessions

26. Tune focus score weights against actual session feel

  ---------- ---------------------------------------------------------------------
  **NOTE**   Phase 4 is ongoing, not a one-time build. The self-evolution engine
             is never \"done\" --- it improves with every session you run.

  ---------- ---------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Verification Checklist**

  -----------------------------------------------------------------------

**Session off (default state)**

-   Open Reddit, YouTube, Twitter --- zero extension activity (confirm
    in Chrome DevTools Network tab)

-   Confirm background.js sends nothing to server

-   Confirm no agent loop ticks are firing

**Lock-in flow**

-   \"Let\'s lock in on finite fields\" → Jarvis leads conversation →
    session starts with correct node mapped

-   \"I had a tiring day\" → session defaults to 45-min, softer tone
    preset

-   Jarvis speaks opening line with context from longitudinal briefing

**Active session --- guardian mode**

-   Open YouTube → block overlay appears → Jarvis speaks within 90s

-   Return to study material → block clears → focus score begins
    recovering

-   Stay on-topic for 15 min → Jarvis speaks flow confirmation (only
    once, then silent)

-   Check live dashboard --- focus score updating every 30s, sparkline
    visible

-   Midpoint hit → Jarvis speaks check-in with score and comparison to
    history

**Session end and reflect**

-   Session ends → Jarvis speaks summary with exact minutes and focus
    score

-   Knowledge graph node mastery updated correctly

-   behavioral_memory table has new or updated entries

-   session_ticks table shows full heartbeat log

**Self-evolution (after 5+ sessions)**

-   behavioral_memory.coaching_style updated if tone data sufficient

-   optimal_session_duration confidence increasing

-   Jarvis opening line references your actual history, not generic text

*The goal is not a smarter dashboard.*

*It is an entity that knows you, watches over you, and pushes you to
become the person you said you want to be.*
