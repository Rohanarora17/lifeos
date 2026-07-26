/**
 * Screen Vision Engine
 *
 * Analyzes screenshots with session-aware context to produce ScreenVisionSignal.
 * Handles change detection (skip redundant Gemini calls), adaptive capture rate
 * state machine, and context narrative generation.
 *
 * Runs on the Mac Mini server — receives screenshots from the MacBook client
 * daemon via /api/guardian/vision, or falls back to local screencapture when
 * no client is connected.
 */

import { ScreenVisionSignal, ScreenContext, GuardianState } from './guardian-types';
import { generateWithFallback, getGenAI } from './ai';
import { MODEL_VISION } from './models';
import { getDb } from './db';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';
import { getAdaptiveBands } from './adaptive-bands';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// MacBook client connection tracking
// ---------------------------------------------------------------------------

let macbookClientLastSeen = 0;

export function updateMacbookClientHeartbeat(): void {
  macbookClientLastSeen = Date.now();
}

/** True when the MacBook vision client sent a heartbeat within the last 30 seconds. */
export function isMacbookClientConnected(): boolean {
  return Date.now() - macbookClientLastSeen < 30_000;
}

// ---------------------------------------------------------------------------
// Sensitive app skip list — check frontmost app BEFORE capturing
// ---------------------------------------------------------------------------

const DEFAULT_SENSITIVE_APPS = [
  '1password',
  'bitwarden',
  'lastpass',
  'keychain access',
  'ssh',
  'gnupg',
  'terminal', // only skip if window title contains sensitive patterns
];

const SENSITIVE_TITLE_PATTERNS = [
  /password/i,
  /private key/i,
  /secret/i,
  /\.pem\b/i,
  /\.key\b/i,
];

const SENSITIVE_FULL_APP_SKIP = ['1password 8', '1password 7', 'bitwarden', 'lastpass', 'keychain access'];
const SENSITIVE_COMMUNICATION_APPS = [
  'whatsapp',
  'facetime',
  'messages',
  'signal',
  'telegram',
  'zoom',
  'microsoft teams',
  'webex',
];
const SENSITIVE_CALL_TITLE_PATTERNS = [
  /meet\.google\.com/i,
  /google meet/i,
  /video call/i,
  /video meeting/i,
];

export function isSensitiveApp(appName: string, windowTitle: string): boolean {
  const appLower = appName.toLowerCase();
  if (SENSITIVE_FULL_APP_SKIP.some((a) => appLower.includes(a))) return true;
  if (SENSITIVE_COMMUNICATION_APPS.some((a) => appLower.includes(a))) return true;
  if (SENSITIVE_CALL_TITLE_PATTERNS.some((pattern) => pattern.test(windowTitle))) return true;
  if (
    DEFAULT_SENSITIVE_APPS.some((a) => appLower.includes(a)) &&
    !appLower.includes('terminal') &&
    !appLower.includes('iterm')
  ) {
    return true;
  }
  if (appLower.includes('terminal') || appLower.includes('iterm')) {
    return SENSITIVE_TITLE_PATTERNS.some((p) => p.test(windowTitle));
  }
  return false;
}

// ---------------------------------------------------------------------------
// pHash-based change detection (simple luminance block hash)
// ---------------------------------------------------------------------------

const HASH_EDGE = 64;
const HASH_BITS = HASH_EDGE * HASH_EDGE;

// Compute a 4,096-bit average hash from decoded luminance pixels.
export async function computeImageHash(base64Jpeg: string): Promise<string> {
  const bytes = Buffer.from(base64Jpeg, 'base64');
  const { data, info } = await sharp(bytes)
    .rotate()
    .greyscale()
    .resize(HASH_EDGE, HASH_EDGE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== HASH_EDGE
    || info.height !== HASH_EDGE
    || info.channels !== 1
    || data.length !== HASH_BITS
  ) {
    throw new Error('Unable to decode screenshot luminance');
  }
  const samples = Array.from(data);
  const avg = samples.reduce((a, b) => a + b, 0) / HASH_BITS;
  let bits = '';
  for (const v of samples) {
    bits += v >= avg ? '1' : '0';
  }
  // Convert bits to hex
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const bitsA = parseInt(a[i], 16).toString(2).padStart(4, '0');
    const bitsB = parseInt(b[i], 16).toString(2).padStart(4, '0');
    for (let j = 0; j < 4; j++) {
      if (bitsA[j] !== bitsB[j]) dist++;
    }
  }
  return dist;
}

