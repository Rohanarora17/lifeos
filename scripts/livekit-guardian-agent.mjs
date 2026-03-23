#!/usr/bin/env node

import process from 'node:process';
import { Modality } from '@google/genai';
import { AutoSubscribe, cli, defineAgent, llm, voice, WorkerOptions } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { VAD } from '@livekit/agents-plugin-silero';
import { z } from 'zod';

const DEFAULT_APP_URL = 'http://127.0.0.1:3000';
const DEFAULT_MODEL = process.env.LIVEKIT_GUARDIAN_MODEL || 'gemini-2.5-flash-preview-native-audio-dialog';
const DEFAULT_VOICE = process.env.LIVEKIT_GUARDIAN_VOICE || 'Aoede';
const DEFAULT_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'lifeos-guardian-agent';
const VOICE_MODE = process.env.VOICE_MODE || 'local';

function getGoogleApiKey() {
  return (
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY ||
    ''
  );
}

function getAppBaseUrl() {
  return (process.env.LIFEOS_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
}

function parseParticipantMetadata(metadata) {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function buildGuardianInstructions({ sessionId, targetTitle }) {
  return [
    'You are LifeOS Guardian, a strict but fair 1:1 study guardian.',
    'Your job is to help the user lock in, stay focused, and improve without becoming noisy or overbearing.',
    'Keep spoken replies short, direct, and calm.',
    'Do not invent session state, focus scores, override decisions, or day plans.',
    'Whenever the user asks for anything LifeOS-specific, including starting a session, checking status, override requests, day planning, tutoring, or personalized productivity context, call the guardian_action tool first.',
    'After the tool returns, ground your reply in that result. If the tool denies a request, explain the denial briefly and clearly.',
    'If the user is simply chatting or clarifying intent, you may respond briefly without a tool call.',
    'Do not lecture unless the user explicitly asks for tutoring or explanation.',
    `Current session id: ${sessionId || 'unknown'}.`,
    `Current target: ${targetTitle || 'not set'}.`,
  ].join(' ');
}

async function postGuardianCommand({ request, sessionId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${getAppBaseUrl()}/api/voice/push-to-talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: request,
        sessionId: sessionId || undefined,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : 'Guardian command failed';
      throw new Error(message);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

const agentDefinition = defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await VAD.load();
  },

  entry: async (ctx) => {
    if (VOICE_MODE !== 'google-live') {
      throw new Error('Guardian realtime worker requires VOICE_MODE=google-live');
    }

    const apiKey = getGoogleApiKey();
    if (!apiKey) {
      throw new Error('Missing GOOGLE_API_KEY / GOOGLE_GENAI_API_KEY / API_KEY / GEMINI_API_KEY for guardian voice agent');
    }

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    const participant = await ctx.waitForParticipant();
    const metadata = parseParticipantMetadata(participant.metadata);
    const sessionId =
      typeof metadata.sessionId === 'string' && metadata.sessionId.trim() ? metadata.sessionId.trim() : undefined;
    const targetTitle =
      typeof metadata.targetTitle === 'string' && metadata.targetTitle.trim()
        ? metadata.targetTitle.trim()
        : 'current study target';

    const realtimeModel = new google.beta.realtime.RealtimeModel({
      apiKey,
      model: DEFAULT_MODEL,
      voice: DEFAULT_VOICE,
      modalities: [Modality.AUDIO],
      instructions: buildGuardianInstructions({ sessionId, targetTitle }),
      temperature: 0.2,
    });

    const guardianActionTool = llm.tool({
      description:
        'Use for all LifeOS-specific actions or questions: starting or adjusting sessions, checking guardian status, override requests, day briefing, tutoring, or personalized productivity context.',
      parameters: z.object({
        request: z.string().describe('The exact user request or the shortest faithful paraphrase.'),
      }),
      execute: async ({ request }) => {
        const result = await postGuardianCommand({ request, sessionId });
        return {
          type: result.type || 'intent_only',
          responseText: result.responseText || '',
          sessionId: result.session?.sessionId || sessionId || null,
          approved: result.decision?.approved ?? null,
          explainability: result.decision?.explainability || null,
        };
      },
    });

    const agent = new voice.Agent({
      instructions: buildGuardianInstructions({ sessionId, targetTitle }),
      llm: realtimeModel,
      tools: {
        guardian_action: guardianActionTool,
      },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
    });

    ctx.addShutdownCallback(async () => {
      await session.close();
      await realtimeModel.close();
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        participantIdentity: participant.identity,
      },
    });

    session.say(`Guardian online. We are focused on ${targetTitle}. Tell me what you need to finish.`, {
      allowInterruptions: true,
    });

    await new Promise((resolve) => {
      session.once(voice.AgentSessionEventTypes.Close, () => resolve());
    });
  },
});

export default agentDefinition;

if (process.argv[1] === new URL(import.meta.url).pathname) {
  cli.runApp(
    new WorkerOptions({
      agent: import.meta.filename,
      agentName: DEFAULT_AGENT_NAME,
    })
  );
}
