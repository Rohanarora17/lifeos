/**
 * Screen Guidance Engine
 *
 * Assembles full context (session, screen history, UIL intelligence, screenshot,
 * selected text) and queries Gemini for an on-demand, contextually grounded response.
 *
 * Triggered by:
 *   - Voice PTT: "explain this" / "help me" / "what is X"
 *   - Native Mac surface hotkey/PTT/selection capture
 *   - Extension DOM selection, tab, and page-context signals
 *
 * Native and extension surfaces are complementary sensors. Both feed the same
 * Guardian, UIL, memory, and guidance layers instead of separate product lanes.
 */

import { getGenAI, generateWithFallback } from './ai';
import { canUseCloudTextReasoning } from './cloud-privacy';
import { MODEL_PRO, MODEL_VISION } from './models';
import { getGuardianSession, getActiveGuardianSession } from './guardian-runtime';
import { getDb } from './db';
import type { ScreenVisionSignal, ScreenContext } from './guardian-types';
import type { FocusCopilotCallout } from './focus-copilot-types';
import { buildPersonalizationSnapshot, formatPersonalizationContext, type PersonalizationSnapshot } from './personalization-context';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuidanceInput {
  sessionId?: string | null;
  base64Jpeg?: string;        // current screenshot from a native or extension surface
  appInFocus?: string;
  windowTitle?: string;
  selectedText?: string;      // highlighted text via extension DOM or native clipboard bridge
  question: string;           // "explain this" / "help me debug this" / "what is X"
  source: 'voice' | 'client_hotkey' | 'extension_hotkey' | 'extension_selection' | 'native_hotkey' | 'native_ptt' | 'native_selection';
  screenSize?: {
    width: number;
    height: number;
  };
  cursorPoint?: {
    x: number;
    y: number;
  };
}

export interface GuidanceResponse {
  answer: string;             // full response (for dashboard display)
  spokenAnswer: string;       // condensed for TTS (≤100 words)
  callouts: FocusCopilotCallout[];
  contextUsed: {
    hadScreenshot: boolean;
    hadSelectedText: boolean;
    hadScreenHistory: boolean;
    hadContextNarrative: boolean;
    hadCursorPoint?: boolean;
    usedUilContext?: boolean;
  };
}

function validateCallouts(raw: unknown, screenSize?: GuidanceInput['screenSize']): FocusCopilotCallout[] {
  if (!Array.isArray(raw)) return [];
  const maxWidth = Math.max(1, screenSize?.width ?? 10000);
  const maxHeight = Math.max(1, screenSize?.height ?? 10000);

  return raw.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const c = item as Record<string, unknown>;
    const x = typeof c.x === 'number' ? c.x : Number(c.x);
    const y = typeof c.y === 'number' ? c.y : Number(c.y);
    const width = c.width === undefined ? undefined : (typeof c.width === 'number' ? c.width : Number(c.width));
    const height = c.height === undefined ? undefined : (typeof c.height === 'number' ? c.height : Number(c.height));
    const confidence = typeof c.confidence === 'number' ? c.confidence : Number(c.confidence ?? 0);
    const label = typeof c.label === 'string' ? c.label.trim() : '';

    if (!Number.isFinite(x) || !Number.isFinite(y) || !label || confidence < 0.35) return [];
    if (x < 0 || y < 0 || x > maxWidth || y > maxHeight) return [];
    if (width !== undefined && (!Number.isFinite(width) || width < 0 || width > maxWidth)) return [];
    if (height !== undefined && (!Number.isFinite(height) || height < 0 || height > maxHeight)) return [];

    return [{
      x,
      y,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      label,
      confidence: Math.max(0, Math.min(1, confidence)),
    }];
  });
}

// ─── Recent observations from DB (shared history when screenContext is thin) ──

