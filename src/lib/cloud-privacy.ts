export type CloudReasoningMode = 'local-only' | 'cloud-reasoning' | 'cloud-realtime';

export function getCloudReasoningMode(): CloudReasoningMode {
  if (process.env.VOICE_MODE === 'google-live') {
    return 'cloud-realtime';
  }

  if (process.env.CLOUD_REASONING_MODE === 'local-only') {
    return 'local-only';
  }

  return 'cloud-reasoning';
}

export function canUseCloudTextReasoning() {
  return getCloudReasoningMode() !== 'local-only';
}

export function usesCloudRawAudio() {
  return getCloudReasoningMode() === 'cloud-realtime';
}

export function sanitizeTranscriptForCloud(transcript: string) {
  return transcript
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\bhttps?:\/\/\S+\b/gi, '[redacted-url]')
    .replace(/\b(?:\d[ -]*?){9,16}\b/g, '[redacted-number]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-secret]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getCloudReasoningPolicySummary() {
  const mode = getCloudReasoningMode();

  if (mode === 'local-only') {
    return 'Cloud reasoning disabled. Voice intent and tutoring use local heuristics only.';
  }

  if (mode === 'cloud-realtime') {
    return 'Cloud realtime voice is enabled explicitly. Raw audio may be processed by the selected realtime provider.';
  }

  return 'Cloud reasoning is text-only. Raw audio stays local and only sanitized text is sent to the LLM.';
}
