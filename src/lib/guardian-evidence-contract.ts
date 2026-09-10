export const GUARDIAN_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const GUARDIAN_SLICE_MS = 5_000;
export const GUARDIAN_WATERMARK_MS = 15_000;
export const MIN_NATIVE_COLLECTOR_VERSION = '0.3.0';
export const MIN_CHROME_COLLECTOR_VERSION = '1.3.1';

export type GuardianCollector = 'native' | 'chrome';
export type GuardianPrivacyDecision = 'allow' | 'redact' | 'drop';

export interface GuardianEvidenceV2 {
  schemaVersion: 2;
  eventId: string;
  sequence: number;
  collector: GuardianCollector;
  collectorVersion: string;
  deviceId: string;
  sessionId: string;
  observedStart: string;
  observedEnd: string;
  capabilities: string[];
  privacy: {
    decision: GuardianPrivacyDecision;
    reason: string;
  };
  native: {
    frontmostApp: string;
    windowTitle: string | null;
    systemState: 'active' | 'locked';
    inputIdleSeconds: number;
    screenRecordingStatus: string;
    captureCapable: boolean;
    sensitive: boolean;
  } | null;
  chrome: {
    windowFocused: boolean;
    url: string | null;
    domain: string | null;
    title: string | null;
    interaction: {
      keyboard: boolean;
      pointer: boolean;
      scroll: boolean;
      navigation: boolean;
      lastInputAt: string | null;
    };
    media: {
      playing: boolean;
      progressed: boolean;
      currentTime: number | null;
      title: string | null;
    };
  } | null;
}

export interface GuardianEvidenceValidation {
  ok: boolean;
  event?: GuardianEvidenceV2;
  errors: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.trim().slice(0, max);
  return required && !normalized ? null : normalized;
}

function nullableText(value: unknown, max: number) {
  if (value === null || value === undefined || value === '') return null;
  return text(value, max) || null;
}

function finite(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function compareVersions(actual: string | null | undefined, minimum: string) {
  const parts = (actual || '').split('.').map(part => Number.parseInt(part, 10));
  const required = minimum.split('.').map(part => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(parts.length, required.length); index += 1) {
    const left = Number.isFinite(parts[index]) ? parts[index] : 0;
    const right = Number.isFinite(required[index]) ? required[index] : 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

export function collectorIsCompatible(collector: GuardianCollector, version: string) {
  return compareVersions(
    version,
    collector === 'native' ? MIN_NATIVE_COLLECTOR_VERSION : MIN_CHROME_COLLECTOR_VERSION,
  ) >= 0;
}

export function validateGuardianEvidenceV2(input: unknown): GuardianEvidenceValidation {
  const value = record(input);
  const errors: string[] = [];
  const collector = value.collector as GuardianCollector;
  const eventId = text(value.eventId, 160, true);
  const collectorVersion = text(value.collectorVersion, 64, true);
  const deviceId = text(value.deviceId, 128, true);
  const sessionId = text(value.sessionId, 128, true);
  const sequence = finite(value.sequence, -1);
  const startMs = Date.parse(String(value.observedStart || ''));
  const endMs = Date.parse(String(value.observedEnd || ''));

  if (value.schemaVersion !== GUARDIAN_EVIDENCE_SCHEMA_VERSION) errors.push('schemaVersion');
  if (!eventId) errors.push('eventId');
  if (!['native', 'chrome'].includes(collector)) errors.push('collector');
  if (!collectorVersion) errors.push('collectorVersion');
  if (!deviceId) errors.push('deviceId');
  if (!sessionId) errors.push('sessionId');
  if (!Number.isInteger(sequence) || sequence < 0) errors.push('sequence');
  if (!Number.isFinite(startMs)) errors.push('observedStart');
  if (!Number.isFinite(endMs)) errors.push('observedEnd');
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && (endMs <= startMs || endMs - startMs > 60_000)) {
    errors.push('observedInterval');
  }

  const privacyValue = record(value.privacy);
  const privacyDecision = privacyValue.decision as GuardianPrivacyDecision;
  const privacyReason = text(privacyValue.reason, 256, true);
  if (!['allow', 'redact', 'drop'].includes(privacyDecision)) errors.push('privacy.decision');
  if (!privacyReason) errors.push('privacy.reason');

  const nativeValue = value.native === null ? null : record(value.native);
  const chromeValue = value.chrome === null ? null : record(value.chrome);
  if (collector === 'native' && (!nativeValue || value.chrome !== null)) errors.push('native');
  if (collector === 'chrome' && (!chromeValue || value.native !== null)) errors.push('chrome');
  if (errors.length > 0) return { ok: false, errors };

  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities
        .map(item => text(item, 64))
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .slice(0, 32)
    : [];
  const retainContext = privacyDecision === 'allow';
  const interaction = record(chromeValue?.interaction);
  const media = record(chromeValue?.media);

  return {
    ok: true,
    errors: [],
    event: {
      schemaVersion: GUARDIAN_EVIDENCE_SCHEMA_VERSION,
      eventId: eventId!,
      sequence,
      collector,
      collectorVersion: collectorVersion!,
      deviceId: deviceId!,
      sessionId: sessionId!,
      observedStart: new Date(startMs).toISOString(),
      observedEnd: new Date(endMs).toISOString(),
      capabilities,
      privacy: { decision: privacyDecision, reason: privacyReason! },
      native: collector === 'native' && nativeValue
        ? {
            frontmostApp: retainContext ? text(nativeValue.frontmostApp, 128) || 'Unknown App' : 'Sensitive App',
            windowTitle: retainContext ? nullableText(nativeValue.windowTitle, 512) : null,
            systemState: nativeValue.systemState === 'locked' ? 'locked' : 'active',
            inputIdleSeconds: Math.max(0, finite(nativeValue.inputIdleSeconds)),
            screenRecordingStatus: text(nativeValue.screenRecordingStatus, 64) || 'unknown',
            captureCapable: nativeValue.captureCapable === true,
            sensitive: nativeValue.sensitive === true || privacyDecision !== 'allow',
          }
        : null,
      chrome: collector === 'chrome' && chromeValue
        ? {
            windowFocused: chromeValue.windowFocused === true,
            url: retainContext ? nullableText(chromeValue.url, 2_048) : null,
            domain: retainContext ? nullableText(chromeValue.domain, 256) : null,
            title: retainContext ? nullableText(chromeValue.title, 512) : null,
            interaction: {
              keyboard: interaction.keyboard === true,
              pointer: interaction.pointer === true,
              scroll: interaction.scroll === true,
              navigation: interaction.navigation === true,
              lastInputAt: nullableText(interaction.lastInputAt, 64),
            },
            media: {
              playing: media.playing === true,
              progressed: media.progressed === true,
              currentTime: typeof media.currentTime === 'number' && Number.isFinite(media.currentTime)
                ? Math.max(0, media.currentTime)
                : null,
              title: retainContext ? nullableText(media.title, 512) : null,
            },
          }
        : null,
    },
  };
}
