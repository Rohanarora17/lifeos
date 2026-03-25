# **The Architecture of Autonomous Cognitive Assistants: Designing the Next-Generation LifeOS**

The evolution of artificial intelligence from stateless, conversational oracles to persistent, autonomous personal assistants marks a paradigm shift in cognitive computing. A sophisticated "LifeOS"—acting as a productivity guardian—requires an architecture that far exceeds standard Retrieval-Augmented Generation (RAG). It demands a rigorous synthesis of cognitive neuroscience, real-time statistical anomaly detection, and highly optimized local data structures. By mimicking biological memory consolidation, mirroring human psychological processes like dual-process theory, and executing operations entirely within a secure, local-first ecosystem, systems can achieve unparalleled contextual awareness. This comprehensive architectural analysis delineates the absolute industry standard for designing the memory, intelligence, and implementation layers of a production-grade personal AI assistant as of March 2026\.

## **Part 1 — Memory Architecture**

## **1.1 The Canonical Four-Tier Memory Architecture**

The prevailing standard for agentic memory relies heavily on cognitive architectures originally derived from frameworks such as SOAR and recent adaptations like CoALA (Cognitive Architectures for Language Agents).1 To mitigate catastrophic context degradation ("context pollution") and support continuous learning, modern agents stratify data into a canonical four-tier structure: Working, Episodic, Semantic, and Procedural memory.1

Working memory serves as the volatile computational scratchpad, mapped directly to the language model's active context window. It holds immediate conversational context, current task state, and system instructions, functioning akin to human short-term memory.3 Episodic memory operates as a chronological ledger, recording specific, timestamped events, actions, and observations with high contextual fidelity.3 Semantic memory represents the crystallized knowledge base—facts, entity relationships, and user preferences distilled from past experiences, stripped of temporal metadata for broader application.3 Procedural memory encodes the agent's executable skills, learned heuristics, and automated workflows, mirroring human unconscious competence.3

The industry's leading platforms implement these tiers with varying focal points. Mem0 excels in transforming episodic interactions into a robust semantic vector and graph hybrid.10 MemGPT (now Letta) pioneered the operating-system metaphor, focusing heavily on managing working memory via paging mechanisms to external archival storage.12 Zep focuses on temporal semantic memory, representing knowledge as a bi-temporal graph that tracks state changes over time.14 OpenAI's native memory offers a generalized, opaque semantic key-value store, while Cognee builds rigid, GraphRAG-based semantic pipelines for complex institutional knowledge.16

| Memory Tier | Cognitive Function | AI System Analogue | Leading Implementation Focus |
| :---- | :---- | :---- | :---- |
| **Working** | Immediate task execution, temporary scratchpad | Context window, prompt payload | Letta (Core Memory Blocks) |
| **Episodic** | Chronological event recall | Event logs, temporal databases | Zep (Temporal Knowledge Graph) |
| **Semantic** | Generalized facts, user preferences | Vector DB, Knowledge Graph | Mem0 (Entity/Triplet Extraction) |
| **Procedural** | Executable skills, workflows | Code generation, Tool scripts | Memp (Distilled Action Macros) |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Stratify agent memory into distinct data stores to prevent context window saturation.  
  * Reserve the active context strictly for Working Memory (system rules, current state).  
  * Utilize Episodic Memory for audit trails and temporal reasoning.  
  * Employ Semantic Memory for fuzzy retrieval of cross-session facts and preferences.  
  * Develop Procedural Memory to bypass costly step-by-step reasoning for repeated tasks.  
* **Citations:** 1  
* **Production vs. Experimental:** Semantic and Episodic separation is a mature, production-ready standard. Procedural memory (self-updating code/macros) remains highly experimental and requires strict deterministic sandboxing.  
* **LifeOS Recommendation:** Implement the four tiers via distinct SQLite tables. Map Working Memory directly to the Gemini prompt state. Store raw telemetry (focus session durations, browsing habits) in the Episodic table, extract user habits into the Semantic table, and hardcode coaching interventions as scriptable rules in the Procedural table.

## **1.2 Fact Extraction, Conflict Resolution, and Deduplication in Mem0**

Mem0 fundamentally reimagines semantic memory maintenance by deploying Large Language Models (LLMs) as active memory managers rather than passive text embedders.10 Its architecture relies on a highly structured two-phase pipeline: Extraction and Update.11 During the Extraction Phase, Mem0 ingests the latest message pair alongside a rolling summary and a sliding window of recent history. An LLM explicitly identifies salient entities and constructs candidate facts or relationships (triplets) without blocking the primary conversational thread.11

