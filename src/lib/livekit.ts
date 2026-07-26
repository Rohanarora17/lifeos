import { AccessToken } from 'livekit-server-sdk';
import { GUARDIAN_VOICE_TOKEN_TTL_MS } from './guardian-voice-limits';

const DEFAULT_ROOM_PREFIX = 'lifeos-guardian';
const DEFAULT_APP_URL = 'http://127.0.0.1:3000';

function normalizeRoomSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
}

function hasVertexVoiceConfig() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
  return Boolean(project && location);
}

export type GuardianVoiceMode = 'local' | 'google-live';

export function getGuardianVoiceMode(): GuardianVoiceMode {
  return process.env.VOICE_MODE === 'google-live' ? 'google-live' : 'local';
}

export function isLiveKitConfigured() {
  return Boolean(
    process.env.LIVEKIT_WS_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

export function getLiveKitWsUrl() {
  return process.env.LIVEKIT_WS_URL || '';
}

export function getLiveKitAgentName() {
  return process.env.LIVEKIT_AGENT_NAME || 'lifeos-guardian-agent';
}

export function getLifeOSAppUrl() {
  return process.env.LIFEOS_APP_URL || DEFAULT_APP_URL;
}

export function getGuardianVoiceAgentModel() {
  return process.env.LIVEKIT_GUARDIAN_MODEL || 'gemini-live-2.5-flash';
}

export function getGuardianVoiceAgentVoice() {
  return process.env.LIVEKIT_GUARDIAN_VOICE || 'Aoede';
}

export function getGuardianVoiceVertexConfig() {
  return {
    project: process.env.GOOGLE_CLOUD_PROJECT || '',
    location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
    auth: 'adc' as const,
  };
}

export function hasWhisperCppConfigured() {
  return Boolean(process.env.WHISPER_CPP_URL);
}

export function hasPushToTalkTranscriptionConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY || process.env.WHISPER_CPP_URL);
}

export function getPushToTalkTranscriptionProvider() {
  if (process.env.ELEVENLABS_API_KEY) {
    return 'elevenlabs-scribe';
  }

  const whisperUrl = process.env.WHISPER_CPP_URL || '';
  if (whisperUrl.includes('groq.com')) {
    return 'groq-whisper';
  }
  if (whisperUrl.includes('openai.com')) {
    return 'openai-whisper';
  }
  if (whisperUrl) {
    return 'whisper.cpp-compatible';
  }
  return 'unconfigured';
}

export function isGuardianVoiceAgentConfigured() {
  return Boolean(
    getGuardianVoiceMode() === 'google-live' &&
    isLiveKitConfigured() &&
    hasVertexVoiceConfig() &&
    getLifeOSAppUrl()
  );
}

export function getGuardianVoiceProvider() {
  return getGuardianVoiceMode() === 'google-live' ? 'google-gemini-live' : 'local';
}

export function getGuardianVoiceModeSummary() {
  if (getGuardianVoiceMode() === 'google-live') {
    return 'Cloud realtime voice via Gemini Live over LiveKit';
  }

  return hasPushToTalkTranscriptionConfigured()
    ? `Push-to-talk transcription via ${getPushToTalkTranscriptionProvider()}`
    : `Local-first voice with push-to-talk fallback (set VOICE_MODE=google-live to enable cloud realtime)`;
}

export function buildGuardianRoomName(sessionId: string) {
  const prefix = normalizeRoomSegment(process.env.LIVEKIT_ROOM_PREFIX || DEFAULT_ROOM_PREFIX);
  return `${prefix}-${normalizeRoomSegment(sessionId)}`;
}

export async function createGuardianVoiceToken(input: {
  sessionId: string;
  targetTitle?: string;
  participantName?: string;
}) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = getLiveKitWsUrl();

  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error('LiveKit environment is not configured');
  }

  const roomName = buildGuardianRoomName(input.sessionId);
  const identity = `browser-${normalizeRoomSegment(input.sessionId)}`;
  const participantName = input.participantName || 'LifeOS Browser';

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name: participantName,
    ttl: `${Math.floor(GUARDIAN_VOICE_TOKEN_TTL_MS / 60_000)}m`,
    metadata: JSON.stringify({
      sessionId: input.sessionId,
      targetTitle: input.targetTitle || '',
      role: 'guardian-browser',
    }),
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  });

  return {
    token: await token.toJwt(),
    wsUrl,
    roomName,
    identity,
    participantName,
    agentName: getLiveKitAgentName(),
  };
}