// Returns change magnitude based on hamming distance out of 4,096 bits.
export function getChangeMagnitude(
  currentHash: string,
  prevHash: string | null,
): ScreenVisionSignal['changeFromPrevious'] {
  if (!prevHash) return 'major';
  const dist = hammingDistance(currentHash, prevHash);
  if (dist <= 12) return 'none';
  if (dist <= 128) return 'minor';
  if (dist <= 768) return 'moderate';
  return 'major';
}

export function decideVisionAnalysis(input: {
  pixelChange: ScreenVisionSignal['changeFromPrevious'];
  previousApp: string | null;
  previousWindowTitle: string | null;
  appInFocus: string;
  windowTitle: string;
  lastAnalyzedAt: number;
  now: number;
}): {
  analyze: boolean;
  changeFromPrevious: ScreenVisionSignal['changeFromPrevious'];
  reason: 'changed' | 'metadata_changed' | 'no_change' | 'rapid_duplicate';
} {
  const hasPreviousMetadata = input.previousApp !== null || input.previousWindowTitle !== null;
  const metadataChanged = hasPreviousMetadata && (
    input.previousApp !== input.appInFocus
    || input.previousWindowTitle !== input.windowTitle
  );
  if (metadataChanged) {
    return {
      analyze: true,
      changeFromPrevious: input.pixelChange === 'none' ? 'minor' : input.pixelChange,
      reason: 'metadata_changed',
    };
  }
  if (input.pixelChange === 'none') {
    return { analyze: false, changeFromPrevious: 'none', reason: 'no_change' };
  }
  if (input.pixelChange === 'minor' && input.now - input.lastAnalyzedAt < 2_000) {
    return { analyze: false, changeFromPrevious: 'minor', reason: 'rapid_duplicate' };
  }
  return {
    analyze: true,
    changeFromPrevious: input.pixelChange,
    reason: 'changed',
  };
}

// ---------------------------------------------------------------------------
// Adaptive capture rate state machine
// ---------------------------------------------------------------------------

export type CaptureState = ScreenContext['captureState'];

export interface CaptureStateDecision {
  state: CaptureState;
  intervalMs: number;
  reason: string;
  momentMode: PersonalizationSnapshot['moment']['mode'] | 'unknown';
}

let capturePersonalizationCache: {
  sessionId: string;
  expiresAt: number;
  snapshot: PersonalizationSnapshot;
} | null = null;

function clampInterval(ms: number, minMs: number, maxMs: number): number {
  return Math.max(minMs, Math.min(maxMs, Math.round(ms / 1000) * 1000));
}

function getVisionPersonalization(session: GuardianState): PersonalizationSnapshot | null {
  const now = Date.now();
  if (
    capturePersonalizationCache &&
    capturePersonalizationCache.sessionId === session.sessionId &&
    capturePersonalizationCache.expiresAt > now
  ) {
    return capturePersonalizationCache.snapshot;
  }

  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'screen_vision',
      maxInsights: 1,
      includeMemoryFacts: 2,
      activeSession: {
        sessionId: session.sessionId,
        targetTitle: session.targetTitle,
        focusScore: session.focusScoreHistory.at(-1) ?? null,
        elapsedMinutes: Math.round((Date.now() - session.startedAt) / 60_000),
      },
    });
    capturePersonalizationCache = {
      sessionId: session.sessionId,
      expiresAt: now + 15_000,
      snapshot,
    };
    return snapshot;
  } catch (err) {
    console.warn('[Vision] Personalization unavailable for capture cadence:', err);
    return null;
  }
}

