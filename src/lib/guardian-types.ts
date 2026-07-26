export type SessionStateEnum = 'INACTIVE' | 'SOFT_WATCH' | 'ACTIVE' | 'BREAK' | 'COMPLETE';

export type GuardianTone =
  | 'neutral'
  | 'flow_confirmed'
  | 'direct_push'
  | 'grounding_nudge'
  | 'break_suggestion'
  | 'midpoint_checkin'
  | 'final_push'
  | 'personal_best'
  | 'override_review';

export type GuardianCommandType = 'block' | 'unblock' | 'classify' | 'session_state';

export type GuardianDecisionType = 'silence' | 'speak' | 'block' | 'unblock' | 'classify' | 'nudge';

export type GuardianDecisionSource = GuardianEventType | 'system';

export type GuardianEventType =
  | 'tab'
  | 'idle'
  | 'heartbeat'
  | 'voice'
  | 'override_request'
  | 'override_decision'
  | 'session_state'
  | 'screen_vision'
  | 'native_context'
  | 'guidance_request'
  | 'guidance_response';

export interface GuardianEvent {
  sessionId: string;
  type: GuardianEventType;
  timestamp: number;
  url?: string;
  title?: string;
  domain?: string;
  dwellSeconds?: number;
  tabStartedAt?: number; // epoch ms when the dwelled tab became active — used for exact started_at
  prevUrl?: string;
  prevTitle?: string;
  idleSeconds?: number;
  transcript?: string;
  tabGroupId?: number;
  tabGroupTitle?: string;
  tabGroupColor?: string;
  payload?: Record<string, unknown>;
}

export interface ScreenVisionSignal {
  taskAlignment: number; // 0-100: how aligned screen content is with session goal
  engagementDepth:
    | 'active_creation'      // coding, writing, designing
    | 'active_learning'      // note-taking, tutorial-following, reading with notes
    | 'passive_consumption'  // watching/reading without interaction
    | 'idle'                 // screen unchanged, no user interaction
    | 'distraction';         // clearly off-topic content
  appInFocus: string;        // e.g. "Visual Studio Code", "Google Chrome"
  windowTitle: string;       // e.g. "attention.py — ML-Project"
  contentSummary: string;    // 2-3 sentence description of what's on screen
  specificContent: string;   // exact: video title, filename, paper section, etc.
  distractionIndicators: string[]; // e.g. ["Slack notification visible", "Twitter tab open"]
  progressIndicator: string; // e.g. "new code since last capture", "scrolled further in paper"
  confidence: number;        // 0.0-1.0
  changeFromPrevious: 'none' | 'minor' | 'moderate' | 'major';
  capturedAt: number;        // epoch ms
}

export interface ScreenContext {
  latestObservation: ScreenVisionSignal | null;
  recentObservations: ScreenVisionSignal[]; // ring buffer, last 15
  visionTrend: 'improving' | 'stable' | 'declining' | 'unknown';
  taskAlignmentAvg: number;   // rolling ~3-min average of taskAlignment
  engagementDepth: ScreenVisionSignal['engagementDepth'] | 'unknown';
  dominantActivity: string;   // short description of what user has been mostly doing
  lastSignificantChange: number; // epoch ms of last major screen change
  contextNarrative: string;   // LLM-generated narrative updated every 5 min
  captureState: 'deep_focus' | 'normal' | 'heightened' | 'guidance_burst';
  narrativeUpdatedAt: number; // epoch ms when contextNarrative was last generated
}

export interface GuardianCommand {
  id: string;
  type: GuardianCommandType;
  sessionId?: string;
  reason?: string;
  explainability?: string;
  conceptTitle?: string;
  urlPattern?: string;
  targetDisplay?: string;
  ttlSeconds?: number;
  interventionPolicy?: GuardianInterventionPolicy;
  sourceEventType?: GuardianDecisionSource;
  createdAt: number;
}

export interface GuardianInterventionPolicy {
  mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
  headline: string;
  tone: 'firm' | 'gentle' | 'urgent';
  contextLine: string;
  overridePrompt: string;
  overrideOptions: Array<{ minutes: number; label: string; default?: boolean }>;
  minReasonChars: number;
  frictionSeconds: number;
}