function getRecentScreenObservations(sessionId: string, limit = 8): Array<{
  observed_at: string;
  app: string;
  activity: string;
  specific_content: string;
  task_alignment: number | null;
  engagement_depth: string | null;
}> {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT observed_at, app, activity, specific_content,
             task_alignment, engagement_depth
      FROM screen_observations
      WHERE session_id = ?
        AND source IN ('screen_vision', 'native_copilot', 'extension_screenshot', 'extension_daemon')
      ORDER BY observed_at DESC
      LIMIT ?
    `).all(sessionId, limit) as ReturnType<typeof getRecentScreenObservations>;
  } catch {
    return [];
  }
}

// ─── Format screen history for the prompt ─────────────────────────────────────

function formatScreenHistory(
  screenContext: ScreenContext | null,
  dbObservations: ReturnType<typeof getRecentScreenObservations>,
): string {
  // Prefer in-memory ring buffer (fresher) over DB
  const observations: ScreenVisionSignal[] = screenContext?.recentObservations ?? [];

  if (observations.length > 0) {
    const lines = observations
      .slice(-8)
      .reverse()
      .map((o, i) => {
        const ago = Math.round((Date.now() - o.capturedAt) / 1000 / 60);
        const agoStr = ago === 0 ? 'just now' : `${ago}m ago`;
        return `  ${i + 1}. [${agoStr}] ${o.appInFocus} — ${o.contentSummary} (alignment: ${o.taskAlignment}/100, ${o.engagementDepth})`;
      })
      .join('\n');

    const narrative = screenContext?.contextNarrative
      ? `\nRecent activity summary: ${screenContext.contextNarrative}`
      : '';

    return `Screen history (last ${observations.length} captures):\n${lines}${narrative}`;
  }

  if (dbObservations.length > 0) {
    const lines = dbObservations
      .map((o, i) => `  ${i + 1}. ${o.app || 'unknown'} — ${o.activity || ''} ${o.specific_content ? `(${o.specific_content})` : ''}`)
      .join('\n');
    return `Screen history (from DB):\n${lines}`;
  }

  return '';
}

function buildGuidanceFallback(input: GuidanceInput): GuidanceResponse {
  const session = input.sessionId ? getGuardianSession(input.sessionId) : getActiveGuardianSession();
  const focusScore = session?.focusScoreHistory?.at(-1) ?? null;
  const elapsedMin = session ? Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)) : 0;
  const personalization = buildPersonalizationSnapshot({
    surface: 'guidance',
    maxInsights: 2,
    includeMemoryFacts: 4,
    activeSession: session ? {
      sessionId: session.sessionId,
      targetTitle: session.targetTitle,
      focusScore,
      elapsedMinutes: elapsedMin,
    } : null,
  });

  const visibleContext = input.selectedText?.trim()
    ? `I can still use the selected text: "${input.selectedText.trim().slice(0, 120)}".`
    : input.windowTitle
      ? `I can still use the current window: ${input.windowTitle}.`
      : '';

  let answer: string;
  if (session) {
    answer = `Cloud reasoning is unavailable, so I will stay local: keep ${session.targetTitle} moving with the smallest next step. ${visibleContext}`;
  } else if (personalization.today.plannedFocus.nextTitle) {
    answer = `Cloud reasoning is unavailable. Your next planned focus is ${personalization.today.plannedFocus.nextTitle}; use this request to prepare that block. ${visibleContext}`;
  } else if (personalization.moment.mode === 'recovery' || personalization.userState.energy === 'low' || personalization.userState.mood === 'low') {
    answer = `Cloud reasoning is unavailable. Treat this as a low-capacity moment: ask for one small clarification or start a short recovery-safe block. ${visibleContext}`;
  } else if (personalization.moment.mode === 'deadline_pressure') {
    answer = `Cloud reasoning is unavailable. Use the question only if it reduces the nearest deadline risk; otherwise return to the deadline block. ${visibleContext}`;
  } else if (personalization.moment.mode === 'planning') {
    answer = `Cloud reasoning is unavailable. Capture the question as a planning note for tomorrow's first block. ${visibleContext}`;
  } else {
    answer = `Cloud reasoning is unavailable. Use the current context to choose the next concrete step. ${visibleContext}`;
  }

  const normalized = answer.replace(/\s+/g, ' ').trim();
  return {
    answer: normalized,
    spokenAnswer: normalized,
    callouts: [],
    contextUsed: {
      hadScreenshot: !!input.base64Jpeg,
      hadSelectedText: !!input.selectedText?.trim(),
      hadScreenHistory: false,
      hadContextNarrative: false,
      hadCursorPoint: !!input.cursorPoint,
      usedUilContext: true,
    },
  };
}