function tuneCaptureInterval(
  state: CaptureState,
  baseIntervalMs: number,
  snapshot: PersonalizationSnapshot | null,
  score: number,
): CaptureStateDecision {
  const bands = getAdaptiveBands();
  const reasons: string[] = [`base ${state}`];
  let multiplier = 1;

  if (snapshot) {
    if (snapshot.moment.mode === 'protect_focus' && state !== 'heightened' && score >= bands.focusGood) {
      multiplier *= 1.35;
      reasons.push(`protecting strong focus (${Math.round(bands.focusGood)}+ learned band)`);
    }
    if (snapshot.moment.mode === 'deadline_pressure' || snapshot.today.overdueTasks > 0) {
      multiplier *= 0.8;
      reasons.push('deadline pressure');
    }
    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
      multiplier *= state === 'heightened' ? 1.1 : 1.3;
      reasons.push('low-energy recovery mode');
    }
    const distractionTolerance = Math.max(10, Math.round(bands.dailyCapacityMinutes * 0.22));
    if (snapshot.today.recentDistractionMinutes >= distractionTolerance && state !== 'deep_focus') {
      multiplier *= 0.85;
      reasons.push(`${snapshot.today.recentDistractionMinutes}m recent distraction over ${distractionTolerance}m tolerance`);
    }
    if (snapshot.feedback.alertFatigueLevel === 'high') {
      multiplier *= 1.25;
      reasons.push('alert fatigue high');
    }
    if (snapshot.feedback.helpfulRate !== null && snapshot.feedback.helpfulRate < 0.4) {
      multiplier *= 1.15;
      reasons.push('recent interventions rated low');
    }
  }

  const minMs = state === 'guidance_burst' ? 5_000 : 7_000;
  const maxMs = state === 'deep_focus' ? 45_000 : 30_000;
  return {
    state,
    intervalMs: clampInterval(baseIntervalMs * multiplier, minMs, maxMs),
    reason: reasons.join('; '),
    momentMode: snapshot?.moment.mode ?? 'unknown',
  };
}

export function computeCaptureState(
  session: GuardianState,
  currentCaptureState: CaptureState,
): CaptureStateDecision {
  const bands = getAdaptiveBands();
  const score = session.focusScoreHistory.at(-1) ?? bands.focusNeutral;
  const screenCtx = session.screenContext;
  const recentDepths = screenCtx?.recentObservations.slice(-3).map((o) => o.engagementDepth) ?? [];
  const personalization = getVisionPersonalization(session);

  // Downshift from guidance_burst after 30s (handled by caller via timestamp)
  if (currentCaptureState === 'guidance_burst') {
    return tuneCaptureInterval('guidance_burst', 5_000, personalization, score);
  }

  const allActiveCreation = recentDepths.length >= 3 && recentDepths.every((d) => d === 'active_creation');
  if (score >= bands.focusExcellent && allActiveCreation) {
    return tuneCaptureInterval('deep_focus', Math.round(bands.deepWorkMinMinutes * 1000), personalization, score);
  }

  const trend = screenCtx?.visionTrend ?? 'unknown';
  if (score < bands.focusNeutral || trend === 'declining') {
    const heightenedBase = Math.max(7_000, Math.round(bands.sessionGapMinutes * 1000 * 1.8));
    return tuneCaptureInterval('heightened', heightenedBase, personalization, score);
  }

  const normalBase = Math.max(10_000, Math.round(bands.sessionGapMinutes * 1000 * 2.6));
  return tuneCaptureInterval('normal', normalBase, personalization, score);
}

// ---------------------------------------------------------------------------
// Session-aware Gemini Vision analysis
// ---------------------------------------------------------------------------

export interface AnalyzeScreenshotInput {
  base64Jpeg: string;
  appInFocus: string;
  windowTitle: string;
  sessionGoal: string;
  sessionTopic: string;
  elapsedMinutes: number;
  currentFocusScore: number;
  changeFromPrevious: ScreenVisionSignal['changeFromPrevious'];
}

const ENGAGEMENT_DEPTHS = new Set<ScreenVisionSignal['engagementDepth']>([
  'active_creation',
  'active_learning',
  'passive_consumption',
  'idle',
  'distraction',
]);

type VisionModelOutput = Pick<
  ScreenVisionSignal,
  | 'taskAlignment'
  | 'engagementDepth'
  | 'contentSummary'
  | 'specificContent'
  | 'distractionIndicators'
  | 'progressIndicator'
  | 'confidence'
>;

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

