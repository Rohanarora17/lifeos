#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { Modality } from '@google/genai';
import { AutoSubscribe, cli, defineAgent, llm, voice, WorkerOptions } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { VAD } from '@livekit/agents-plugin-silero';
import { z } from 'zod';

const DEFAULT_APP_URL = 'http://127.0.0.1:3000';
const DEFAULT_MODEL = process.env.LIVEKIT_GUARDIAN_MODEL || 'gemini-2.5-flash-native-audio-latest';
const DEFAULT_VOICE = process.env.LIVEKIT_GUARDIAN_VOICE || 'Aoede';
const DEFAULT_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'lifeos-guardian-agent';
const VOICE_MODE = process.env.VOICE_MODE || 'local';

function getVertexConfigOrThrow() {
  const useVertex =
    process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ||
    process.env.GOOGLE_GENAI_USE_VERTEXAI === '1';
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

  if (!useVertex) {
    throw new Error(
      'Vertex AI is required for guardian voice. Set GOOGLE_GENAI_USE_VERTEXAI=true.'
    );
  }
  if (!project) {
    throw new Error(
      'Vertex AI is required for guardian voice. Set GOOGLE_CLOUD_PROJECT (or legacy GCP_PROJECT_ID).'
    );
  }
  if (!credentialsPath) {
    throw new Error(
      'Vertex AI is required for guardian voice. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.'
    );
  }
  if (!path.isAbsolute(credentialsPath)) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS must be an absolute path. Got "${credentialsPath}".`
    );
  }
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS file not found at "${credentialsPath}".`);
  }

  return { project, location };
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