function noActiveSessionGuidanceBlock(personalization: PersonalizationSnapshot): string {
  const planned = personalization.today.plannedFocus.nextTitle
    ? `\nNext planned focus: ${personalization.today.plannedFocus.nextTitle}${personalization.today.plannedFocus.nextMinutes ? ` (${personalization.today.plannedFocus.nextMinutes}m)` : ''}`
    : '';
  const standup = personalization.userState.standupGoal
    ? `\nToday's stated goal: ${personalization.userState.standupGoal}`
    : '';

  return [
    'No active Guardian session.',
    `Moment mode: ${personalization.moment.mode}`,
    `Energy: ${personalization.userState.energy}`,
    `Mood: ${personalization.userState.mood ?? 'unknown'}`,
    `Learned focus window: ${personalization.userState.nextBestFocusWindow || 'unknown'}`,
    `Alert fatigue: ${personalization.feedback.alertFatigueLevel}${planned}${standup}`,
    `Guidance: ${personalization.moment.guidance}`,
  ].join('\n');
}

// ─── Main guidance assembler ──────────────────────────────────────────────────

export async function assembleGuidanceResponse(input: GuidanceInput): Promise<GuidanceResponse> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return buildGuidanceFallback(input);
  }

  // ── Resolve session ────────────────────────────────────────────────────────
  const sessionId = input.sessionId ?? getActiveGuardianSession()?.sessionId ?? null;
  const session = sessionId ? getGuardianSession(sessionId) : getActiveGuardianSession();

  const sessionTarget = session?.targetTitle ?? null;
  const focusHistory = session?.focusScoreHistory ?? [];
  const focusScore = focusHistory.length > 0 ? focusHistory[focusHistory.length - 1] : null;
  const elapsedMin = session
    ? Math.round((Date.now() - session.startedAt) / 1000 / 60)
    : null;
  const screenContext = session?.screenContext ?? null;

  // ── Collect context pieces ─────────────────────────────────────────────────
  const dbObs = sessionId ? getRecentScreenObservations(sessionId) : [];
  const screenHistory = formatScreenHistory(screenContext, dbObs);
  const personalization = buildPersonalizationSnapshot({
    surface: 'guidance',
    maxInsights: 3,
    includeThresholds: false,
    includeMemoryFacts: 6,
    activeSession: session ? {
      sessionId: session.sessionId,
      targetTitle: session.targetTitle,
      focusScore,
      elapsedMinutes: elapsedMin ?? 0,
    } : null,
  });
  const personalizationContext = formatPersonalizationContext(personalization);

  const hadScreenshot = !!input.base64Jpeg;
  const hadSelectedText = !!input.selectedText?.trim();
  const hadScreenHistory = screenHistory.length > 0;
  const hadContextNarrative = !!screenContext?.contextNarrative;
  const hadCursorPoint = !!input.cursorPoint;

  // ── Build system instruction ───────────────────────────────────────────────
  const sessionBlock = session
    ? [
        `Active session: "${sessionTarget || 'unknown'}"`,
        elapsedMin !== null ? `Elapsed: ${elapsedMin} min` : '',
        focusScore !== null ? `Current focus score: ${Math.round(focusScore)}/100` : '',
      ].filter(Boolean).join('\n')
    : noActiveSessionGuidanceBlock(personalization);

  const systemInstruction = [
    'You are the LifeOS Guardian — a precise, context-aware focus coach.',
    'The user has triggered an on-demand guidance request.',
    'Answer their question using ALL available context: what they are looking at, what they have been doing,',
    'their session goal, and their longitudinal intelligence profile.',
    'Be specific. Reference what is actually on their screen. Keep the spoken answer under 80 words.',
    'Return ONLY valid JSON with this shape:',
    '{"answer":"full answer","spokenAnswer":"short natural speech under 80 words","callouts":[{"x":100,"y":200,"width":120,"height":40,"label":"short label","confidence":0.7}]}',
    'Callouts are optional. Only include callouts when you can point to a visible place in the screenshot. Coordinates must be in screenshot pixels.',
    '',
    '=== SESSION ===',
    sessionBlock,
    '',
    screenHistory ? `=== SCREEN CONTEXT ===\n${screenHistory}` : '',
    '',
    `=== CURRENT APP ===`,
    input.appInFocus ? `App: ${input.appInFocus}` : '',
    input.windowTitle ? `Window: ${input.windowTitle}` : '',
    input.screenSize ? `Screen size: ${input.screenSize.width}x${input.screenSize.height}` : '',
    input.cursorPoint ? `Cursor point: ${input.cursorPoint.x},${input.cursorPoint.y}` : '',
    '',
    personalizationContext ? `=== PERSONALIZATION CONTEXT ===\n${personalizationContext}` : '',
  ].filter(Boolean).join('\n');

  // ── Build contents array (multimodal if screenshot provided) ───────────────
  const textParts: Array<{ text: string }> = [];

  if (hadSelectedText) {
    textParts.push({ text: `Selected text: "${input.selectedText!.trim()}"` });
  }
  textParts.push({ text: `Question: ${input.question}` });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  if (hadScreenshot) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: input.base64Jpeg! } });
  }
  parts.push(...textParts);

  const contents = [{ role: 'user', parts }];

  // ── Call Gemini ────────────────────────────────────────────────────────────
  const modelToUse = hadScreenshot ? MODEL_VISION : MODEL_PRO;
  const result = await generateWithFallback(ai, {
    model: modelToUse,
    contents,
    config: {
      systemInstruction,
      temperature: 0.2,
    },
  }, { feature: 'screen_guidance' });

  const rawText = (result.text || '').trim();

  let answer = rawText;
  let spokenAnswer = rawText;
  let callouts: FocusCopilotCallout[] = [];

  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { answer?: unknown; spokenAnswer?: unknown; callouts?: unknown };
    answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : rawText;
    spokenAnswer = typeof parsed.spokenAnswer === 'string' ? parsed.spokenAnswer.trim() : answer;
    callouts = validateCallouts(parsed.callouts, input.screenSize);
  } catch {
    // Backward-compatible fallback for older delimiter-style model responses.
    const answerMatch = rawText.match(/---ANSWER---\n([\s\S]*?)(?:---SPOKEN---|$)/);
    const spokenMatch = rawText.match(/---SPOKEN---\n([\s\S]*?)$/);
    if (answerMatch) answer = answerMatch[1].trim();
    if (spokenMatch) spokenAnswer = spokenMatch[1].trim();
  }

  const words = spokenAnswer.split(/\s+/);
  if (words.length > 80) spokenAnswer = `${words.slice(0, 80).join(' ')}...`;

  return {
    answer: answer || 'I could not generate a response.',
    spokenAnswer: spokenAnswer || answer || 'I could not generate a response.',
    callouts,
    contextUsed: { hadScreenshot, hadSelectedText, hadScreenHistory, hadContextNarrative, hadCursorPoint, usedUilContext: !!personalizationContext },
  };
}
