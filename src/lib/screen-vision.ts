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
import { MODEL_FLASH } from './models';
import { getDb } from './db';

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

export function isSensitiveApp(appName: string, windowTitle: string): boolean {
  const appLower = appName.toLowerCase();
  if (SENSITIVE_FULL_APP_SKIP.some((a) => appLower.includes(a))) return true;
  if (appLower.includes('terminal') || appLower.includes('iterm')) {
    return SENSITIVE_TITLE_PATTERNS.some((p) => p.test(windowTitle));
  }
  return false;
}

// ---------------------------------------------------------------------------
// pHash-based change detection (simple luminance block hash)
// ---------------------------------------------------------------------------

// Compute a 64-bit perceptual hash as a hex string from base64 JPEG.
// Uses luminance of 8×8 DCT-lite blocks (average hash variant — good enough for change detection).
export function computeImageHash(base64Jpeg: string): string {
  // Decode base64 to bytes
  const bytes = Buffer.from(base64Jpeg, 'base64');
  // Sample 64 evenly-spaced bytes as a proxy for luminance distribution
  // (real pHash would require image decoding; this lightweight approach catches meaningful changes)
  const step = Math.max(1, Math.floor(bytes.length / 64));
  const samples: number[] = [];
  for (let i = 0; i < 64; i++) {
    samples.push(bytes[i * step] ?? 0);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / 64;
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
  if (a.length !== b.length) return 64;
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

// Returns change magnitude based on hamming distance out of 64 bits
export function getChangeMagnitude(
  currentHash: string,
  prevHash: string | null,
): ScreenVisionSignal['changeFromPrevious'] {
  if (!prevHash) return 'major';
  const dist = hammingDistance(currentHash, prevHash);
  if (dist <= 3) return 'none';
  if (dist <= 10) return 'minor';
  if (dist <= 25) return 'moderate';
  return 'major';
}

// ---------------------------------------------------------------------------
// Adaptive capture rate state machine
// ---------------------------------------------------------------------------

export type CaptureState = ScreenContext['captureState'];

export function computeCaptureState(
  session: GuardianState,
  currentCaptureState: CaptureState,
): { state: CaptureState; intervalMs: number } {
  const score = session.focusScoreHistory.at(-1) ?? 50;
  const screenCtx = session.screenContext;
  const recentDepths = screenCtx?.recentObservations.slice(-3).map((o) => o.engagementDepth) ?? [];

  // Downshift from guidance_burst after 30s (handled by caller via timestamp)
  if (currentCaptureState === 'guidance_burst') {
    return { state: 'guidance_burst', intervalMs: 5_000 };
  }

  const allActiveCreation = recentDepths.length >= 3 && recentDepths.every((d) => d === 'active_creation');
  if (score > 85 && allActiveCreation) {
    return { state: 'deep_focus', intervalMs: 25_000 };
  }

  const trend = screenCtx?.visionTrend ?? 'unknown';
  if (score < 50 || trend === 'declining') {
    return { state: 'heightened', intervalMs: 9_000 };
  }

  return { state: 'normal', intervalMs: 13_000 };
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

export async function analyzeScreenshot(input: AnalyzeScreenshotInput): Promise<ScreenVisionSignal> {
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
    model: MODEL_FLASH,
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
  let parsed: Partial<ScreenVisionSignal>;
  try {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback if Gemini returns malformed JSON
    parsed = {
      taskAlignment: 50,
      engagementDepth: 'passive_consumption',
      contentSummary: 'Unable to analyze screenshot.',
      specificContent: input.windowTitle,
      distractionIndicators: [],
      progressIndicator: '',
      confidence: 0.1,
    };
  }

  return {
    taskAlignment: Math.min(100, Math.max(0, Number(parsed.taskAlignment ?? 50))),
    engagementDepth: parsed.engagementDepth ?? 'passive_consumption',
    appInFocus: input.appInFocus,
    windowTitle: input.windowTitle,
    contentSummary: parsed.contentSummary ?? '',
    specificContent: parsed.specificContent ?? input.windowTitle,
    distractionIndicators: Array.isArray(parsed.distractionIndicators) ? parsed.distractionIndicators : [],
    progressIndicator: parsed.progressIndicator ?? '',
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
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
    model: MODEL_FLASH,
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