async function apiGet(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${getAppBaseUrl()}${path}`, { signal: controller.signal });
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
}

async function apiPost(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${getAppBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : 'API call failed';
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSessionContext(sessionId) {
  if (!sessionId) return null;
  try {
    const state = await apiGet(`/api/guardian/state?sessionId=${sessionId}`);
    return state;
  } catch {
    return null;
  }
}

function buildGuardianInstructions({ sessionId, targetTitle, sessionContext }) {
  const intent = sessionContext?.intentProfile;
  const policy = sessionContext?.sessionPolicy;
  const focusScore = sessionContext?.focusScore;
  const workMode = intent?.workMode || 'deep_work';
  const energy = intent?.energyAtStart || 'medium';
  const coachingStyle = intent?.coachingStyle || 'balanced';
  const deadlineUrgency = intent?.deadlineUrgency || 'none';

  const modeGuidance = {
    deep_work: 'The user is doing deep creative work. Protect their flow. Intervene only when they break focus. Keep remarks brief.',
    research: 'The user is researching. Tab switching is normal — do NOT treat it as distraction. Only flag if they revisit known distraction sites.',
    urgent_sprint: 'This is an urgent sprint. Be aggressive about protecting their time. Block distractions fast. Remind them of the deadline.',
    learning: 'The user is studying. Pauses are natural. Be encouraging, not demanding. Help them stay on the learning path.',
    recovery: 'The user has low energy. Be gentle and supportive. Do not push hard. Help them accomplish something small.',
  };

  const energyGuidance = {
    high: 'User has high energy — they can handle direct, structured coaching.',
    medium: 'User has moderate energy — balanced approach.',
    low: 'User has LOW energy — be supportive, not demanding. Suggest smaller tasks.',
  };

  const lines = [
    'You are LifeOS Guardian, a strict but fair 1:1 focus companion.',
    'Your job is to help the user lock in, stay focused, and improve without becoming noisy or overbearing.',
    'Keep spoken replies short, direct, and calm. Maximum 1-2 sentences.',
    'Do not invent session state, focus scores, or override decisions.',
    '',
    `CURRENT SESSION: ${sessionId || 'none'}`,
    `TARGET: ${targetTitle || 'not set'}`,
    `WORK MODE: ${workMode} — ${modeGuidance[workMode] || modeGuidance.deep_work}`,
    `ENERGY: ${energy} — ${energyGuidance[energy] || energyGuidance.medium}`,
    `COACHING STYLE: ${coachingStyle}`,
  ];

  if (deadlineUrgency === 'today' || deadlineUrgency === 'overdue') {
    lines.push('DEADLINE: URGENT — this session has a deadline today or it is overdue. Protect every minute.');
  } else if (deadlineUrgency === 'this_week') {
    lines.push('DEADLINE: This week — keep momentum, suggest shorter sprints.');
  }

  if (focusScore != null) {
    lines.push(`CURRENT FOCUS SCORE: ${focusScore}/100`);
  }

  if (policy) {
    lines.push(`SESSION POLICY: tab switch tolerance=${policy.thresholds?.highScatterSpeakThreshold}, idle concern=${policy.thresholds?.idleConcernSeconds}s, block after ${policy.thresholds?.distractionRevisitBlockCount} distraction revisits`);
  }

  lines.push('');
  lines.push('Use your tools to take action. Do not just describe what should happen — execute it.');
  lines.push('If the user asks for something outside your tools, call guardian_action with their exact request.');

  return lines.join('\n');
}

const agentDefinition = defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await VAD.load();
  },

  entry: async (ctx) => {
    if (VOICE_MODE !== 'google-live') {
      throw new Error('Guardian realtime worker requires VOICE_MODE=google-live');
    }

    const { project, location } = getVertexConfigOrThrow();

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    const participant = await ctx.waitForParticipant();
    const metadata = parseParticipantMetadata(participant.metadata);
    const sessionId =
      typeof metadata.sessionId === 'string' && metadata.sessionId.trim() ? metadata.sessionId.trim() : undefined;
    const targetTitle =
      typeof metadata.targetTitle === 'string' && metadata.targetTitle.trim()
        ? metadata.targetTitle.trim()
        : 'current study target';

    const sessionContext = await fetchSessionContext(sessionId);

    const realtimeModel = new google.beta.realtime.RealtimeModel({
      vertexai: true,
      project,
      location,
      model: DEFAULT_MODEL,
      voice: DEFAULT_VOICE,
      modalities: [Modality.AUDIO],
      instructions: buildGuardianInstructions({ sessionId, targetTitle, sessionContext }),
      temperature: 0.2,
    });

    // ─── Discrete Tools ─────────────────────────────────────────────────────

    const getGuardianStateTool = llm.tool({
      description: 'Get the current guardian session state including focus score, work mode, energy, active overrides, and elapsed time. Use before making decisions about interventions or overrides.',
      parameters: z.object({
        sessionId: z.string().optional().describe('Session ID. If omitted, uses the current session.'),
      }),
      execute: async ({ sessionId: sid }) => {
        const id = sid || sessionId;
        if (!id) return { error: 'No active session' };
        const state = await apiGet(`/api/guardian/state?sessionId=${id}`);
        return {
          focusScore: state.focusScore,
          workMode: state.intentProfile?.workMode,
          energy: state.intentProfile?.energyAtStart,
          elapsed: state.elapsed,
          blockedCount: state.blockedCount,
          overrideCount: state.overrideCount,
          activeOverrides: state.activeOverrides?.map(o => o.urlPattern),
        };
      },
    });

    const startSessionTool = llm.tool({
      description: 'Start a new guardian focus session. Use when the user wants to lock in or begin focusing on a task.',
      parameters: z.object({
        topic: z.string().describe('What the user will focus on'),
        durationMinutes: z.number().min(15).max(180).optional().describe('Session duration in minutes. Default 60.'),
        mood: z.enum(['high', 'medium', 'low']).optional().describe('User energy level. Default: auto-detect.'),
      }),
      execute: async ({ topic, durationMinutes, mood }) => {
        const result = await apiPost('/api/guardian/session/start', {
          topic,
          durationMinutes: durationMinutes || 60,
          mood: mood || undefined,
          source: 'voice',
        });
        return {
          sessionId: result.sessionId,
          workMode: result.intentProfile?.workMode,
          policyVersion: result.sessionPolicy?.version,
          duration: result.durationMinutes,
          message: result.intentProfile
            ? `Session started. Mode: ${result.intentProfile.workMode}, energy: ${result.intentProfile.energyAtStart}, duration: ${result.durationMinutes}min.`
            : `Session started for "${topic}", ${result.durationMinutes} minutes.`,
        };
      },
    });

    const endSessionTool = llm.tool({
      description: 'End the current guardian session. Use when the user wants to stop or wrap up.',
      parameters: z.object({}),
      execute: async () => {
        if (!sessionId) return { error: 'No active session to end' };
        const result = await apiPost('/api/guardian/session/end', { sessionId });
        return {
          message: 'Session ended.',
          averageFocusScore: result.summary?.averageFocusScore,
          elapsedMinutes: result.summary?.elapsedMinutes,
        };
      },
    });

    const requestOverrideTool = llm.tool({
      description: 'Request an override to unblock a specific URL. Use when the user argues they need access to a blocked site for their work. The system will adjudicate based on the override rubric.',
      parameters: z.object({
        url: z.string().describe('The URL to unblock'),
        reason: z.string().describe('Why the user needs access to this URL'),
        requestedMinutes: z.number().min(5).max(30).optional().describe('How long they need. Default 15.'),
      }),
      execute: async ({ url, reason, requestedMinutes }) => {
        if (!sessionId) return { error: 'No active session for override' };
        const result = await apiPost('/api/guardian/override', {
          sessionId,
          url,
          reason,
          requestedMinutes: requestedMinutes || 15,
        });
        return {
          approved: result.approved,
          reason: result.reason,
          ttlMinutes: result.ttlMinutes,
          explainability: result.explainability,
        };
      },
    });

    const getDayBriefingTool = llm.tool({
      description: 'Get the daily briefing with energy forecast, active goals, recurring distractions, and coaching style. Use when the user asks about their day or productivity outlook.',
      parameters: z.object({}),
      execute: async () => {
        const result = await apiGet('/api/guardian/day-briefing');
        return {
          energyForecast: result.energyForecast,
          activeGoals: result.activeGoals?.slice(0, 5),
          activeTasks: result.activeTasks?.slice(0, 5),
          recurringDistractions: result.recurringDistractions,
          coachingStyle: result.coachingStyle,
          bestStartHour: result.bestStartHour,
          openingMessage: result.openingMessage,
        };
      },
    });

    const guardianActionTool = llm.tool({
      description: 'Fallback for any LifeOS action not covered by the specific tools: tutoring, personalized context, task management, habit logging, general questions. Pass the exact user request.',
      parameters: z.object({
        request: z.string().describe('The exact user request or shortest faithful paraphrase.'),
      }),
      execute: async ({ request }) => {
        const result = await apiPost('/api/voice/push-to-talk', {
          transcript: request,
          sessionId: sessionId || undefined,
        });
        return {
          type: result.type || 'intent_only',
          responseText: result.responseText || '',
          sessionId: result.session?.sessionId || sessionId || null,
          approved: result.decision?.approved ?? null,
          explainability: result.decision?.explainability || null,
        };
      },
    });

    // ─── Agent Setup ──────────────────────────────────────────────────────────

    const agent = new voice.Agent({
      instructions: buildGuardianInstructions({ sessionId, targetTitle, sessionContext }),
      llm: realtimeModel,
      tools: {
        get_guardian_state: getGuardianStateTool,
        start_session: startSessionTool,
        end_session: endSessionTool,
        request_override: requestOverrideTool,
        get_day_briefing: getDayBriefingTool,
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

    const modeLabel = sessionContext?.intentProfile?.workMode || 'focus';
    const energyLabel = sessionContext?.intentProfile?.energyAtStart || '';
    session.say(`Guardian online. ${modeLabel} mode${energyLabel ? `, ${energyLabel} energy` : ''}. We are focused on ${targetTitle}. Tell me what you need.`, {
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