export interface GuardianDecision {
  type: GuardianDecisionType;
  sessionId?: string;
  createdAt?: number;
  sourceEventType?: GuardianDecisionSource;
  tone?: GuardianTone;
  text?: string;
  reason?: string;
  explainability?: string;
  command?: GuardianCommand;
}

export interface OverrideRequest {
  sessionId: string;
  url: string;
  title?: string;
  reason: string;
  requestedMinutes?: number;
  idempotencyKey?: string;
}

export interface OverrideDecision {
  approved: boolean;
  reason: string;
  explainability: string;
  ttlMinutes: number;
  reviewedAt: string;
}

export interface ActiveOverride {
  id: string;
  urlPattern: string;
  title?: string;
  reason: string;
  approvedAt: number;
  expiresAt: number;
  explainability: string;
}

export interface GuardianState {
  sessionId: string;
  state: SessionStateEnum;
  goalId: string | null;
  goalTitle?: string | null;
  conceptNodeId: string | null;
  conceptNodeName: string | null;
  durationMinutes: number;
  mood: 'high' | 'medium' | 'low' | null;
  startedAt: number;
  endsAt: number;
  tick: number;
  tabEventLog: GuardianEvent[];
  focusScoreHistory: number[];
  blockedCount: number;
  overrideCount: number;
  currentUrl: string;
  currentTitle: string;
  currentClassification: 'on_topic' | 'distraction' | 'unknown';
  lastSpeechAt: number | null;
  lastDecisionAt: number | null;
  lastIntervention?: GuardianDecision | null;
  activeOverrides: ActiveOverride[];
  emittedMilestones: string[];
  targetTitle: string;
  personalBestFocusScore: number | null;
  energyComposite: number | null; // [0–100] computed at session start
  // Intelligence layer — zero hardcoded lists
  sessionClassificationCache: Record<string, 'on_topic' | 'distraction' | 'unknown'>;
  immediateBlockDomains: string[]; // AI-derived per-session block list sent to extension at start
  currentTabStartedAt: number | null; // tracks when user navigated to currentUrl for final-dwell flush
  intentProfile: SessionIntentProfile | null;
  sessionPolicy: GuardianPolicyBundle | null;
  screenContext: ScreenContext | null; // populated by screen_vision events, null until first capture
}

export interface SoftWatchCommitment {
  id: string;
  targetTitle: string;
  goalId: number | null;
  taskId: number | null;
  intendedStartAt: number;
  plannedMinutes: number;
  source: 'voice' | 'dashboard' | 'calendar' | 'telegram';
  reminderSentAt: number | null;
  checkInSentAt: number | null;
  status: 'pending' | 'locked_in' | 'expired' | 'dismissed';
  lockedInSessionId: string | null;
  calendarEventId: string | null;
  createdAt: number;
}

export interface GuardianStartRequest {
  transcript?: string;
  topic?: string;
  goalId?: string | null;
  goalTitle?: string | null;
  conceptNodeId?: string | null;
  conceptNodeName?: string | null;
  durationMinutes?: number;
  mood?: 'high' | 'medium' | 'low' | null;
  source?: 'voice' | 'dashboard' | 'extension' | 'api';
  sessionContext?: string;  // free-form context: what they'll be doing, tools, tab-switching intent, etc.
}

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

export interface GuardianPolicyBundle {
  version: string;
  prompts: {
    interventionPrompt: string;
    overrideRubric: string;
    retrievalPrompt: string;
    sessionPlannerPrompt: string;
    voicePolicyPrompt: string;
    redTeamRules: string;
  };
  thresholds: {
    speechCooldownMs: number;
    flowSilenceThreshold: number;
    distractionRevisitBlockCount: number;
    distractionTabSwitchBlockCount: number;
    highScatterSpeakThreshold: number;
    idleConcernSeconds: number;
    focusDropSpeakThreshold: number;
    lowFocusThreshold: number;
    dwellDepthTargetSeconds: number;
    stableFlowMinDwellSeconds: number;
    stableFlowMaxTabSwitches: number;
    flowConfirmationScore: number;
    flowConfirmationMinElapsedMinutes: number;
    lowEnergyThreshold: number;
  };
  weights: {
    continuity: number;
    switches: number;
    dwell: number;
    distractionPenalty: number;
    idlePenalty: number;
  };
}

