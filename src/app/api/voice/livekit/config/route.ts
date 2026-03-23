import { NextResponse } from 'next/server';
import {
  getCloudReasoningMode,
  getCloudReasoningPolicySummary,
  usesCloudRawAudio,
} from '@/lib/cloud-privacy';
import {
  getGuardianVoiceAgentModel,
  getGuardianVoiceMode,
  getGuardianVoiceModeSummary,
  getGuardianVoiceProvider,
  getGuardianVoiceAgentVoice,
  getLifeOSAppUrl,
  getLiveKitAgentName,
  getLiveKitWsUrl,
  hasWhisperCppConfigured,
  isGuardianVoiceAgentConfigured,
  isLiveKitConfigured,
} from '@/lib/livekit';

export async function GET() {
  const liveKitEnabled = isLiveKitConfigured();
  const realtimeConversationReady = isGuardianVoiceAgentConfigured();
  const voiceMode = getGuardianVoiceMode();
  const cloudReasoningMode = getCloudReasoningMode();

  return NextResponse.json({
    enabled: liveKitEnabled,
    wsUrl: getLiveKitWsUrl(),
    mode: realtimeConversationReady
      ? 'livekit-room'
      : liveKitEnabled
        ? 'livekit-room-transport-only'
        : 'push-to-talk-fallback',
    features: {
      interruptionHandling: true,
      semanticTurnDetection: true,
      wakeWord: false,
    },
    agentName: getLiveKitAgentName(),
    voiceMode,
    voiceProvider: getGuardianVoiceProvider(),
    voiceModeSummary: getGuardianVoiceModeSummary(),
    cloudReasoningMode,
    cloudReasoningPolicy: getCloudReasoningPolicySummary(),
    cloudReasoningUsesSanitizedText: cloudReasoningMode === 'cloud-reasoning',
    cloudReasoningUsesRawAudio: usesCloudRawAudio(),
    realtimeConversationReady,
    guardianVoiceAgentConfigured: realtimeConversationReady,
    pushToTalkTranscriptionConfigured: hasWhisperCppConfigured(),
    appUrl: getLifeOSAppUrl(),
    agentModel: getGuardianVoiceAgentModel(),
    agentVoice: getGuardianVoiceAgentVoice(),
  });
}
