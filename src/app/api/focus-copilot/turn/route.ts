import { NextResponse } from 'next/server';
import { assembleGuidanceResponse } from '@/lib/screen-guidance';
import { processGuardianVoiceCommand } from '@/lib/guardian-voice';
import { transcribeAudio } from '@/lib/stt';
import { getDb } from '@/lib/db';
import { getActiveGuardianSession, tickGuardianSession } from '@/lib/guardian-runtime';
import { touchIntelligence } from '@/lib/intelligence';
import { insertEpisode } from '@/lib/memory';
import type { FocusCopilotCallout, FocusCopilotSource, FocusCopilotTurnResponse } from '@/lib/focus-copilot-types';
import type { GuardianEvent } from '@/lib/guardian-types';

function isGuidanceQuestion(text: string, selectedText?: string, base64Jpeg?: string) {
  const lower = text.toLowerCase();
  return !!selectedText?.trim()
    || !!base64Jpeg
    || /(explain this|what does this mean|what am i looking at|help me with this|help me debug|point|show me where|this section|this paragraph)/.test(lower);
}

async function parseRequest(req: Request) {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const audio = form.get('audio');
    const base64Jpeg = (form.get('base64Jpeg') as string | null) ?? undefined;
    const selectedText = (form.get('selectedText') as string | null) ?? undefined;
    const question = (form.get('question') as string | null) ?? undefined;
    const transcript = (form.get('transcript') as string | null) ?? undefined;
    const sessionId = (form.get('sessionId') as string | null) ?? undefined;
    const appInFocus = (form.get('appInFocus') as string | null) ?? undefined;
    const windowTitle = (form.get('windowTitle') as string | null) ?? undefined;
    const source = (form.get('source') as string | null) ?? 'native_ptt';
    const screenSizeRaw = (form.get('screenSize') as string | null) ?? undefined;
    const cursorPointRaw = (form.get('cursorPoint') as string | null) ?? undefined;
    const screenSize = screenSizeRaw ? JSON.parse(screenSizeRaw) as { width: number; height: number } : undefined;
    const cursorPoint = cursorPointRaw ? JSON.parse(cursorPointRaw) as { x: number; y: number } : undefined;
    return { audio: audio instanceof Blob ? audio : undefined, base64Jpeg, selectedText, question, transcript, sessionId, appInFocus, windowTitle, source, screenSize, cursorPoint };
  }
  return await req.json() as {
    transcript?: string;
    audio?: Blob;
    base64Jpeg?: string;
    selectedText?: string;
    question?: string;
    sessionId?: string;
    appInFocus?: string;
    windowTitle?: string;
    source?: string;
    screenSize?: { width: number; height: number };
    cursorPoint?: { x: number; y: number };
  };
}

function insertOutcome(input: {
  actionType: string;
  inferredValue: string;
  actualOutcome?: Record<string, unknown>;
}) {
  const result = getDb().prepare(`
    INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, helpful)
    VALUES (?, ?, ?, NULL)
  `).run(
    input.actionType,
    input.inferredValue.slice(0, 500),
    input.actualOutcome ? JSON.stringify(input.actualOutcome) : null,
  );
  return Number(result.lastInsertRowid);
}

const GUIDANCE_SOURCES = new Set<FocusCopilotSource>([
  'voice',
  'extension_hotkey',
  'extension_selection',
  'native_hotkey',
  'native_ptt',
  'native_selection',
]);

function normalizeGuidanceSource(source?: string): 'voice' | 'extension_hotkey' | 'extension_selection' | 'native_hotkey' | 'native_ptt' | 'native_selection' {
  if (source && GUIDANCE_SOURCES.has(source as FocusCopilotSource)) {
    return source as 'voice' | 'extension_hotkey' | 'extension_selection' | 'native_hotkey' | 'native_ptt' | 'native_selection';
  }
  return 'native_hotkey';
}

