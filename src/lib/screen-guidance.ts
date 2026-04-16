/**
 * Screen Guidance Engine
 *
 * Assembles full context (session, screen history, UIL intelligence, screenshot,
 * selected text) and queries Gemini for an on-demand, contextually grounded response.
 *
 * Triggered by:
 *   - Voice PTT: "explain this" / "help me" / "what is X"
 *   - MacBook client hotkey (Option+D / Cmd+Shift+G) → POST /api/guardian/guidance
 *   - Extension text selection + shortcut
 */

import { getGenAI, generateWithFallback } from './ai';
import { canUseCloudTextReasoning } from './cloud-privacy';
import { MODEL_PRO, MODEL_FLASH } from './models';
import { getIntelligenceContext } from './intelligence';
import { getGuardianSession, getActiveGuardianSession } from './guardian-runtime';
import { getDb } from './db';
import type { ScreenVisionSignal, ScreenContext } from './guardian-types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GuidanceInput {
  sessionId?: string | null;
  base64Jpeg?: string;        // current screenshot (high-res from MacBook client or extension)
  appInFocus?: string;
  windowTitle?: string;
  selectedText?: string;      // highlighted text via extension content script or clipboard
  question: string;           // "explain this" / "help me debug this" / "what is X"
  source: 'voice' | 'client_hotkey' | 'extension_hotkey' | 'extension_selection';
}

export interface GuidanceResponse {
  answer: string;             // full response (for dashboard display)
  spokenAnswer: string;       // condensed for TTS (≤100 words)
  contextUsed: {
    hadScreenshot: boolean;
    hadSelectedText: boolean;
    hadScreenHistory: boolean;
    hadContextNarrative: boolean;
  };
}

// ─── Recent observations from DB (fallback when screenContext is thin) ────────

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
        AND source = 'screen_vision'
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

// ─── Main guidance assembler ──────────────────────────────────────────────────

export async function assembleGuidanceResponse(input: GuidanceInput): Promise<GuidanceResponse> {
  const ai = getGenAI();
  if (!ai || !canUseCloudTextReasoning()) {
    return {
      answer: 'Guidance is ready, but cloud reasoning is unavailable right now.',
      spokenAnswer: 'Cloud reasoning is unavailable right now.',
      contextUsed: { hadScreenshot: false, hadSelectedText: false, hadScreenHistory: false, hadContextNarrative: false },
    };
  }

  // ── Resolve session ────────────────────────────────────────────────────────
  const sessionId = input.sessionId ?? getActiveGuardianSession()?.sessionId ?? null;
  const session = sessionId ? getGuardianSession(sessionId) : getActiveGuardianSession();

  const sessionTarget = session?.targetTitle ?? null;
  const sessionTopic = session?.topic ?? null;
  const focusScore = session?.focusScore ?? null;
  const elapsedMin = session
    ? Math.round((Date.now() - session.startedAt) / 1000 / 60)
    : null;
  const screenContext = session?.screenContext ?? null;

  // ── Collect context pieces ─────────────────────────────────────────────────
  const dbObs = sessionId ? getRecentScreenObservations(sessionId) : [];
  const screenHistory = formatScreenHistory(screenContext, dbObs);
  const uilContext = getIntelligenceContext({ maxInsights: 3, includeToday: true });

  const hadScreenshot = !!input.base64Jpeg;
  const hadSelectedText = !!input.selectedText?.trim();
  const hadScreenHistory = screenHistory.length > 0;
  const hadContextNarrative = !!screenContext?.contextNarrative;

  // ── Build system instruction ───────────────────────────────────────────────
  const sessionBlock = session
    ? [
        `Active session: "${sessionTarget || 'unknown'}"`,
        sessionTopic ? `Topic: ${sessionTopic}` : '',
        elapsedMin !== null ? `Elapsed: ${elapsedMin} min` : '',
        focusScore !== null ? `Current focus score: ${focusScore}/100` : '',
      ].filter(Boolean).join('\n')
    : 'No active session.';

  const systemInstruction = [
    'You are the LifeOS Guardian — a precise, context-aware focus coach.',
    'The user has triggered an on-demand guidance request.',
    'Answer their question using ALL available context: what they are looking at, what they have been doing,',
    'their session goal, and their longitudinal intelligence profile.',
    'Be specific. Reference what is actually on their screen. Keep the spoken answer under 80 words.',
    'Separate your response into two parts using this exact format:',
    '---ANSWER---',
    '[Full answer here — can be longer, include code snippets or explanations]',
    '---SPOKEN---',
    '[Spoken version here — under 80 words, no markdown, no code blocks, natural speech]',
    '',
    '=== SESSION ===',
    sessionBlock,
    '',
    screenHistory ? `=== SCREEN CONTEXT ===\n${screenHistory}` : '',
    '',
    `=== CURRENT APP ===`,
    input.appInFocus ? `App: ${input.appInFocus}` : '',
    input.windowTitle ? `Window: ${input.windowTitle}` : '',
    '',
    uilContext ? `=== INTELLIGENCE PROFILE ===\n${uilContext}` : '',
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
  const modelToUse = hadScreenshot ? MODEL_FLASH : MODEL_PRO; // Flash for vision (multimodal), Pro for text
  const result = await generateWithFallback(ai, {
    model: modelToUse,
    contents,
    config: {
      systemInstruction,
      temperature: 0.2,
    },
  });

  const rawText = (result.text || '').trim();

  // ── Parse answer vs spoken sections ───────────────────────────────────────
  let answer = rawText;
  let spokenAnswer = rawText;

  const answerMatch = rawText.match(/---ANSWER---\n([\s\S]*?)(?:---SPOKEN---|$)/);
  const spokenMatch = rawText.match(/---SPOKEN---\n([\s\S]*?)$/);

  if (answerMatch) {
    answer = answerMatch[1].trim();
  }
  if (spokenMatch) {
    spokenAnswer = spokenMatch[1].trim();
  }

  // Fallback: if model didn't use delimiters, use full text for both but cap spoken
  if (!answerMatch && !spokenMatch && rawText.length > 0) {
    answer = rawText;
    // Truncate for speech: keep first ~80 words
    const words = rawText.split(/\s+/);
    spokenAnswer = words.length > 80
      ? words.slice(0, 80).join(' ') + '…'
      : rawText;
  }

  return {
    answer: answer || 'I could not generate a response.',
    spokenAnswer: spokenAnswer || answer || 'I could not generate a response.',
    contextUsed: { hadScreenshot, hadSelectedText, hadScreenHistory, hadContextNarrative },
  };
}