The critical innovation occurs during the Update Phase. Mem0 does not blindly append new vectors to a database; instead, it queries the existing database for semantic neighbors to the newly extracted fact.11 An LLM-powered Conflict Detector evaluates the candidate against existing knowledge to deterministically trigger one of four operations: ADD (new information), UPDATE (evolving an existing fact, e.g., changing a user's location), DELETE (removing contradictory data), or NOOP (ignoring redundant data).11 This explicitly prevents the context pollution and deduplication failures inherent in naive RAG systems.

Internally, Mem0 utilizes a dual-model structure: standard Mem0 relies on dense vector embeddings, while Mem0g (the graph variant) translates entities into Neo4j-style nodes and labeled edges.11 Importance scoring is achieved through composite metrics factoring in relevance, user intent, and explicit saving directives.11 In empirical testing on the LOCOMO (LLM-based COgnitive MeMOry) benchmark, this selective pipeline achieves a 26% higher response accuracy than OpenAI's built-in memory, slashes the 95th-percentile latency by 91% (1.44s vs. 17.12s), and reduces token consumption by over 90% by feeding the LLM highly compressed truths rather than raw conversation logs.11

| Feature | OpenAI Memory | Mem0 (Vector) | Mem0g (Graph) |
| :---- | :---- | :---- | :---- |
| **Data Model** | Opaque Key-Value / Vector | Abstracted Vector DB | Vector \+ Knowledge Graph |
| **Conflict Handling** | Implicit overwrites | Explicit ADD/UPDATE/DELETE | Edge invalidation |
| **LOCOMO Accuracy** | 52.9% | 66.9% | 68.4% |
| **p95 Latency** | \~0.90s | 1.44s | 2.59s |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Decouple extraction logic from generation logic to maintain sub-second response latencies.  
  * Employ an LLM to evaluate new facts against a retrieved context of existing facts to manage contradictions.  
  * Enforce a rigid matrix of ADD, UPDATE, DELETE, and NOOP operations to eliminate vector database bloat.  
  * Track relationship evolution rather than just flat text chunks to support temporal queries.  
* **Citations:** 10  
* **Production vs. Experimental:** Vector-based fact extraction with ADD/UPDATE/DELETE logic is highly production-ready. Graph-based relational updating (Mem0g) introduces substantial latency and complexity, remaining on the experimental edge for local-only systems.  
* **LifeOS Recommendation:** Emulate the Mem0 pipeline locally using Gemini Flash. When LifeOS observes a habit change, query SQLite via sqlite-vss for similar past habits, and prompt Gemini Flash to output a JSON object dictating ADD, UPDATE, DELETE, or NOOP for the local semantic table.

## **1.3 Virtual Context Management: The Letta (MemGPT) Paging Model**

The Letta framework (developed from the MemGPT research paper at UC Berkeley) solves the constraint of finite context windows by abandoning the attempt to stuff all information into a prompt. Instead, Letta applies the computer science principles of virtual memory paging to LLMs.12 The agent's prompt acts as limited, volatile physical RAM, while external databases function as expansive disk storage.12

The "RAM" (Main Context) is strictly partitioned into three segments: immutable System Instructions, editable Core Memory Blocks (where the agent maintains a snapshot of its persona and critical user details), and a FIFO message queue.12 The "Disk" (External Context) is divided into Recall Storage (a chronological database of all raw messages) and Archival Storage (an embedding-based semantic database).12

Paging decisions are entirely agent-driven. The Queue Manager monitors the token count of the FIFO queue. When it reaches a predefined warning threshold (e.g., 70% capacity), the system automatically injects a "Memory Pressure" alert into the prompt.12 The agent, executing an internal reasoning loop, utilizes explicit function calls like core\_memory\_replace or archival\_memory\_insert to summarize and page out the oldest messages to disk.12 Conversely, if the agent identifies missing context, it calls archival\_memory\_search to page relevant vectors back into its Core Memory. A critical feature of this architecture is the "Heartbeat" mechanism, which allows the agent to chain multiple function calls—reading, writing, and analyzing data—in a continuous loop before finally yielding control back to the user interface.12

| OS Concept | Letta (MemGPT) Component | Lifecycle / Management |
| :---- | :---- | :---- |
| **RAM** | Main Context (Core Blocks \+ Queue) | Highly volatile, actively edited via tool calls |
| **Disk** | Archival & Recall Storage | Persistent, queried via semantic/chronological search |
| **Page Fault** | Context Miss | Agent autonomously calls search tools to retrieve data |
| **Swapping** | Memory Pressure Alert | Oldest queue entries are summarized and flushed to disk |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Treat the LLM context window as a strictly managed physical resource with clear token budgets.  
  * Expose memory management tools directly to the agent so it can self-edit its own context.  
  * Implement "Heartbeat" mechanisms to allow agents to perform asynchronous background reasoning and data retrieval.  
  * Summarize evicted conversational data before moving it to long-term storage to preserve compressed context.  
* **Citations:** 12  
* **Production vs. Experimental:** The virtual context paging model and editable core memory blocks are robust and production-ready. Infinite recursive tool-chaining without human intervention remains experimentally prone to looping failure modes.  
* **LifeOS Recommendation:** Define a strict 4000-token limit for Gemini's active context. Provide Gemini with local TypeScript tool definitions (update\_core\_memory, search\_archive). When the context limit approaches, automatically prompt Gemini to invoke a summary tool, flushing older focus-session telemetry to SQLite while keeping the summary in RAM.

## **1.4 Temporal Memory Decay and Ebbinghaus Forgetting Curves**

Retaining infinite historical data with equal weight severely damages retrieval precision. Cognitive science dictates that human memory utilizes forgetting as a critical relevance filter.21 Applied to artificial intelligence, memory decay ensures that outdated habits, resolved bugs, or obsolete preferences sink to the bottom of the vector search rankings, reducing "context pollution".21

The Ebbinghaus forgetting curve, first modeled in 1885, demonstrates that biological memory retention drops exponentially without reinforcement, preserving roughly 30% of data after 24 hours.23 In AI vector databases, this biological phenomena is emulated by applying a time-decay penalty to the raw spatial cosine similarity score. The decay function is universally modeled as ![][image1], where ![][image2] represents the decay constant and ![][image3] is the time elapsed since the memory was formed or last retrieved.25 Conversely, the spacing effect dictates that memories retrieved frequently receive a structural boost to their baseline activation energy (often ![][image4] per access).21

Research into temporal AI memory systems indicates that unified decay rates are destructive; half-life parameters must be strictly coupled to the data type. A 7-day half-life is mathematically optimal for active patterns and transient states (e.g., a short-term project goal or an active distraction pattern), enforcing rapid forgetting of obsolete tasks.21 A 30-day half-life effectively filters general semantic knowledge and fluctuating preferences.21 Crucially, core identity markers, major user goals, and foundational behavioral heuristics must possess an infinite half-life (zero decay) to maintain the agent's long-term coherence and persona stability.21

| Memory Fact Type | Recommended Half-Life | Decay Mechanism | Relevance |
| :---- | :---- | :---- | :---- |
| **Transient Tasks** | 7 Days | Fast exponential decay | Rapidly purges resolved issues and active micro-goals |
| **Preferences** | 30 Days | Moderate exponential decay | Allows shifting lifestyle habits to naturally override old ones |
| **Behavioral Patterns** | 90 Days | Slow exponential decay | Captures long-term trend lines in productivity/distraction |
| **Core Identity/Goals** | Infinite (No Decay) | Access-frequency boosting only | Maintains absolute baseline alignment for the LifeOS agent |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Recognize that intentional forgetting is a computational requirement to preserve retrieval precision.  
  * Implement variable exponential decay functions based on the distinct half-life of different data categories.  
  * Boost the baseline activation energy of memories each time they are successfully retrieved to simulate human spaced repetition.  
  * Never permanently delete data based on decay; instead, dynamically depress its retrieval score.  
* **Citations:** 21  
* **Production vs. Experimental:** Implementing mathematical score decay in retrieval logic is production-ready and highly encouraged. Fully autonomous deletion of vectors based on decay thresholds is experimental and highly dangerous to persona continuity.  
* **LifeOS Recommendation:** Do not rely on SQLite vector distance alone. Wrap the sqlite-vss cosine similarity score in a TypeScript function that applies the Ebbinghaus decay multiplier based on the memory's SQLite last\_accessed timestamp, ensuring that a focus rule established yesterday ranks higher than an identical rule from six months ago.

## **1.5 Memory Consolidation: Emulating Biological Distillation**

In mammalian neurobiology, memory consolidation is the process by which transient, context-rich episodic memories stored in the hippocampus are replayed, stripped of irrelevant temporal metadata, and encoded as durable semantic knowledge in the neocortex, typically during sleep.7 Personal AI agents emulate this physiological necessity to transition from simply knowing "what happened" to understanding "what is true".7

Without consolidation, an agent's memory degenerates into a massive, unsearchable append-only log of granular events.7 Leading systems address this via asynchronous background pipelines. For example, rather than retaining every interaction regarding a user's evening routine, systems like Mem0 and Zep utilize scheduled LLM sweeps to analyze batches of chronological logs.11 The LLM identifies recurring themes, isolates core truths, and outputs a generalized semantic fact (e.g., "The user's productivity sharply declines after 8:00 PM").7

This auto-distillation process solves the inherent tension between token efficiency and context retention. The raw episodic logs can subsequently be heavily compressed, archived to deep storage, or deleted, while the high-value semantic fact is injected into the actively retrievable vector database.19 This dual-layer approach provides the agent with deep personalization while maintaining a remarkably small active memory footprint.

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Do not query raw episodic logs for real-time personalization; query distilled semantic truths.  
  * Run consolidation pipelines asynchronously as background tasks to prevent UX blocking.  
  * Extract underlying patterns from multiple episodic events to form a single semantic node.  
  * Compress or archive raw episodic data once successful consolidation is verified.  
* **Citations:** 7  
* **Production vs. Experimental:** Batch-processing episodic logs into semantic vectors via cron jobs is an industry standard. Continuous, real-time background distillation per message is computationally prohibitive and experimental.  
* **LifeOS Recommendation:** Log all real-time macOS focus telemetry and voice interactions into an SQLite episodic\_memory table. Trigger a local Node.js background worker during system idle times to prompt Gemini to read the day's episodic rows, extract 2-3 persistent semantic facts, save them to the semantic\_memory table, and then purge the raw telemetry.

## **1.6 Procedural Memory and Workflow Distillation**

While semantic memory dictates what an AI knows, procedural memory dictates how an AI acts. Procedural memory in agentic systems involves the retention of automated heuristics, coaching macros, and reusable action trajectories.3 Without it, an agent must rely on costly, zero-shot Chain-of-Thought (CoT) reasoning for every repeated task, resulting in high latency, increased token consumption, and a high probability of logical deviation.28

Architectures like ReAct (Reasoning and Acting) interleave thought generation with tool execution.29 When combined with Reflexion—a framework where an agent critiques its own failed trajectories to improve subsequent attempts—agents can reliably solve complex workflows.29 However, the state-of-the-art Memp framework advances this by formalizing procedural distillation.9

When a Memp agent successfully completes a complex task, it does not discard the trajectory. Instead, it extracts a script-like abstraction of the reasoning pattern and tool sequences, storing it in a dedicated procedural memory bank.9 Upon encountering a similar task, the agent retrieves this procedural template via keyword or vector matching and executes the subroutines automatically.28 Memp utilizes diverse memory updating strategies—such as validation filtering (only saving verified successes) and dynamic discarding (pruning obsolete macros)—to ensure the procedural memory remains an optimized, executable asset rather than a bloated script repository.9

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Distill successful multi-step reasoning trajectories into reusable, executable templates.  
  * Treat procedural memory as an independent optimization target distinct from semantic facts.  
  * Employ validation filtering to ensure only objectively successful coaching interventions are encoded as permanent macros.  
  * Allow agents to retrieve and execute procedural scripts to bypass real-time LLM reasoning limits.  
* **Citations:** 3  
* **Production vs. Experimental:** Manually defining procedural macros for an agent to trigger is production-ready. Allowing the LLM to autonomously write, validate, and store its own executable code macros is highly experimental and prone to security/logic degradation.  
* **LifeOS Recommendation:** Do not allow Gemini to write unbounded executable code. Instead, when LifeOS discovers that a specific intervention (e.g., "blocking Reddit \+ playing white noise") successfully restores user focus, use Gemini to update a structured JSON object in a procedural\_memory SQLite table. LifeOS can then deterministically map this JSON configuration to hardcoded TypeScript execution paths.

─────────────────────────────────────────────────

## **Part 2 — Intelligence Layer**

## **2.1 Behavioral Profiling and Dual-Process Theory**

Constructing a reliable behavioral profile within a personal AI necessitates moving beyond basic demographic data to a continuous modeling of user cognition. State-of-the-art behavioral profiling leverages cognitive dual-memory models, utilizing episodic telemetry to feed semantic personalization.6 However, translating this data into effective coaching interventions requires the application of Dual-Process Theory.31

Dual-Process Theory delineates human cognition into two distinct systems: System 1 (fast, automatic, emotionally driven, and highly susceptible to distraction) and System 2 (slow, deliberate, analytical, and requiring immense cognitive effort).31 An intelligent LifeOS must continuously map the user's active behavioral state to these systems. If telemetry indicates rapid application switching and high social media engagement, the user is dominated by System 1 processing. The AI must respond with System 1 interventions: immediate, low-friction constraints, automated web blocking, and micro-nudges that require zero analytical processing. Conversely, when the user enters a state of deep work, reflecting System 2 dominance, the AI must act as a passive shield, ruthlessly suppressing notifications and eliminating external stimuli to protect the fragile flow state.

Furthermore, productivity AI heavily utilizes the Goal-Gradient Effect. This psychological principle demonstrates that human motivation accelerates as the proximity to a perceived goal increases.31 To counter the mid-session motivation slump characteristic of long deep-work blocks, the intelligence layer dynamically injects artificial milestones. By rendering progress visually and offering rapid positive reinforcement as a 45-minute focus session nears its conclusion, the AI exploits the goal-gradient hypothesis, chemically stimulating dopamine release and ensuring task completion.33

| Cognitive Principle | AI Telemetry Indicator | LifeOS Intervention Strategy |
| :---- | :---- | :---- |
| **System 1 (Automatic)** | High app-switching, fast scrolling | Aggressive web-blocking, hard micro-nudges |
| **System 2 (Analytical)** | Sustained IDE/Word Proc. focus | Zero-interruption mode, notification suppression |
| **Goal-Gradient Effect** | Session timer crossing 75% | Visual progress acceleration, positive voice reinforcement |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Classify user telemetry dynamically into System 1 (distracted/reactive) or System 2 (focused/analytical) states.  
  * Tailor the friction of interventions to the active cognitive state; never force analytical decision-making upon a distracted user.  
  * Artificially manipulate the perception of task proximity using progress bars and micro-milestones to hack motivation.  
  * Use episodic data to establish baselines of when a user is most likely to slip from System 2 into System 1\.  
* **Citations:** 6  
* **Production vs. Experimental:** Applying Goal-Gradient UI patterns is standard UX practice. Real-time classification of System 1/System 2 states using desktop telemetry is experimental and requires continuous tuning to prevent false positives.  
* **LifeOS Recommendation:** Implement a background TypeScript state machine that tracks the user's cognitive state based on window activity. When a Pomodoro session reaches the 80% mark, programmatically trigger Next.js UI animations and Gemini-generated encouragement to trigger the goal-gradient effect.

## **2.2 Statistical Anomaly Detection for Focus Drift**

Detecting the precise moment a user's focus degrades is the most critical computational task of a coaching AI. Because local personal assistants evaluate short temporal windows (e.g., active sessions yielding fewer than 100 behavioral data points), selecting an appropriate statistical anomaly detection algorithm is imperative.

Isolation Forest is a prominent machine learning algorithm that detects anomalies by isolating data points via random decision trees.35 However, it is fundamentally incompatible with real-time focus drift detection. Isolation Forest performs poorly on small datasets (![][image5]), fails to account for the sequential nature of time-series data, and is too computationally heavy to run continuously on a client machine.

The Exponentially Weighted Moving Average (EWMA) is significantly more lightweight, smoothing high-frequency noise by applying decreasing weights to older observations.35 While excellent for establishing a general behavioral baseline, EWMA suffers from severe temporal lag. It cannot rapidly identify small, persistent shifts in behavior; by the time the EWMA curve dips below a distraction threshold, the user has likely already lost their flow state entirely.35

The mathematically optimal solution for this architecture is the Tabular Cumulative Sum Control Chart (CUSUM).35 CUSUM does not evaluate raw scores independently; it accumulates the deviations of recent samples against a target baseline mean.36 The algorithm for detecting a negative drift (distraction) is defined as ![][image6], where ![][image7] is the current focus score, ![][image8] is the baseline mean, and ![][image9] is a tolerance parameter.36 Because it integrates the history of minor deviations, CUSUM is exquisitely sensitive to small, continuous step-changes, triggering an alert minutes before an EWMA chart would register the anomaly.36

| Algorithm | Suitability for Small N | Sensitivity to Small Drift | Computational Overhead |
| :---- | :---- | :---- | :---- |
| **Isolation Forest** | Poor | Low | High |
| **EWMA** | Excellent | Low (High Lag) | Very Low |
| **CUSUM** | Excellent | Exceptionally High | Very Low |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Avoid complex machine learning models like Isolation Forest for real-time, low-sample time-series data.  
  * Utilize EWMA strictly for establishing long-term, slow-moving baselines.  
  * Deploy CUSUM to actively monitor data against the baseline, optimizing for early detection of minor, persistent deviations.  
  * Tune the CUSUM ![][image9] parameter (tolerance) to limit false positive interventions.  
* **Citations:** 35  
* **Production vs. Experimental:** CUSUM algorithms are an absolute industry standard in statistical process control and are highly production-ready for software telemetry.  
* **LifeOS Recommendation:** Calculate a continuous "Focus Score" (0-100) based on active window categorization in Node.js. Run a two-sided CUSUM algorithm in memory. Set the baseline ![][image8] at the start of the deep work session, and immediately trigger a Gemini-powered voice intervention if the lower CUSUM statistic breaches your defined control limit.

## **2.3 Cognitive Load Modeling and the Zeigarnik Effect**

Effective AI coaching must be governed by an accurate assessment of the user's cognitive burden; intervening too aggressively when a user is overwhelmed will exacerbate frustration. This is modeled implicitly by adapting the NASA Task Load Index (TLX), a multidimensional framework evaluating Mental Demand, Physical Demand, Temporal Demand, Effort, Performance, and Frustration.39

In a modern AI ecosystem, self-reported NASA TLX surveys are replaced with proxy telemetry. Temporal Demand is inferred from impending calendar deadlines and typing velocity; Frustration is modeled via the frequency of backspaces, rapid cursor oscillations, and the acoustic sentiment of voice interactions; Mental Demand is derived from the structural complexity of the active application (e.g., an IDE versus a web browser).40

When the inferred TLX score peaks, the AI must strictly adhere to Miller's Law, which posits that the human brain can only hold ![][image10] discrete chunks of information in active working memory.11 During high-load states, the AI must radically constrain its UI and voice output—offering binary (yes/no) choices rather than complex conversational trees, thereby preventing working memory overflow.

Simultaneously, the intelligence layer must manage the Zeigarnik Effect, the psychological phenomenon where interrupted or incomplete tasks dominate cognitive processing, generating intrusive thoughts.43 While marketers exploit "open loops" to force engagement, a productivity AI must systematically close them.43 If a user must break focus to address an urgent email, the AI should explicitly document the state of the interrupted task ("I have saved your progress on the quarterly report; we will resume at 2:00 PM"). By formally acknowledging and "parking" the task, the AI neutralizes the Zeigarnik tension, clearing the user's cognitive cache for the interruption.45

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Map desktop telemetry to NASA TLX proxy dimensions to generate a continuous, implicit cognitive load score.  
  * Respect Miller's Law by aggressively simplifying AI outputs and available UI choices during periods of high cognitive demand.  
  * Neutralize the Zeigarnik Effect by explicitly acknowledging, documenting, and scheduling the resumption of interrupted tasks.  
  * Never initiate complex, multi-step coaching dialogues when Frustration and Temporal Demand metrics are elevated.  
* **Citations:** 11  
* **Production vs. Experimental:** Using Miller's Law and Zeigarnik closures in UX design is standard practice. Generating an implicit, real-time NASA TLX score purely from keystrokes and app switching is experimental and highly inferential.  
* **LifeOS Recommendation:** Create a running CognitiveLoad variable in TypeScript. Increase it based on typing speed and rapid window toggling. If the user attempts to switch tasks while the load is high, use Next.js to pop up a strictly binary modal (Miller's Law) asking, "Park this task for later? Y/N" to instantly close the Zeigarnik loop.

## **2.4 Optimal Synthesis Cadence**

Generating and maintaining an accurate behavioral profile is a computationally expensive operation that must be balanced against local hardware constraints. The optimal architecture employs a hybrid synthesis cadence, bifurcating tasks into time-driven and event-driven triggers.

Time-driven synthesis is reserved for macro-level operations. A nightly cron job executing a "sleep cycle" is ideal for Ebbinghaus decay updates, episodic database pruning, and heavy memory consolidation pipelines (extracting broad semantic trends from the day's logs).18 Attempting these operations synchronously during the day leads to unacceptable UI blocking and battery drain.

Conversely, the immediate operational profile requires strict event-driven synthesis. The AI must halt background processing and immediately force a re-evaluation of its coaching strategy under three specific triggers:

1. **Distraction Spike (CUSUM Alert):** When the CUSUM control chart breaches its threshold, indicating a persistent drop in focus, the system must instantly synthesize a micro-intervention.18  
2. **Context Shift:** When OS telemetry indicates a fundamental environment change (e.g., closing a programming IDE and launching a streaming service), the AI must immediately transition its active system prompt from "Work Mode" to "Leisure/Recovery Mode."  
3. **Session Boundary:** Upon the termination of a tracked work block, the AI should execute an immediate, lightweight retrospective synthesis to grade the session's performance before the user loses context.18

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Implement a hybrid synthesis cadence to protect system resources and battery life.  
  * Offload deep semantic consolidation and database maintenance to time-driven, low-activity nightly cycles.  
  * Utilize strict event-driven triggers for immediate coaching interventions and context shifting.  
  * Force immediate re-synthesis upon statistically significant CUSUM focus anomalies or explicit application context switches.  
* **Citations:** 18  
* **Production vs. Experimental:** Hybrid scheduling with nightly batch processing and real-time alerts is a mature, standard software engineering pattern for production agents.  
* **LifeOS Recommendation:** Do not poll the Gemini LLM on a continuous loop. Run your CUSUM and active-window tracking via local, deterministic TypeScript listeners. Only invoke a Gemini API call for a coaching response when an event listener fires (e.g., CUSUM threshold breached), ensuring zero idle API costs. Execute a single, heavy Gemini prompt at 3:00 AM to consolidate the day's SQLite episodic logs.

─────────────────────────────────────────────────

## **Part 3 — Implementation Patterns**

## **3.1 Local-First Semantic Similarity Search**

Operating an autonomous assistant entirely on a local macOS environment without external cloud vectors requires meticulous selection of the semantic retrieval engine. The system must execute high-precision similarity searches against local SQLite databases while maintaining ultra-low latency.

The most basic implementation involves generating embedding vectors, storing them as raw JSON blobs in a standard SQLite text column, and calculating cosine similarity via JavaScript arrays in application code. While easy to build, this approach forces the application to load the entire dataset into V8's RAM, executing ![][image11] math operations for every query. This guarantees severe garbage collection pauses and catastrophic latency scaling.

SQLite FTS5 (Full-Text Search) is native, exceptionally fast, and utilizes algorithms conceptually similar to BM25. It creates virtual tables that tokenize text for instantaneous keyword matching. However, FTS5 relies strictly on sparse, lexical retrieval; it fundamentally cannot understand semantic intent.5 A query for "fatigue" will completely ignore a memory containing the word "exhaustion," crippling the AI's cognitive flexibility.

The absolute industry standard for local-first semantic retrieval in 2026 is the sqlite-vss (or the newer sqlite-vec) extension.5 This extension embeds native C/C++ vector search capabilities directly into the SQLite runtime, enabling exact and approximate nearest neighbor (ANN) queries via standard SQL syntax. By storing Gemini-generated embeddings as BLOBs within a VSS virtual table, the database handles the vector math internally with exceptional speed.

The optimal architectural pattern is Hybrid Search. The system executes a dense semantic search via sqlite-vss simultaneously with a sparse keyword search via FTS5. The results are mathematically merged using Reciprocal Rank Fusion (RRF), ensuring the retrieval engine captures both precise terminology (e.g., specific project codes) and broad conceptual intent.5

| Search Method | Semantic Understanding | Keyword Precision | Performance (Large N) |
| :---- | :---- | :---- | :---- |
| **JSON \+ JS Math** | Yes | Poor | Very Poor |
| **SQLite FTS5** | No | Excellent | Excellent |
| **sqlite-vss** | Yes | Poor | Excellent |
| **Hybrid (VSS \+ FTS5)** | Yes | Excellent | Excellent |

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Never compute cosine similarities in application-layer JavaScript for production systems.  
  * Do not rely solely on FTS5, as sparse retrieval cannot map semantic intent.  
  * Integrate the sqlite-vss (or sqlite-vec) native extension to handle vector operations directly within the database engine.  
  * Combine VSS and FTS5 using Reciprocal Rank Fusion to guarantee comprehensive memory retrieval.  
* **Citations:** 5  
* **Production vs. Experimental:** Hybrid search using sqlite-vss and FTS5 is a highly stable, production-ready standard for local-first RAG architectures.  
* **LifeOS Recommendation:** Compile sqlite-vss for your Mac environment. When querying memory for a coaching intervention, run a dual query: SELECT rowid, distance FROM vss\_semantic and SELECT rowid, rank FROM fts\_semantic. Merge the results in your Next.js API route using an RRF algorithm before feeding the top results to Gemini.

## **3.2 Privacy, User Control, and Right-to-be-Forgotten**

A personal productivity guardian possesses unfettered access to highly sensitive, granular behavioral telemetry. Absolute data sovereignty and explicit user control are not merely ethical guidelines; they are architectural imperatives.

The system must fundamentally support the Right-to-be-Forgotten. Because semantic facts, vector embeddings, and chronological logs are deeply interconnected, deleting a single entity can result in orphaned vectors or corrupted relationship graphs. The SQLite schema must enforce strict relational integrity, utilizing ON DELETE CASCADE constraints between the core semantic table and the virtual vector tables.19 Furthermore, LifeOS must expose a transparent, user-facing Memory Inspection API. Following the philosophy of Letta's "white-box" memory blocks, the Next.js UI must feature a dedicated dashboard where users can view, manually edit, or permanently purge any inferred semantic fact or procedural rule.47

To mitigate the risk of the LLM hallucinating behavioral facts, the consolidation pipeline must utilize strict Confidence Thresholds. When the extraction LLM distills a new fact from episodic logs, it must append a confidence probability (![][image12]).19 Any semantic memory scoring below a predefined threshold (e.g., ![][image13]) should be stored in the database but flagged as unverified. Unverified facts are prohibited from being injected into the active working context until subsequent interactions or explicit user confirmation reinforces their validity, preventing the AI from acting on spurious assumptions.

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Maintain absolute data sovereignty by storing all memory tiers locally; never transmit behavioral telemetry to cloud vector databases.  
  * Implement user-facing dashboards that expose all extracted semantic facts and procedural rules for manual review and deletion.  
  * Enforce strict ON DELETE CASCADE rules in the database to prevent orphaned vector embeddings.  
  * Require the extraction LLM to score its own confidence, quarantining low-confidence facts from active retrieval.  
* **Citations:** 19  
* **Production vs. Experimental:** Explicit memory inspection UIs and cascade deletions are standard, production-ready features. Self-evaluating LLM confidence scores are prone to calibration errors and require careful prompt engineering.  
* **LifeOS Recommendation:** Build a /memory route in your Next.js frontend. Query the SQLite semantic\_memory table and display all facts. Allow the user to click a "Delete" button, executing a SQL command that completely purges the fact and its associated sqlite-vss vector, ensuring absolute user trust.

## **3.3 SQLite Database Schema for 4-Tier Memory**

A highly performant, local 4-tier memory system utilizing better-sqlite3 demands a rigorously structured schema. The database must isolate high-velocity telemetry (Episodic) from retrieved knowledge (Semantic) and natively integrate vector capabilities. Furthermore, Write-Ahead Logging (WAL) is mandatory to prevent the high-frequency background insertions of the episodic table from locking the database during active UI reads.

SQL

\-- Enable High-Performance Concurrency  
PRAGMA journal\_mode \= WAL;  
PRAGMA synchronous \= NORMAL;

\-- 1\. Working Memory (Short-term, volatile prompt context)  
CREATE TABLE working\_memory (  
    id TEXT PRIMARY KEY,  
    session\_id TEXT NOT NULL,  
    role TEXT NOT NULL, \-- 'user', 'assistant', 'system'  
    content TEXT NOT NULL,  
    created\_at DATETIME DEFAULT CURRENT\_TIMESTAMP  
);

\-- 2\. Episodic Memory (High-velocity telemetry and logs)  
CREATE TABLE episodic\_memory (  
    id TEXT PRIMARY KEY,  
    event\_type TEXT NOT NULL, \-- 'focus\_session', 'browsing\_distraction'  
    context\_data JSON NOT NULL,  
    created\_at DATETIME DEFAULT CURRENT\_TIMESTAMP  
);  
CREATE INDEX idx\_episodic\_time ON episodic\_memory(created\_at);

\-- 3\. Semantic Memory (Distilled facts, preferences, goals)  
CREATE TABLE semantic\_memory (  
    id TEXT PRIMARY KEY,  
    fact\_text TEXT NOT NULL,  
    category TEXT NOT NULL, \-- 'preference', 'goal', 'identity'  
    confidence REAL DEFAULT 1.0,  
    access\_count INTEGER DEFAULT 0,  
    last\_accessed\_at DATETIME DEFAULT CURRENT\_TIMESTAMP,  
    created\_at DATETIME DEFAULT CURRENT\_TIMESTAMP  
);  
CREATE INDEX idx\_semantic\_category ON semantic\_memory(category);

\-- 4\. Procedural Memory (Executable coaching scripts)  
CREATE TABLE procedural\_memory (  
    id TEXT PRIMARY KEY,  
    trigger\_condition TEXT NOT NULL,  
    action\_sequence JSON NOT NULL,  
    success\_rate REAL DEFAULT 1.0  
);

\-- Virtual Table for fast vector search via sqlite-vss  
CREATE VIRTUAL TABLE vss\_semantic\_embeddings USING vss0(  
    embedding(768) \-- Matches Google Gemini embedding dimensions  
);

\-- Relational link with ON DELETE CASCADE to ensure privacy compliance  
CREATE TABLE semantic\_vector\_links (  
    semantic\_id TEXT REFERENCES semantic\_memory(id) ON DELETE CASCADE,  
    rowid INTEGER REFERENCES vss\_semantic\_embeddings(rowid) ON DELETE CASCADE  
);

\-- FTS5 Virtual Table for Hybrid Keyword Search  
CREATE VIRTUAL TABLE fts\_semantic USING fts5(  
    fact\_text,  
    content\='semantic\_memory',  
    content\_rowid\='id'  
);

**The Importance Scoring Formula:** To execute relevance-based retrieval that respects Ebbinghaus decay, the system calculates a dynamic score at query time.21 For a memory ![][image14]:

![][image15]  
Where:

* ![][image16] is the raw vector similarity returned by sqlite-vss.  
* ![][image2] is the distinct decay constant for that memory's category.  
* ![][image17] is the time elapsed since last retrieval.  
* ![][image18] is the absolute historical retrieval count (spacing effect).  
* ![][image19] are tunable parameters weighting semantic match, recency, and historical importance.

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Enable WAL mode to prevent database locks between background episodic logging and active semantic reading.  
  * Isolate the four memory tiers into distinct tables to optimize querying and indexing strategies.  
  * Utilize trigger-updated FTS5 tables and explicit foreign key cascades for the VSS embeddings.  
  * Compute retrieval rankings using a composite mathematical formula that accounts for vector distance, exponential temporal decay, and access frequency.  
* **Citations:** 5  
* **Production vs. Experimental:** The provided relational SQLite schema and VSS/FTS5 integrations are robust, highly optimized production standards for local apps.  
* **LifeOS Recommendation:** Execute the schema above using the better-sqlite3 driver in your Next.js backend. Calculate the Importance Score natively within your TypeScript service immediately after fetching the raw cosine distances from the vss\_semantic\_embeddings table.

## **3.4 Open-Source Frameworks for a Next.js/TypeScript Stack**

Building a sophisticated, local-first AI architecture without relying on Python-heavy abstraction frameworks (like LangChain or LlamaIndex) requires selecting highly optimized JavaScript/TypeScript libraries that integrate flawlessly with Next.js 15\.

The unequivocal industry standard for this stack in 2026 is the **Vercel AI SDK**.49 It natively supports React Server Components (RSC), allowing the agent to stream not just text tokens, but fully interactive, type-safe React UI components directly to the client via the streamUI function.49 This is vital for a coaching AI; instead of generating markdown text stating "You should start a focus timer," the Vercel AI SDK allows Gemini to stream a functional, clickable \<FocusTimer /\> component directly into the chat interface.49

For database interaction, **better-sqlite3** remains the premier choice. Unlike asynchronous wrappers, better-sqlite3 is a synchronous C++ addon for Node.js, eliminating promise overhead and delivering maximum raw read/write performance for local disk I/O.

To handle Letta-style memory orchestration and Mem0-style fact extraction, developers should avoid adopting bloated external frameworks. Instead, utilize the Vercel AI SDK's native tool definitions. By defining tools with strict Zod schemas (e.g., update\_semantic\_memory), the Gemini Pro/Flash LLM can generate deterministic JSON objects that directly execute your local better-sqlite3 functions, providing absolute control over the memory pipeline without the opacity of third-party wrappers.49

#### **Architectural Synthesis & Recommendations**

* **Summary of Best Practices:**  
  * Avoid heavy, multi-language orchestration frameworks (LangChain) in favor of native TypeScript SDKs.  
  * Utilize the Vercel AI SDK to stream generative UI components alongside text responses.  
  * Use better-sqlite3 for synchronous, maximum-throughput local database operations.  
  * Define agent memory operations using strict Zod schemas bound to SDK tool calls.  
* **Citations:** 49  
* **Production vs. Experimental:** The Vercel AI SDK integrated with Next.js App Router and Server Components is the dominant, highly stable production stack for modern web-based AI interfaces.  
* **LifeOS Recommendation:** Initialize your Next.js 15 application using the Vercel AI SDK Core. Define your 4-tier memory operations (insertEpisodic, updateSemantic, pageMemory) as strict TypeScript tools validated by Zod. Feed these tools to the @google/generative-ai provider wrapper. This ensures Gemini Flash operates with sub-second latency while executing complex memory management natively on your Mac.

#### **Works cited**

1. 1\. Introduction \- arXiv.org, accessed on March 24, 2026, [https://arxiv.org/html/2603.04740v1](https://arxiv.org/html/2603.04740v1)  
2. AI Agent Memory: Types, Implementation, Challenges & Best Practices 2026 \- 47Billion, accessed on March 24, 2026, [https://47billion.com/blog/ai-agent-memory-types-implementation-best-practices/](https://47billion.com/blog/ai-agent-memory-types-implementation-best-practices/)  
3. What Is AI Agent Memory? | IBM, accessed on March 24, 2026, [https://www.ibm.com/think/topics/ai-agent-memory](https://www.ibm.com/think/topics/ai-agent-memory)  
4. Memory Types in Agentic AI: A Breakdown | by Gokcer Belgusen \- Medium, accessed on March 24, 2026, [https://medium.com/@gokcerbelgusen/memory-types-in-agentic-ai-a-breakdown-523c980921ec](https://medium.com/@gokcerbelgusen/memory-types-in-agentic-ai-a-breakdown-523c980921ec)  
5. AI Agent Architecture: Build Systems That Work in 2026 \- Redis, accessed on March 24, 2026, [https://redis.io/blog/ai-agent-architecture/](https://redis.io/blog/ai-agent-architecture/)  
6. Episodic Memory in AI Agents: Long-Term Context & Learning \- centron GmbH, accessed on March 24, 2026, [https://www.centron.de/en/tutorial/episodic-memory-in-ai-agents-long-term-context-learning/](https://www.centron.de/en/tutorial/episodic-memory-in-ai-agents-long-term-context-learning/)  
7. Your Agent Remembers Everything Except What Matters | Chanl Blog, accessed on March 24, 2026, [https://www.chanl.ai/es/blog/ai-agent-memory-episodic-semantic-iclr-2026](https://www.chanl.ai/es/blog/ai-agent-memory-episodic-semantic-iclr-2026)  
8. How to Build AI Agents with Redis Memory Management, accessed on March 24, 2026, [https://redis.io/blog/build-smarter-ai-agents-manage-short-term-and-long-term-memory-with-redis/](https://redis.io/blog/build-smarter-ai-agents-manage-short-term-and-long-term-memory-with-redis/)  
9. M⁢e⁢m^p: Exploring Agent Procedural Memory \- arXiv, accessed on March 24, 2026, [https://arxiv.org/html/2508.06433v2](https://arxiv.org/html/2508.06433v2)  
10. Mem0: Technical Analysis Report \- Southbridge.AI, accessed on March 24, 2026, [https://www.southbridge.ai/blog/mem0-technical-analysis-report](https://www.southbridge.ai/blog/mem0-technical-analysis-report)  
11. AI Memory Research: 26% Accuracy Boost for LLMs | Mem0, accessed on March 24, 2026, [https://mem0.ai/research](https://mem0.ai/research)  
12. Stateful AI Agents: A Deep Dive into Letta (MemGPT) Memory Models \- Medium, accessed on March 24, 2026, [https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1](https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1)  
13. MemGPT: Towards LLMs as Operating Systems \- arXiv, accessed on March 24, 2026, [https://arxiv.org/pdf/2310.08560](https://arxiv.org/pdf/2310.08560)  
14. Agent memory: Letta vs Mem0 vs Zep vs Cognee \- Community, accessed on March 24, 2026, [https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88](https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88)  
15. Zep: A Temporal Knowledge Graph Architecture for Agent Memory \- arXiv, accessed on March 24, 2026, [https://arxiv.org/html/2501.13956v1](https://arxiv.org/html/2501.13956v1)  
16. LLM Memory: Integration of Cognitive Architectures with AI \- Cognee, accessed on March 24, 2026, [https://www.cognee.ai/blog/fundamentals/llm-memory-cognitive-architectures-with-ai](https://www.cognee.ai/blog/fundamentals/llm-memory-cognitive-architectures-with-ai)  
17. AI Agent Memory Systems in 2026: Mem0, Zep, Hindsight, Memvid and Everything In Between — Compared | by Yogesh Yadav \- Medium, accessed on March 24, 2026, [https://medium.com/@yogeshyadav/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8](https://medium.com/@yogeshyadav/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)  
18. Mem0 & Mem0-Graph breakdown \- Dwarves Memo, accessed on March 24, 2026, [https://memo.d.foundation/breakdown/mem0](https://memo.d.foundation/breakdown/mem0)  
19. Memory Management in AI Agents: Complete Guide to Context & Persistence (2025), accessed on March 24, 2026, [https://orbitalai.in/Orbitalai-memory-management.html](https://orbitalai.in/Orbitalai-memory-management.html)  
20. Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory \- arXiv, accessed on March 24, 2026, [https://arxiv.org/abs/2504.19413](https://arxiv.org/abs/2504.19413)  
21. TIL: Memory decay actually makes retrieval BETTER, not worse \- Moltbook, accessed on March 24, 2026, [https://www.moltbook.com/post/783de11a-2937-4ab2-a23e-4227360b126f](https://www.moltbook.com/post/783de11a-2937-4ab2-a23e-4227360b126f)  
22. MemGPT: Engineering Semantic Memory through Adaptive Retention and Context Summarization \- Information Matters, accessed on March 24, 2026, [https://informationmatters.org/2025/10/memgpt-engineering-semantic-memory-through-adaptive-retention-and-context-summarization/](https://informationmatters.org/2025/10/memgpt-engineering-semantic-memory-through-adaptive-retention-and-context-summarization/)  
23. Replication and Analysis of Ebbinghaus' Forgetting Curve \- PMC \- NIH, accessed on March 24, 2026, [https://pmc.ncbi.nlm.nih.gov/articles/PMC4492928/](https://pmc.ncbi.nlm.nih.gov/articles/PMC4492928/)  
24. The Forgetting Curve: How AI-Generated Flashcards Combat Memory Decay, accessed on March 24, 2026, [https://studycardsai.com/blog/the-forgetting-curve](https://studycardsai.com/blog/the-forgetting-curve)  
25. Mem0: Scalable Memory Architecture \- Emergent Mind, accessed on March 24, 2026, [https://www.emergentmind.com/topics/mem0-system](https://www.emergentmind.com/topics/mem0-system)  
26. Human-like Forgetting Curves in Deep Neural Networks \- arXiv, accessed on March 24, 2026, [https://arxiv.org/html/2506.12034v1](https://arxiv.org/html/2506.12034v1)  
27. Super Time-Cognitive Neural Networks (Phase 3 of Sophimatics): Temporal-Philosophical Reasoning for Security-Critical AI Applications \- MDPI, accessed on March 24, 2026, [https://www.mdpi.com/2076-3417/15/22/11876](https://www.mdpi.com/2076-3417/15/22/11876)  
28. New procedural memory framework promises cheaper, more resilient AI agents, accessed on March 24, 2026, [https://www.computerworld.com/article/4047577/new-procedural-memory-framework-promises-cheaper-more-resilient-ai-agents.html](https://www.computerworld.com/article/4047577/new-procedural-memory-framework-promises-cheaper-more-resilient-ai-agents.html)  
29. Agentic Memory: How AI Agents Learn, Remember, and Improve | by Dashanka De Silva, accessed on March 24, 2026, [https://dashankadesilva.medium.com/agentic-memory-how-ai-agents-learn-remember-and-improve-fd683c344685](https://dashankadesilva.medium.com/agentic-memory-how-ai-agents-learn-remember-and-improve-fd683c344685)  
30. Cognee Wiki \- Glossary of Terms, accessed on March 24, 2026, [https://www.cognee.ai/wiki](https://www.cognee.ai/wiki)  
31. Goal-Gradient Effect | Laws of UX, accessed on March 24, 2026, [https://lawsofux.com/goal-gradient-effect/](https://lawsofux.com/goal-gradient-effect/)  
32. NeurIPS 2025 Papers, accessed on March 24, 2026, [https://neurips.cc/virtual/2025/papers.html](https://neurips.cc/virtual/2025/papers.html)  
33. Goal Gradient Effect: How to Improve User Engagement? | Corexta: Your All-in-One Business Management Solution, accessed on March 24, 2026, [https://www.corexta.com/goal-gradient-effect/](https://www.corexta.com/goal-gradient-effect/)  
34. Goal Gradient Effect: Speed up user progress \- Learning Loop, accessed on March 24, 2026, [https://learningloop.io/plays/psychology/goal-gradient-effect](https://learningloop.io/plays/psychology/goal-gradient-effect)  
35. CUSUM, EWMA, and Shiryaev-Roberts under drift, accessed on March 24, 2026, [http://mat.izt.uam.mx/profs/anovikov/data/IWSM2009/invited%20papers/IWSM43.pdf](http://mat.izt.uam.mx/profs/anovikov/data/IWSM2009/invited%20papers/IWSM43.pdf)  
36. Quality Engineering The CUSUM and the EWMA Head-to-Head \- School of Statistics, accessed on March 24, 2026, [http://www.stat.umn.edu/hawkins/5031/Hawkins\_Wu\_2014.pdf](http://www.stat.umn.edu/hawkins/5031/Hawkins_Wu_2014.pdf)  
37. EWMA versus CUSUM: Sample-based score over drift rate. \- ResearchGate, accessed on March 24, 2026, [https://www.researchgate.net/figure/EWMA-versus-CUSUM-Sample-based-score-over-drift-rate\_fig1\_384127843](https://www.researchgate.net/figure/EWMA-versus-CUSUM-Sample-based-score-over-drift-rate_fig1_384127843)  
38. Online Meta-Recommendation of CUSUM Hyperparameters for Enhanced Drift Detection, accessed on March 24, 2026, [https://www.mdpi.com/1424-8220/25/9/2787](https://www.mdpi.com/1424-8220/25/9/2787)  
39. NASA Task Load Index | Digital Healthcare Research, accessed on March 24, 2026, [https://digital.ahrq.gov/health-it-tools-and-resources/evaluation-resources/workflow-assessment-health-it-toolkit/all-workflow-tools/nasa-task-load-index](https://digital.ahrq.gov/health-it-tools-and-resources/evaluation-resources/workflow-assessment-health-it-toolkit/all-workflow-tools/nasa-task-load-index)  
40. NASA TLX (Task Load Index) \- UX test tools, accessed on March 24, 2026, [https://www.uxtesttools.com/tools/nasa-tlx](https://www.uxtesttools.com/tools/nasa-tlx)  
41. Everything You Need to Know About the NASA-TLX \- Research Collective, accessed on March 24, 2026, [https://research-collective.com/everything-you-need-to-know-about-the-nasa-tlx/](https://research-collective.com/everything-you-need-to-know-about-the-nasa-tlx/)  
42. Psychometric Properties of NASA-TLX and Index of Cognitive Activity as Measures of Cognitive Workload in Older Adults \- PMC, accessed on March 24, 2026, [https://pmc.ncbi.nlm.nih.gov/articles/PMC7766152/](https://pmc.ncbi.nlm.nih.gov/articles/PMC7766152/)  
43. 15 copywriting frameworks that are revolutionizing online marketing and SEO \- NON.agency, accessed on March 24, 2026, [https://non.agency/en/blog/15-copywriting-frameworks-that-are-revolutionizing-online-marketing-and-seo/](https://non.agency/en/blog/15-copywriting-frameworks-that-are-revolutionizing-online-marketing-and-seo/)  
44. presentation questions \- Winning Presentations, accessed on March 24, 2026, [https://winningpresentations.com/tag/presentation-questions/](https://winningpresentations.com/tag/presentation-questions/)  
45. Closing Open Loops \- Concepts, accessed on March 24, 2026, [https://concepts.dsebastien.net/concept/closing-open-loops/](https://concepts.dsebastien.net/concept/closing-open-loops/)  
46. The Unfinished Narrative: How Nike, Coca-Cola, and Apple Master, accessed on March 24, 2026, [https://www.tracebrandbuilding.com/zeigarnik-effect-marketing-strategy/](https://www.tracebrandbuilding.com/zeigarnik-effect-marketing-strategy/)  
47. What's Letta ai? A complete guide | by Aaryan Kansari \- Medium, accessed on March 24, 2026, [https://medium.com/@pbzbhzxk/whats-letta-ai-a-complete-guide-230d572a6fd2](https://medium.com/@pbzbhzxk/whats-letta-ai-a-complete-guide-230d572a6fd2)  
48. Introduction to Stateful Agents \- Letta Docs, accessed on March 24, 2026, [https://docs.letta.com/guides/core-concepts/stateful-agents/](https://docs.letta.com/guides/core-concepts/stateful-agents/)  
49. 7 Best UI Frameworks for AI Agents (2026 Guide) \- Fast.io, accessed on March 24, 2026, [https://fast.io/resources/best-ui-frameworks-ai-agents/](https://fast.io/resources/best-ui-frameworks-ai-agents/)  
50. AI SDK, accessed on March 24, 2026, [https://ai-sdk.dev/](https://ai-sdk.dev/)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAAAYCAYAAAAWPrhgAAADNklEQVR4Xu2YS8hNURTHF/J+RnmNPinlNZIyoLzyfssrvlIyUsKADCkGGJEMRCSPAZFCRJ+BgYlXBpQMUJh4v+W1/q19+tZd5+y9zy33dO/t/OrfPee/9rl7n73POXvtTVRSFENYA61ZUntGsv5aM4NfrJ/WNPS0xv+gC6u/NTOYYY0m4jNrgzUVLazJJAM5tCLSzjzWfWvGwGt5kGQQfODJyAP+44M1m4SZFH6Lfrjfl6yvOqC4x1pszRATWH9Ya8hf+W9WR2sGQAPuWLNJ8PXRYNYUd9yDpNyA9jCNcl6iMyoWBIX3ud+syo+yLlpTgWvmWJPEH2TNJuA164A1ST5/mjes98YDWX0cBBdgAvQR+sOxJPGst2sd65s16wy0LyTLcdZsSvdJP5K5RdOXpFwv5S2gKuefFZSuTLOMwvHzFI6HYo3GBdZyd4z76q1ib9Wx5hPJG5dwl7VEnXsZTvJZuk1S2XzWrIoSwnPWLWuSlMX1uPY7ay5rUkUJwff5Kxo8zXtZOyicCPm4wTqkzs+yrrvj7qyTrFbWatYqpc0kfZDUmTywmI/0AKdYyNpCcgESBBxvqighIL7emiTlt5LET7nz6RUlBKwHrlqzQPDpRTZ1maSTOlH1b/U4Sic8nan9f16445CeuLK7WG2spe48Ci7G0+AD8WnWdCTzTwcbUDxmPbNmBodZJzzCd/8YSbJyxJXFG5sHtO9BhtcwoLF2ctMgPsyajnMUv9krFC9TKzC4uu4RrKes3cqra8ZTvPMQb7GmAzGkkiEuUbyOWoF6of2s7SQr/IYCk16s8xBPFl8WxLLmLc0j8mc4mp2sPVUISU0MtA9ZVMOCyTPPAGE9YxlDEkvWP1MpO0lAhnfNmgWB9j20JtVoo7IW4AZiGRb2lNqsSTJJ68F9p441KLPImgWxkdIP4ETyt7XuQON9GVrCWkrfZAJSR8RCK2PftUWxjaQNEAYGA9QQjKb8nZe3nGUl65U1S8Kgsz+SrCViGVgCtnNOWzMHqAs7vCVVgE7Dk43fbiYWotq3CJnfTWuWxMGuNRaYXW0gAspn7e5mgczuizVLak8fkk3HGNgwLCkpKSmQf/YzzU/ysPKgAAAAAElFTkSuQmCC>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAAZCAYAAADnstS2AAAAhUlEQVR4XmNgGPrgPxA/AGIWNHGcAKQBhIkCExggijnQJXABkOKN6IK4AElOyWCAKFZGl8AFQIpvoQtiA+IMJDjlOhDfZYAoxhvmD4B4JRAzM0AUL0ORRQIvGVDdidMpH4D4O5pYIQNEsRSy4GeoIDYAEr8E48hABUBuxAb2MOA2aBQQBwC0ciJVn07c0AAAAABJRU5ErkJggg==>

[image3]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABcAAAAYCAYAAAARfGZ1AAABB0lEQVR4XmNgGAVkgJ9AzIkuSA1QBcT/gfgpugQ1AMhgGGZDk8MFQGq90AXRQQEQNwNxLQNEwz1UaaxAlwGilgldAh2AFCGzQZgZSQwbWM+Aqg8rSAbibiR+BwNE01UkMWTgwQAJCpCaH0DsDcS2KCqQADbbYa7HBoqAuIwBIr8MyndBUQEFYUA8FV0QCCYzQDSfRJeAAlh4M6JLIANcrgMBfK5fy4BbDgxAYbcQXRAJzGeAGLAHXYIBIv4WXRAZ4LUZCnC5HiQGSr5YgRUDxGuEwDoGiEHIanWgYrD07cSAFqEwF5GCYQCU9JD575HYDHIMmBqJwf0gzVBwGyp2AUlsFIyCwQIAi2FUkrVgN3IAAAAASUVORK5CYII=>

[image4]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAXCAYAAAB50g0VAAABaElEQVR4Xu2UvytHURjGn5KS+IrJbDPY7LJLNqPVrEx+rTIaDN/JQGRSyiR/A0UxSBFRBj+KpPC+nXs43p77Pe+3lNL91NO953nvOec595x7gYqK/8Gw6ET0IVo3tRx7CP2eRBOm9itMid6T9iTChB5eRS3FfSdCv4vvcmNaRdPWJOig/cRbNJ5lHuG5ucTTtndxaEM+4Bj4gPpmmJ8ygPDMSOI1FbAD+YD74AOeg/s5tI+eRRd6JnIB78GDHIP7ZXSJHkTPttAIT8CyLTkE9xl6BuuiF9GKqX0xSDQkWia+KnINHuQI3M9RtmCMEo2LVomvipSdwTNwP8cOQr8NW2B4tngGPIjnKz4QPRpvFqHfm/EpnoCKDthDPH0bKQumHbezPfHWCm8z8UrxBrxB+K1EehEm0R99ZLvwthLvUrSUtJUY2oU3oHInuhXtIkzQ97OMbtGVqGb8+LWfFlddrJtmAlZUVPwVn3J1Y1jNR45IAAAAAElFTkSuQmCC>

[image5]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEkAAAAYCAYAAAC2odCOAAACcUlEQVR4Xu2XzYuOURjGL4aiZEHZUDNFLCxY2AhRM3+BQmr+AVngH7AiJAvlY4XZsJimKAv5mFFWZnasSFmQlJBv+XZfcz/H3Od+z3m/nhezOL+6ep9z3e+53/PczznnOS9QKBQKs5fzoveiX5VGoqjyAzNxajAO/1Pmib5607BKNAkd5y0Xs5yA5nkl2uxiWWwRUkxAB/C/eIDWY9yKOLbetQNvRYdM+7PoqGknmSO6JroMTbo9Dk+T+rG68HeXerMF75AfC/09zuNsuWvaXAW+/5KE18A+0YbqOvekvnujBhzUC9FtH2iDXJGWQX1+Wm5UfoBFS/WnN+xNC9dl4A20w2LjrRYdM+1uWQMd5EUf6IBckQ4i7V9A7PP6m2kH6N/3psUm4b7D9kPjXRItMu1O2QbNedz53ZAr0hWk/dNoLBJzeOhzb0rCfeGq89jBJ+6G3dC+B3ygBrki3UHaPwn1l1dtXr+eCf/B33OE3Y+sZ598s1duiv3Q/rt8oAfkisTZnvJPQX0eHQivuaV46P/0ZiBVVRIquxbx67IdDkP7bvGBHpArUm5POofY5/UX0w7Qf+TNQCoxuQmNPRYtdLF2CTNqpw/UIFekTVC/1dstPHwPvbPeJJyC496smIt8wk7ZAc3DZVyXXJEIfX/G+4B4tZxBY3/uy/TmOx99opfQI3yOT2iy43fBRui6P+IDHcAx+ZsMXEd8ngs3P2A8Qo/bSGAKiTfeKPRozvMRNzH+N0uxTrTXmz1gAHqzI7HdFP6/fC56WukZdIastF8S7ok+isagxRiKw9P0Q2NcRU+guWYtC0QrvFkoFAqFQuFv8BtFs7fnF8KBnwAAAABJRU5ErkJggg==>

[image6]: <data:image/png;base64,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>

[image7]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAYCAYAAAD+vg1LAAAA+UlEQVR4XmNgGAX0BtFA/BOI/yPhN0jyv9DkbiPJEQXcGCAan6KJcwPxPyDmQhMnCcBchS5GMVjJADGoGcoHsZkR0uQDRgaEq78BsQCqNGXgNwPEYHt0CUrBSQaIwffQJSgBs4C4nAF7JGID79EFsIFsIF4CZcMiEWQJPpCPLoAOXID4NBIfORLJBupA/AJdkAGR4yTQJYCgHoivArEmugQIsAHxfAaIZhAbHRQzQOSeoUsAQTwQ9wJxP7rELSD+AMRvgfgjEH9FlWZ4BxUHyYPYn4G4EkUFhcGECwgC8V90QWqAAwyQUrEOTZxiYMsAiTyq585RgB8AAEsxPtiXW56eAAAAAElFTkSuQmCC>

[image8]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABMAAAAZCAYAAADTyxWqAAAA5klEQVR4XmNgGAWjYIiD/0CcgyZ2EYg3oIkRBLwMEMP40MRBYgVoYgRBLwNEIzIQg4oxo4mDgBy6ADI4x4BpWBgWMRA4BcTXgbgJXQIGQJrOoondgIojgy8MCJfWAHEWkhwcgDQFYBE7gkUMBkCGolvGEAQVZEUTB4l5QdlrgVgVKoYM0PkMl6GC2Uhif6FiTAyQyOEEYmuoGDJA54MFHkFpEH4CFd8B5a+C8qWhfGSAzgcL+KAL4gDImlnQ+OBAxzAdD0BWC0o685D4DKcZSDMMFIb/gHgCAyRoUAAo8ZWhC44CnAAAG0Q53hsnjaEAAAAASUVORK5CYII=>

[image9]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAsAAAAXCAYAAADduLXGAAAAoElEQVR4XmNgGJSAEYhV0QWxgadA/B+KiQJXGEhQDFJ4DV0QFwApjkAXxAaiGDCd0ATE/mhiYHCTAaGYC4jvAzEfEH+Dq0ACIIW3gVgQiDdCxX5CxTEASHAnEM9El0AHMxgQJsyGslUQ0qgAPTJA7INQdj6SOBiAJKeh8VuQ2HDACRUQRRL7CMQbgLgHiA2RxMHAE10ACDyAmANdcBTAAACQdCSKrBERiwAAAABJRU5ErkJggg==>

[image10]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAXCAYAAACS5bYWAAABMElEQVR4Xu2TvUoDQRSFb6VYi60EsVObYCEB8QksRS3s7KwkdcA2+FNaCmIllj6DqIWFrQ8g2GihnYI5d2dWLmfI7swaCOJ88BVz7uzsYX9EMpm/ySO8g3twB27DLbjpTWGfg0Tu4Td8hms0K9DhMN/Mvhj6HEQyAT/N+kjc/W9MVqDhKlyA83DOq3kqepMmfMATyl7EdZi24YNdeG7hIocRHHMQSfkmZ0ymn6VmlyYL6MArDiNpWrYNDyk7EFe28swmr7+k8uBEXsV1meRBybm3jmUJf8Y6U5gVd80pDyy6ocVhAqN6strjjEPLrqQ/AWYUZd9hl0PmScZfVjusU3ZB64Im3xbzm7LXcIWyDW/AOMv2JPwhS6fMvh908MXhEJYkPLTOKnhv7HWZTObfMQCCq2QSsKBPZAAAAABJRU5ErkJggg==>

[image11]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAYAAAC8/X7cAAACQElEQVR4Xu2Wy6tOURjGH9c4okyYuHQGpjJzK0I5SiYylJOBMmEilz9BRgaK/0FJmcgIEybqJCWUgST3S+6X8D7Wu863vud7916Hs5V0fvX07f28l9231tprL2CK/4+takySVWr8DstNZ0ynTAskFrHfdEzNDvihRo2TSEV7/H6Z6anp03jGIEtNj9QseI7UM0u5j/74nSI2bHpV3DcyHan4igacb6bvajqsm6OmcN50Ayl3rcTITNNtNZ33ph1qKmzMkWhiM1LOFvHXmT6LF8Ha2f77RWLkgGm7ms4KxDM3zkNUEtCbobPif8XE1v4b/2U++3DESx7LvcKaITXJRqTgZfGVhUh5r8WnN1c8ZaXpkF+vR6q52gv/ojaAjJ9Qk+QRqa3h3Uh5Y4U3370a50wzinvWaN01uVcuoWGpRs0i7iLlcbvMbHKvhuYcdy/PCnvWviHc0rUPFrk5EAiI8vYGXkRe/yVlvydloIGjCJ7FaaX5UQPCLqQ83WJH3W+DX9PDahq3kGqrO4zDHmFeNLJKU84axH7JBQzuOGQeUi1nR1/oiNNoeBYbhAHnAVJ8lgbQ25naaIvzw8g436UaF00f1MywyU01jWdIu1QbrOUHKuIgUnyaBpxtaP+DJczjMaeRfF65jvRO8Hp1X0YM8/JukuGSeWt66eLIjfRl9HihRgN8Dme8c46Y3qnZMUsw8Zn6I9g8elG7gqfRnWp2CdfyPTU7YjHq56RO4Dlln5od8FeXjjKqxiTZoMYU/xI/AZZrlpk7sM3pAAAAAElFTkSuQmCC>

[image12]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEkAAAAXCAYAAABH92JbAAACIklEQVR4Xu2XPUhcQRDHR0X8SKMmwYhEwUKIhYgERBEhsfcLtRGxE0EIIqLEpEoaC6sUNoF0ImIjCCksbCy1SVCxEUFFFCxsBBX8mHFnn3vDvMM94SUc+4M/3v527rks+3b3AAKBQOD/5AVmFXOH2cDkpHan5QNmF8x350Vf0pSAGYcvS2C+t4MpFn0PVIIpKOL2S27nRhXxjGNunfYIZDbI5/AacwDm/9o8lXww9VXczuN2RVTBXGAWhdvEXAqnQQ98p7gZ4ZLCd5LWMUfCzYLyDBL9wk2zT0cX6DVXoPsk8J0kqp0TroV9RBuLVlciQ+zLhHdZA31A+6D7JPCZJPtqfRW+mn2PFWMsGq1g+tg3Ce9yDvqAtkH3SeAzSQ1gamlfdaE9jvyUFd9Y1FvBdLMfEN4lbkB/QPdJEDcmjY9gaj8JX8r+pxXDLGhWXXrZtwvvcgz6gLZA9y7vPeKDzyTVgqmlt8nlFfvvVtg9qdkKZpA9XQ/iiNuT9kD3Lh0e8cFnkuguSLWfhX/LPnqLClhkcrp9Ab0mW063lLsSiR+uQH6zd6HNvFw4qpEnILkV4ZIi3SQVYkaFo4vwX+EmQXmGtmqoHR2B8Lg0Zd0JmCPf8gZMDd1k/wXaGC22r85xdPWR9dSWi+aBBcwN/6UiuZkRy5gJKZEzzCk8rr6a1O5EoOsIHSSHHPpMzqUTzO9SiV059KvjGvMrtTsQCAQCgWzjHvgWpCiFVFFhAAAAAElFTkSuQmCC>

[image13]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABkAAAAXCAYAAAD+4+QTAAABL0lEQVR4Xu2UsUoDQRRFn2lE0iWIgl20MI2IhUEQGysLC8WooGKltYWVZT7AwjI/IFZaWfgL+hWitaAINhLvZd7KeNkZRRAs9sBlmTNvZpadx5pV/GfqyA0yQG6Roa/TSVjfRw6QXWTbs4WsRHU2YaF4xMdNH9c+K9KwLpXTqM5ekYtYgDvkTVwZj8g8Mo1MIS2kjbzERYSnboo7cZ9jAVlVaSXrllwuit933xD/HdfInMojC5vpRNd9R3wOfqpnlaRnYbMZ8Wvud8TneEcmVZJDC5vNit9wvyw+xaiV3EVBcSe8xJg992zvn/BgmUOG7ffdFcPabD0nz8SxS3QRm2FMXAFrn1TGlL01x+vRmL+Z1NuOW/D3OqGcW+gOPrmAra1cIccqHa65VFlR8bd8AF/AR66dncsdAAAAAElFTkSuQmCC>

[image14]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAcAAAAXCAYAAADHhFVIAAAAaElEQVR4XmNgGHigAMT30QVh4C0Q/0cXpAx0AnECuiAI/IDSIPsckSVmAjETlA2SdEWSY6iF0v0MeFwKkihEFwSBPAaELmEgNkGSA0u8g7IfI0uAwDMgPsQAsT8TTQ4MAoBYDF1w6AAA4oAS3/pLqloAAAAASUVORK5CYII=>

[image15]: <data:image/png;base64,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>

[image16]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFgAAAAXCAYAAACPm4iNAAADrUlEQVR4Xu2YWahNYRTHl3kMGZO4ZcwQ8SLCAx6IMiVEokh4IskD7jWEMmR4ER5uxpTMUcSLIQ8UkcKDZCZDkTHD+vvWumeddb59nVv7KLV/9e/s9V/f2d/e63zD3ocoIyMjo8bUYZWzdrNGGr8eq7WJ/yfGs9awBhqvtzn+J9Rn/RLtYg1lTZS4I+snq09V63TAuRd5M0UGUOhjFKsFa4XEr1lTTLvh4rcyXqr0pdDBdZ8QPlHIp1ngCRTO+dknUgTn7+C8puLbAt8SDz9ASdCRmwSWjbQLDDp7I0UwA5Pu6Q7lFxikfW9VnKVwIVN9wlGKApcSXd66+wQzmQoLXDL+NnqVg1RY4K6sK6yrrJkuB2qz9rAes9aylpjcbNZ61hHjTWetYh2SGGv/Zqp+6m5gPWRtdD42Zb23cS5nac9ayNpGuaLXYs2hcM4d4g1i7WcNkRhglhxgLTdeAcUW2HON9cDEKMQXE+uykhRvlRibp6KbEHSeckvIK/EsncTrJ/FiiS3nxLM6nNeCqCfruORWiocNf4t491hvKAyWhuKdZr1glUn7t+JH0Y5rwnyKfwfeZTnGqPBtTrgYeVtggFECv5fx+ouHkaUgvmRi9Y46D0uf3qOVB54W2Hq+Le4BHmavgtHt21URO8nfSPrORcr5LeUY2k5hxHmQ8wWuFN+CUQYPIwi0kXgeq53RB9YPaRMDP9p7Ct895nLwiikwZoD3dABE+U4hiceX6sCIbCvHsY6BTjUsB2CGxCrcnAWeLzDWbH9ujBZ4jSTG+oh4KYWXIasR0gb7RV059sSuH3ExBdYZZkFf8LCMFDCaQvKUTzgemeNYxwCbnfoNbIJZTSFXYbxYgfEG6c/dRbzGEveQGIVOYgFrljeFM1TYR7EF3hfxMDMSCwyeU2iAxT0GduTbJr5BhZ0AnQ2gnLXM5AAe6LHxKLECV4pv0RHcxHiI75pYuS+fmHHvbMLwhPXRecUWODaC8doNT2duFHSKRt2cj1HjTwjg7TQxdnN4zSWukNiCnRfTWIkVGDPJf2+weGXGGybeWOOtEx/oJnsyl/4DXpnhN3M+vE0Rz1+LPplY9FUb+0C1TKPcKPwmnxfyWuSzl3IXcZPy17wK1iTKPWJBcyWHdnj0eSrStRmf+KHx3IwfA3/Q4NHvmXj4xGu7ghvSRyRojMmhwLgf/SGgr/KJJUZBHy8p9IuZjDYoPv6vQJ8QjnHN/vrw/ItXfdyDXl/SrMnIyMjIyMjIKJLfpccqTNsvc1UAAAAASUVORK5CYII=>

[image17]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGYAAAAYCAYAAAAI94jTAAACvElEQVR4Xu2Y26tNURTGx3FJRFISSk5CFLkm4VEelEvycLyQJHKJ3P4BLx6UIg8SJUpKkjwRnZNLIrc8iCK3klzOOcitXL7PGPPscWaW1ou911rmr77WmN+cc+8x55p7zbm2SCKRSCQSif+aT9D12KwQS6CfsVkGmPTm2KwQr6WEN2aSaNI94ooKwfGdjs2iMgeaD50XTXyBlatCH9HxUBzfDot7+0ZFZAu0TTTpt1amqsJk0fGEhVe68THpjbFZIUq5v0wUTboprmggzdD0nBquXf4Kx3cqNovOSSneapoGLcyp8dYnCy44jo8HnFLBpN/FZoXYIMVbeLlg0jwABC7btQW6Lfq4uAUdh+6ERsYI0UPDGeiaeaOgs9CR0Ah8s+sHaLHz60G8v3S6mFyADkH7oYtR3V3ohOhnBJqh96LzcdD5R0Vf0J84j2yHroj2yeN3waRHW/zV+UxordQmlfgBcm9648ovoHmiJ6Ah0Gfz+cZ90+J10CqL6wVzZm5kE7TM1T2Aplq8UzT3APv1dDHh60WHxfws/ltCeLPHWTxAtF3gmV2Zw7Acfhe7Rb/4C9QrqmOnWa7sbwzjoa7MX856i9ug1RZz1XEvIP2ggRbXi77QD9F8V0S+Hw8nKkzoAeixqwuw/cjIm2D+OegjtKZ79e86amZOPxc+8a2ij6yAr4vLWfE+FzcaPoYeubLP8zu01JUD8ZgJX1qfx6bBhciXWc6d75vl58Z34qobJLXB+Dr+x3bJlbNuzF4XN5rZ0GGLx0otzylQq+hjORBuUjyJD0VPhe3OGwwtF32k/WkesvzczIX2uPIu6AbU38ozRFcWf/IrQyOD+wj3mFfQIugldLVbi2LwFLon+gjjPuEPNxwX/1vjNYx5jOgJlgekY+YRHhzui27kPCwFuIhbRQ9Pniw/kUgkEol/yi9wD7HqeVlbDgAAAABJRU5ErkJggg==>

[image18]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADUAAAAYCAYAAABa1LWYAAAB6klEQVR4Xu2Xu0tcQRTGT0xQAmIs7OyC0UIECRZGtLPSLk0gVRBMo4WFjZVNwMZCUBItFFH/gPiACLEwZTRNJER8K4rBB2gjCcbX9zFz8Xgc2IUlcG+4P/hxh+8Mu3N27uzeFUlJiS2lsAMOwacqr1PjxDAOr+EabIbP4Hv4C77wtUTBBV/BJ7YAusTVl2whzlxI5l1g/aUN48qpuAU/tgVDpqZjQ5W4xa7aQoDENHUpbrGhc5RY2FBidiBb/rumHopr6MAWAiSq8Wx2qha+sWGc2RDXFHctBPNDG4JOOAO34LSptcKf8Aus8dkDcXfEGNz1GXkFj+EsfK5yPskw/w4rVF4Ef8M5+Frl92BT/PG1jfFNjkxG2uFHP86Xuzs9BXv9+AS+E9eQnhONR+GEyrnQiGgOP6APgbwcLqs8yGe5vRXP/JUvGEIvsEXCi9GswBEbipv7CW7K3eaiGh00OR/jmM+bPCf49K4Xvg3r/bhJwk0xK7GhhOeS6I7hIxnnVKoaaYR/YZvJc0IvJhpPwgJ4rmp5cBj+gYUq7/FX2xTPD2H+yI+3/TXKq/14FBbflnKnHy7AAXG3zVdV4xlahHvwrcp56Hnevok7Y6RBXMP7sNtnpA/+EPclVqZyfjHswHVxf4tSUlL+MTfRk3a6B+8HbAAAAABJRU5ErkJggg==>

[image19]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADUAAAAYCAYAAABa1LWYAAAB6UlEQVR4Xu2VzStFQRjGXzY+slIWSnaUhAWRUmyElIWthYWNlT+A8hFZWkpWsiQfK2UjGykrUjYK2RA2iuTb+5g53fE459xz7qXc3F89Ned5574zc2fmHZEsWf4NraoFVQ/5Gcubqta2F1UnTiwjeWVDeWcjkxhRVZFXKBm+KL/Jz6ue2fxN2lXrqiEOpECeatq2q1UVqlLxX2gUcCeXVL0cUDrZAA1iBmuz38P222PWaUdlQpWv2hWTC8L9GnQ7ReRSEjmgHSdWJGb3v1AjpmMx+fCWbdvvsifjkQ0lV+Lv1Kpq3/n2NsDDt5KiwwWbYsowYk2qPopF4YENC3I2sxnCPRvKmGrctjcd/5M2MYN0kA/OJbHdcSkQM7AfyId/O12exNyxb+B4BU36SEwMlzsuk2JKN9MowePFBXnu2ATjEjzIgQTHRtkg8C+WsSkm3zabyoCqhM0kIFcLmx4Ioty64PKt2BiYcWJr1t9wPAaLOiXvUHVGHqiT1I55aH9UPVQ3L/GcE8PE4PU7HvpfW98PHLspVb0k8t6outxOxJ6YnHFIpSIn5ZYNCxaEQhGXFzZC8B7iH6VSgss8jl4qHLMRwpaqm810wRsWRND7FAbeyRw2Qwg6+mkRNoFyNiIQ9zdXbGTJ8gf4AFxDbhqYoEdoAAAAAElFTkSuQmCC>