export async function POST(req: Request) {
  try {
    const body = await parseRequest(req);
    const activeSession = getActiveGuardianSession();
    const sessionId = body.sessionId || activeSession?.sessionId || null;

    if (!sessionId || !activeSession || activeSession.sessionId !== sessionId) {
      return NextResponse.json({ ok: false, mode: 'error', callouts: [], contextUsed: { hadScreenshot: false, hadSelectedText: false, hadScreenHistory: false, hadContextNarrative: false }, error: 'No active guardian session for focus copilot turn' } satisfies FocusCopilotTurnResponse, { status: 409 });
    }

    let transcript = body.transcript?.trim() || '';
    if (!transcript && body.audio) {
      const t = await transcribeAudio(body.audio, 'native-copilot.webm');
      transcript = t?.trim() || '';
    }

    const question = (body.question || transcript || 'Explain what I am looking at in the context of my session goal.').trim();
    const wordCount = transcript.split(/\s+/).filter((word) => /\w/.test(word)).length;
    if (body.audio && wordCount > 0 && wordCount < 3) {
      return NextResponse.json({
        ok: true,
        transcript,
        mode: 'empty',
        callouts: [],
        contextUsed: { hadScreenshot: false, hadSelectedText: false, hadScreenHistory: false, hadContextNarrative: false },
      } satisfies FocusCopilotTurnResponse);
    }

    const source = normalizeGuidanceSource(body.source);
    const shouldGuide = isGuidanceQuestion(question, body.selectedText, body.base64Jpeg);

    const requestEvent: GuardianEvent = {
      sessionId,
      type: 'guidance_request',
      timestamp: Date.now(),
      transcript: transcript || question,
      payload: {
        source: body.source ?? 'native_copilot',
        appInFocus: body.appInFocus ?? null,
        windowTitle: body.windowTitle ?? null,
        hadScreenshot: !!body.base64Jpeg,
        hadSelectedText: !!body.selectedText?.trim(),
      },
    };
    await tickGuardianSession(sessionId, requestEvent);

    if (shouldGuide) {
      const guidance = await assembleGuidanceResponse({
        sessionId,
        base64Jpeg: body.base64Jpeg,
        appInFocus: body.appInFocus,
        windowTitle: body.windowTitle,
        selectedText: body.selectedText,
        question,
        source,
        screenSize: body.screenSize,
        cursorPoint: body.cursorPoint,
      });

      const callouts = ('callouts' in guidance ? guidance.callouts : []) as FocusCopilotCallout[];
      const outcomeId = insertOutcome({
        actionType: 'native_guidance_response',
        inferredValue: question,
        actualOutcome: {
          source: body.source ?? 'native_copilot',
          contextUsed: guidance.contextUsed,
          calloutCount: callouts.length,
          appInFocus: body.appInFocus ?? null,
        },
      });

      insertEpisode('native_copilot', `Native guidance: ${question.slice(0, 120)}`, {
        rawContext: {
          sessionId,
          question,
          answer: guidance.answer,
          selectedText: body.selectedText?.slice(0, 1000) ?? null,
          appInFocus: body.appInFocus ?? null,
          windowTitle: body.windowTitle ?? null,
          contextUsed: guidance.contextUsed,
          outcomeId,
        },
        importance: body.selectedText || body.base64Jpeg ? 0.65 : 0.45,
      });

      const responseEvent: GuardianEvent = {
        sessionId,
        type: 'guidance_response',
        timestamp: Date.now(),
        payload: {
          source: body.source ?? 'native_copilot',
          answer: guidance.answer,
          spokenAnswer: guidance.spokenAnswer,
          callouts,
          outcomeId,
          contextUsed: guidance.contextUsed,
        },
      };
      await tickGuardianSession(sessionId, responseEvent);
      touchIntelligence('native_guidance_turn');

      return NextResponse.json({
        ok: true,
        transcript,
        mode: 'guidance',
        answer: guidance.answer,
        spokenAnswer: guidance.spokenAnswer,
        callouts,
        contextUsed: guidance.contextUsed,
        outcomeId,
      } satisfies FocusCopilotTurnResponse);
    }

    const result = await processGuardianVoiceCommand({ transcript: transcript || question, sessionId });
    const outcomeId = insertOutcome({
      actionType: 'native_voice_action',
      inferredValue: question,
      actualOutcome: { action: result.intent.action, type: result.type, source: body.source ?? 'native_copilot' },
    });
    touchIntelligence('native_voice_turn');

    return NextResponse.json({
      ok: true,
      transcript: transcript || question,
      mode: 'voice_action',
      answer: result.responseText,
      spokenAnswer: result.responseText,
      callouts: [],
      contextUsed: { hadScreenshot: false, hadSelectedText: false, hadScreenHistory: false, hadContextNarrative: false },
      outcomeId,
    } satisfies FocusCopilotTurnResponse);
  } catch (err) {
    console.error('[focus-copilot/turn] Error:', err);
    return NextResponse.json({
      ok: false,
      mode: 'error',
      callouts: [],
      contextUsed: { hadScreenshot: false, hadSelectedText: false, hadScreenHistory: false, hadContextNarrative: false },
      error: String(err),
    } satisfies FocusCopilotTurnResponse, { status: 500 });
  }
}