export function parseVisionAssessment(text: string): VisionModelOutput | null {
  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (
      typeof parsed !== 'object'
      || parsed === null
      || !Number.isFinite(parsed.taskAlignment)
      || Number(parsed.taskAlignment) < 0
      || Number(parsed.taskAlignment) > 100
      || typeof parsed.engagementDepth !== 'string'
      || !ENGAGEMENT_DEPTHS.has(parsed.engagementDepth as ScreenVisionSignal['engagementDepth'])
      || !boundedString(parsed.contentSummary, 1_000)
      || !boundedString(parsed.specificContent, 500)
      || !boundedString(parsed.progressIndicator, 500)
      || !Number.isFinite(parsed.confidence)
      || Number(parsed.confidence) < 0
      || Number(parsed.confidence) > 1
      || !Array.isArray(parsed.distractionIndicators)
      || parsed.distractionIndicators.length > 20
      || !parsed.distractionIndicators.every((item) => boundedString(item, 200))
    ) {
      return null;
    }
    return parsed as VisionModelOutput;
  } catch {
    return null;
  }
}

export async function analyzeScreenshot(input: AnalyzeScreenshotInput): Promise<ScreenVisionSignal | null> {
  const ai = getGenAI();

  const prompt = `You are analyzing a screenshot taken during a focus session.

Session context:
- Goal: "${input.sessionGoal}"
- Topic: "${input.sessionTopic}"
- Duration so far: ${input.elapsedMinutes} minutes
- Current focus score: ${input.currentFocusScore}/100
- Active app: ${input.appInFocus}
- Window title: ${input.windowTitle}

Analyze the screenshot and return ONLY valid JSON matching this exact structure:
{
  "taskAlignment": <0-100, how aligned screen content is with the session goal>,
  "engagementDepth": <one of: "active_creation"|"active_learning"|"passive_consumption"|"idle"|"distraction">,
  "contentSummary": "<2-3 sentences describing what is visible on screen>",
  "specificContent": "<exact content: video title, filename, paper section, website name, etc.>",
  "distractionIndicators": [<array of strings, e.g. "Slack notification visible", "Twitter tab in background">],
  "progressIndicator": "<what progress is evident, e.g. 'new code since last capture' or 'further in document'>",
  "confidence": <0.0-1.0>
}

engagementDepth definitions:
- active_creation: user is actively writing code, typing text, designing, building
- active_learning: reading with notes open, following tutorial with practice, annotating
- passive_consumption: watching video, reading without interaction, browsing
- idle: screen content unchanged, cursor not moving, user appears away
- distraction: content clearly unrelated to session goal (social media, entertainment, news)

Return ONLY the JSON object, no markdown, no explanation.`;

  const result = await generateWithFallback(ai, {
    model: MODEL_VISION,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: input.base64Jpeg,
            },
          },
          { text: prompt },
        ],
      },
    ],
    config: { temperature: 0.1 },
  });

  const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = parseVisionAssessment(text);
  if (!parsed) return null;

  return {
    taskAlignment: parsed.taskAlignment,
    engagementDepth: parsed.engagementDepth,
    appInFocus: input.appInFocus,
    windowTitle: input.windowTitle,
    contentSummary: parsed.contentSummary,
    specificContent: parsed.specificContent,
    distractionIndicators: parsed.distractionIndicators,
    progressIndicator: parsed.progressIndicator,
    confidence: parsed.confidence,
    changeFromPrevious: input.changeFromPrevious,
    capturedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// ScreenContext updater — maintains rolling window + trend
// ---------------------------------------------------------------------------

const RING_BUFFER_SIZE = 15;

export function updateScreenContext(
  existing: ScreenContext | null,
  signal: ScreenVisionSignal,
  captureState: CaptureState,
): ScreenContext {
  const prev = existing ?? {
    latestObservation: null,
    recentObservations: [],
    visionTrend: 'unknown' as const,
    taskAlignmentAvg: signal.taskAlignment,
    engagementDepth: signal.engagementDepth,
    dominantActivity: signal.contentSummary,
    lastSignificantChange: signal.capturedAt,
    contextNarrative: '',
    captureState,
    narrativeUpdatedAt: 0,
  };

  const recentObservations = [...prev.recentObservations, signal].slice(-RING_BUFFER_SIZE);

  // Rolling average over all observations in window
  const taskAlignmentAvg =
    recentObservations.reduce((sum, o) => sum + o.taskAlignment, 0) / recentObservations.length;

  // Vision trend: compare avg of last 5 vs previous 5
  const last5 = recentObservations.slice(-5);
  const prev5 = recentObservations.slice(-10, -5);
  let visionTrend: ScreenContext['visionTrend'] = 'unknown';
  if (last5.length >= 3 && prev5.length >= 3) {
    const lastAvg = last5.reduce((s, o) => s + o.taskAlignment, 0) / last5.length;
    const prevAvg = prev5.reduce((s, o) => s + o.taskAlignment, 0) / prev5.length;
    if (lastAvg > prevAvg + 5) visionTrend = 'improving';
    else if (lastAvg < prevAvg - 5) visionTrend = 'declining';
    else visionTrend = 'stable';
  }

  // Dominant engagement depth (mode of recent observations)
  const depthCounts: Record<string, number> = {};
  for (const o of recentObservations) {
    depthCounts[o.engagementDepth] = (depthCounts[o.engagementDepth] ?? 0) + 1;
  }
  const dominantDepth = (Object.entries(depthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    signal.engagementDepth) as ScreenContext['engagementDepth'];

  const lastSignificantChange =
    signal.changeFromPrevious === 'major' || signal.changeFromPrevious === 'moderate'
      ? signal.capturedAt
      : prev.lastSignificantChange;

  // dominantActivity: description from most recent high-confidence observation
  const highConfidence = [...recentObservations].reverse().find((o) => o.confidence > 0.6);
  const dominantActivity = highConfidence?.contentSummary ?? signal.contentSummary;

  return {
    latestObservation: signal,
    recentObservations,
    visionTrend,
    taskAlignmentAvg,
    engagementDepth: dominantDepth,
    dominantActivity,
    lastSignificantChange,
    contextNarrative: prev.contextNarrative,
    captureState,
    narrativeUpdatedAt: prev.narrativeUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Context narrative generation (called every ~5 min during session)
// ---------------------------------------------------------------------------

export async function generateContextNarrative(
  recentObservations: ScreenVisionSignal[],
  sessionGoal: string,
  elapsedMinutes: number,
): Promise<string> {
  if (recentObservations.length === 0) return '';

  const ai = getGenAI();
  const observationSummary = recentObservations
    .map((o, i) => `[${i + 1}] ${o.specificContent} (${o.engagementDepth}, alignment: ${o.taskAlignment})`)
    .join('\n');

  const result = await generateWithFallback(ai, {
    model: MODEL_VISION,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Session goal: "${sessionGoal}". Elapsed: ${elapsedMinutes} minutes.

Recent screen observations (newest last):
${observationSummary}

Write a 2-3 sentence narrative describing what this person has been doing. Be specific and concrete. Focus on the work arc, not just listing observations. Do not start with "The user".`,
          },
        ],
      },
    ],
    config: { temperature: 0.3 },
  });

  return result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Persist vision signal to screen_observations table
// ---------------------------------------------------------------------------

export function persistVisionSignal(signal: ScreenVisionSignal, sessionId: string | null): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO screen_observations
      (observed_at, source, app, window_title, activity, category, content_type, attention_quality,
       specific_content, productive_for_goals, confidence, session_id,
       task_alignment, engagement_depth, distraction_indicators, progress_indicator, change_magnitude)
     VALUES
      (datetime('now','localtime'), 'screen_vision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    signal.appInFocus,
    signal.windowTitle,
    signal.contentSummary,
    // Map engagementDepth → legacy category field
    signal.engagementDepth === 'active_creation' || signal.engagementDepth === 'active_learning'
      ? 'deep_work'
      : signal.engagementDepth === 'distraction'
        ? 'distraction'
        : signal.engagementDepth === 'idle'
          ? 'idle'
          : 'consumption',
    'other',
    // Map engagementDepth → legacy attention_quality field
    signal.engagementDepth === 'active_creation' || signal.engagementDepth === 'active_learning'
      ? 'focused'
      : signal.engagementDepth === 'distraction'
        ? 'distracted'
        : signal.engagementDepth === 'idle'
          ? 'idle'
          : 'consuming',
    signal.specificContent,
    signal.taskAlignment >= 60 ? 1 : 0,
    signal.confidence,
    sessionId,
    signal.taskAlignment,
    signal.engagementDepth,
    JSON.stringify(signal.distractionIndicators),
    signal.progressIndicator,
    signal.changeFromPrevious,
  );
}