export interface PolicyArtifactVersion {
  id: number;
  artifactType: string;
  version: string;
  content: string;
  guardianEvalScore: number;
  isActive: number;
  createdAt: string;
  promotedAt: string | null;
  notes: string | null;
}

export interface EvalRun {
  id: number;
  artifactVersionId: number | null;
  suiteName: string;
  wallClockBudgetSeconds: number;
  primaryMetric: string;
  guardianEvalScore: number;
  hardFailures: number;
  status: 'pending' | 'passed' | 'failed';
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface GuardianEvalScenario {
  durationMinutes: number;
  mood?: 'high' | 'medium' | 'low' | null;
  targetTitle: string;
  events: Array<{
    type: 'tab' | 'idle' | 'heartbeat';
    url?: string;
    title?: string;
    dwellSeconds?: number;
    idleSeconds?: number;
  }>;
  expected: {
    mustBlock?: boolean;
    mustSpeak?: boolean;
    maxBlockCount?: number;
    maxSpeakCount?: number;
    finalClassification?: 'on_topic' | 'distraction' | 'unknown';
  };
}

export interface GuardianEvalCaseRecord {
  id: number;
  suiteName: string;
  caseName: string;
  scenarioType: string;
  inputPayload: string;
  expectedOutcome: string | null;
  active: number;
  createdAt: string;
}

export interface GuardianEvalCaseResult {
  caseId: number;
  caseName: string;
  passed: boolean;
  score: number;
  hardFailure: boolean;
  reasons: string[];
}

export interface GuardianEvalSummary {
  suiteName: string;
  guardianEvalScore: number;
  hardFailures: number;
  caseResults: GuardianEvalCaseResult[];
}

export interface GuardianSessionSummary {
  id: number;
  sessionId: string;
  targetTitle: string;
  goalTitle: string | null;
  conceptNodeName: string | null;
  mood: 'high' | 'medium' | 'low' | null;
  durationMinutes: number;
  elapsedMinutes: number;
  averageFocusScore: number;
  finalFocusScore: number;
  blockedCount: number;
  overrideCount: number;
  distractionEvents: number;
  productiveEvents: number;
  neutralEvents: number;
  dominantDistractionDomain: string | null;
  completedAt: string;
}

export interface GuardianSemanticProfile {
  id: number;
  userId: string;
  coachingStyle: 'gentle' | 'balanced' | 'direct';
  typicalEnergyBand: 'low' | 'medium' | 'high';
  bestStartHour: number | null;
  recurringDistractionDomains: string[];
  strongTopics: string[];
  frictionTopics: string[];
  updatedAt: string;
}

export interface GuardianSessionReflection {
  id: number;
  sessionId: string;
  reflectionText: string;
  focusQuality: 'excellent' | 'good' | 'neutral' | 'poor';
  generatedAt: string;
}

export interface DayBriefing {
  recentSessions: number;
  avgFocusScore: number;
  activeGoals: string[];
  activeTasks: string[];
  upcomingFocusTarget: string | null;
  bestStartHour: number | null;
  recurringDistractions: string[];
  coachingStyle: 'gentle' | 'balanced' | 'direct';
  energyForecast: 'low' | 'medium' | 'high';
  openingMessage: string;
  recentReflections: GuardianSessionReflection[];
  upcomingCommitments: SoftWatchCommitment[];
  personalization?: {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
    recommendedSessionMinutes: number;
    energy: 'low' | 'medium' | 'high';
    mood: 'low' | 'medium' | 'high' | null;
    standupGoal: string | null;
    alertFatigueLevel: 'low' | 'medium' | 'high';
    recentAlerts: number;
    nextBestFocusWindow: string;
  };
  adaptiveTasks?: Array<{
    id: number;
    title: string;
    priority: string;
    score: number;
    reason: string;
    momentFit: 'high' | 'medium' | 'low';
    estimatedMinutes: number | null;
    energyRequired: 'low' | 'medium' | 'high' | null;
  }>;
}
