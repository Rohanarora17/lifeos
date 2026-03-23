import { AccessToken } from 'livekit-server-sdk';

const DEFAULT_ROOM_PREFIX = 'lifeos-guardian';
const DEFAULT_APP_URL = 'http://127.0.0.1:3000';

function normalizeRoomSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
}

function getGoogleApiKey() {
  return (
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.API_KEY ||
    process.env.GEMINI_API_KEY ||
    ''
  );
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
  return process.env.LIVEKIT_GUARDIAN_MODEL || 'gemini-2.5-flash-preview-native-audio-dialog';
}

export function getGuardianVoiceAgentVoice() {
  return process.env.LIVEKIT_GUARDIAN_VOICE || 'Aoede';
}

export function hasWhisperCppConfigured() {
  return Boolean(process.env.WHISPER_CPP_URL);
}

export function isGuardianVoiceAgentConfigured() {
  return Boolean(
    getGuardianVoiceMode() === 'google-live' &&
    isLiveKitConfigured() &&
    getGoogleApiKey() &&
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

  return hasWhisperCppConfigured()
    ? 'Local-first voice with whisper.cpp push-to-talk'
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
