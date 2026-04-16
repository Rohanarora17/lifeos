/**
 * POST /api/guardian/guidance
 *
 * Receives on-demand guidance requests from:
 *   - MacBook Vision Client (global hotkey → triggers this with screenshot + clipboard)
 *   - Browser Extension (text selection + Cmd+Shift+G shortcut)
 *   - Guardian Voice pipeline (via processGuardianVoiceCommand when intent = 'guidance')
 *
 * Assembles full context and calls Gemini for a grounded, specific response.
 * Delivers via TTS (speak()) and SSE (guardian-bus).
 */

import { NextResponse } from 'next/server';
import { assembleGuidanceResponse } from '@/lib/screen-guidance';
import { speak } from '@/lib/tts';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';
import { emitGuardianRuntimeEvent } from '@/lib/guardian-bus';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;

    const {
      sessionId,
      base64Jpeg,
      appInFocus,
      windowTitle,
      selectedText,
      question,
      source,
    } = body as {
      sessionId?: string;
      base64Jpeg?: string;
      appInFocus?: string;
      windowTitle?: string;
      selectedText?: string;
      question?: string;
      source?: string;
    };

    const resolvedQuestion = question?.trim() || 'Explain what I am looking at in the context of my session goal.';
    const resolvedSource = (source as 'voice' | 'client_hotkey' | 'extension_hotkey' | 'extension_selection') || 'client_hotkey';

    // Resolve session: prefer explicit, fall back to active session
    const session = getActiveGuardianSession();
    const resolvedSessionId = sessionId || session?.sessionId || null;

    if (!resolvedSessionId) {
      return NextResponse.json(
        { error: 'No active guardian session. Start a session before requesting guidance.' },
        { status: 400 }
      );
    }

    // Assemble context + query Gemini
    const guidance = await assembleGuidanceResponse({
      sessionId: resolvedSessionId,
      base64Jpeg,
      appInFocus,
      windowTitle,
      selectedText,
      question: resolvedQuestion,
      source: resolvedSource,
    });

    // Deliver response via TTS (non-blocking — don't await in request handler)
    if (guidance.spokenAnswer) {
      void speak(resolvedSessionId, guidance.spokenAnswer, 'normal');
    }

    // Emit SSE event so dashboard can display the guidance panel
    emitGuardianRuntimeEvent(resolvedSessionId, {
      type: 'guidance_response',
      answer: guidance.answer,
      spokenAnswer: guidance.spokenAnswer,
      question: resolvedQuestion,
      source: resolvedSource,
      contextUsed: guidance.contextUsed,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      ok: true,
      answer: guidance.answer,
      spokenAnswer: guidance.spokenAnswer,
      contextUsed: guidance.contextUsed,
    });
  } catch (err) {
    console.error('[guidance/route] Error:', err);
    return NextResponse.json({ error: 'Internal error during guidance assembly' }, { status: 500 });
  }
}
