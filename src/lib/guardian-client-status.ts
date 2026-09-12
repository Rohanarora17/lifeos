import { getDb } from '@/lib/db';
import {
  collectorIsCompatible,
  GUARDIAN_EVIDENCE_SCHEMA_VERSION,
  MIN_CHROME_COLLECTOR_VERSION,
  MIN_NATIVE_COLLECTOR_VERSION,
} from '@/lib/guardian-evidence-contract';

export const CLIENT_STALE_MS = 15_000;
// The durable telemetry state machine checkpoints sustained tabs at most once
// per minute. Allow that checkpoint plus scheduler/network jitter; the native
// frontmost-app heartbeat still prevents background Chrome from being selected.
export const BROWSER_STALE_MS = 35_000;

export type ClientSystemState = 'active' | 'idle' | 'locked';

export interface NativeClientHeartbeat {
  deviceId?: string | null;
  clientVersion?: string | null;
  screenRecordingStatus?: string | null;
  captureCapable?: boolean | null;
  frontmostApp?: string | null;
  frontmostWindowTitle?: string | null;
  systemState?: ClientSystemState | null;
  activeSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
  observedAt?: string | null;
}

export interface GuardianClientReadiness {
  ready: boolean;
  required: boolean;
  reason: 'ready' | 'disabled' | 'never_seen' | 'stale' | 'permission_required' | 'capture_unavailable' | 'incompatible_client';
  deviceId: string | null;
  clientVersion: string | null;
  lastSeenAt: string | null;
  heartbeatAgeMs: number | null;
  screenRecordingStatus: string;
  captureCapable: boolean;
  frontmostApp: string | null;
  frontmostWindowTitle: string | null;
  systemState: ClientSystemState;
  activeSessionId: string | null;
  wakeSupported: boolean;
  clockSkewMs: number | null;
  nativeCollector?: {
    ready: boolean;
    compatible: boolean;
    version: string | null;
    minimumVersion: string;
    lastSeenAt: string | null;
    permissions: { screenRecording: string; captureCapable: boolean };
  };
  chromeCollector?: {
    detected: boolean;
    ready: boolean;
    compatible: boolean;
    version: string | null;
    minimumVersion: string;
    lastSeenAt: string | null;
    windowFocused: boolean;
    updateRequired: boolean;
    clockSkewMs: number | null;
  };
  evidenceSchemaVersion?: number;
  selectedSource?: 'chrome' | 'vision' | 'vision_fallback' | 'idle' | 'unavailable';
  updateInstructions?: string[];
}

export type EvidenceCoverageState = 'current' | 'partial' | 'missing';

export interface GuardianEvidenceHealth {
  coverage: EvidenceCoverageState;
  sources: {
    chrome: EvidenceCoverageState;
    macbookVision: EvidenceCoverageState;
    phone: EvidenceCoverageState;
  };
  currentSources: number;
  totalSources: number;
  lastEvidenceAt: string | null;
}

export class VisionClientUnavailableError extends Error {
  readonly code = 'vision_client_required';
  readonly readiness: GuardianClientReadiness;

  constructor(readiness: GuardianClientReadiness) {
    super(`MacBook vision client is not ready: ${readiness.reason}`);
    this.name = 'VisionClientUnavailableError';
    this.readiness = readiness;
  }
}

const MAX_DEVICE_CLOCK_SKEW_MS = 5 * 60_000;

function parseServerTime(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(normalized);
}

export function guardianClientRequired() {
  return process.env.LIFEOS_REQUIRE_VISION_CLIENT !== 'false';
}

function normalizeDeviceId(value?: string | null) {
  return value?.trim() || process.env.LIFEOS_MACBOOK_DEVICE_ID?.trim() || 'macbook-primary';
}

function isoOrNow(value?: string | null) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function safeLatest(query: string): string | null {
  try {
    const row = getDb().prepare(query).get() as { at: string | null } | undefined;
    return row?.at || null;
  } catch {
    return null;
  }
}

function newestIso(values: Array<string | null>): string | null {
  const times = values
    .map(value => ({ value, time: value ? Date.parse(value) : NaN }))
    .filter((item): item is { value: string; time: number } => Boolean(item.value) && Number.isFinite(item.time));
  if (times.length === 0) return null;
  return times.sort((left, right) => right.time - left.time)[0].value;
}

function evidenceCoverage(
  lastSeenAt: string | null,
  nowMs: number,
  currentHours: number,
  usable = true,
): EvidenceCoverageState {
  if (!lastSeenAt) return 'missing';
  const age = nowMs - Date.parse(lastSeenAt);
  if (
    usable
    && Number.isFinite(age)
    && age >= -MAX_DEVICE_CLOCK_SKEW_MS
    && age <= currentHours * 3_600_000
  ) return 'current';
  return 'partial';
}

export function getGuardianEvidenceHealth(nowMs = Date.now()): GuardianEvidenceHealth {
  const readiness = getGuardianClientReadiness(nowMs);
  const chromeAt = newestIso([
    safeLatest(`SELECT MAX(last_seen_at) AS at FROM browser_collector_status`),
    safeLatest(`SELECT MAX(observed_end) AS at FROM telemetry_events_v1 WHERE source = 'browser_extension'`),
    safeLatest(`SELECT MAX(observed_end) AS at FROM guardian_evidence_events WHERE collector = 'chrome' AND compatible = 1`),
  ]);
  const nativeAt = newestIso([
    safeLatest(`SELECT MAX(last_seen_at) AS at FROM native_client_status`),
    safeLatest(`SELECT MAX(observed_at) AS at FROM screen_observations`),
    safeLatest(`SELECT MAX(observed_end) AS at FROM guardian_evidence_events WHERE collector = 'native' AND compatible = 1`),
  ]);
  const phoneAt = safeLatest(`SELECT MAX(received_at) AS at FROM phone_screen_time`);
  const nativeUsable = Boolean(
    readiness.nativeCollector?.compatible
      && readiness.nativeCollector.permissions.screenRecording === 'authorized'
      && readiness.nativeCollector.permissions.captureCapable,
  );
  const chromeUsable = !readiness.chromeCollector?.detected || readiness.chromeCollector.compatible;
  const sources = {
    chrome: evidenceCoverage(chromeAt, nowMs, 6, chromeUsable),
    macbookVision: evidenceCoverage(nativeAt, nowMs, 6, nativeUsable),
    phone: evidenceCoverage(phoneAt, nowMs, 18),
  };
  const values = Object.values(sources);
  const currentSources = values.filter(value => value === 'current').length;
  const coverage: EvidenceCoverageState = values.every(value => value === 'current')
    ? 'current'
    : values.some(value => value !== 'missing')
      ? 'partial'
      : 'missing';
  return {
    coverage,
    sources,
    currentSources,
    totalSources: values.length,
    lastEvidenceAt: newestIso([chromeAt, nativeAt, phoneAt]),
  };
}

function browserCollectorReadiness(sessionId: string | null, nowMs: number) {
  const rows = getDb().prepare(`
    SELECT last_seen_at, updated_at, window_focused, collector_version
    FROM browser_collector_status
    WHERE (? IS NULL OR session_id = ?)
    ORDER BY updated_at DESC
  `).all(sessionId, sessionId) as Array<{
    last_seen_at: string; updated_at: string; window_focused: number; collector_version: string;
  }>;
  const readyRow = rows.find(candidate => {
    const age = Math.max(0, nowMs - parseServerTime(candidate.updated_at));
    return candidate.window_focused === 1
      && collectorIsCompatible('chrome', candidate.collector_version)
      && Number.isFinite(age)
      && age <= BROWSER_STALE_MS;
  });
  const row = readyRow ?? rows[0];
  const compatible = Boolean(row && collectorIsCompatible('chrome', row.collector_version));
  const ready = Boolean(readyRow);
  const clockSkewMs = row
    ? Date.parse(row.last_seen_at) - parseServerTime(row.updated_at)
    : null;
  return {
    row,
    state: {
      detected: Boolean(row), ready, compatible,
      version: row?.collector_version ?? null, minimumVersion: MIN_CHROME_COLLECTOR_VERSION,
      lastSeenAt: row?.last_seen_at ?? null,
      windowFocused: row?.window_focused === 1,
      updateRequired: Boolean(row && !compatible),
      clockSkewMs: Number.isFinite(clockSkewMs) ? clockSkewMs : null,
    },
  };
}

export function recordNativeClientHeartbeat(input: NativeClientHeartbeat) {
  const deviceId = normalizeDeviceId(input.deviceId);
  const observedAt = isoOrNow(input.observedAt);
  const receivedAt = new Date().toISOString();
  const systemState: ClientSystemState = input.systemState === 'idle' || input.systemState === 'locked'
    ? input.systemState
    : 'active';
  getDb().prepare(`
    INSERT INTO native_client_status (
      device_id, client_version, last_seen_at, screen_recording_status,
      capture_capable, frontmost_app, frontmost_window_title, system_state,
      active_session_id, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      client_version = excluded.client_version,
      last_seen_at = excluded.last_seen_at,
      screen_recording_status = excluded.screen_recording_status,
      capture_capable = excluded.capture_capable,
      frontmost_app = excluded.frontmost_app,
      frontmost_window_title = excluded.frontmost_window_title,
      system_state = excluded.system_state,
      active_session_id = excluded.active_session_id,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(
    deviceId,
    input.clientVersion?.trim() || 'unknown',
    observedAt,
    input.screenRecordingStatus?.trim() || 'unknown',
    input.captureCapable === true ? 1 : 0,
    input.frontmostApp?.trim() || null,
    input.frontmostWindowTitle?.trim() || null,
    systemState,
    input.activeSessionId?.trim() || null,
    JSON.stringify(input.metadata ?? {}),
    receivedAt,
  );
  return getGuardianClientReadiness();
}

export function getGuardianClientReadiness(nowMs = Date.now()): GuardianClientReadiness {
  const required = guardianClientRequired();
  if (!required) {
    const browser = browserCollectorReadiness(null, nowMs);
    return {
      ready: true, required: false, reason: 'disabled', deviceId: null,
      clientVersion: null, lastSeenAt: null, heartbeatAgeMs: null,
      screenRecordingStatus: 'disabled', captureCapable: true,
      frontmostApp: null, frontmostWindowTitle: null, systemState: 'active',
      activeSessionId: null, wakeSupported: true,
      clockSkewMs: browser.state.clockSkewMs,
      nativeCollector: {
        ready: true, compatible: true, version: null, minimumVersion: MIN_NATIVE_COLLECTOR_VERSION,
        lastSeenAt: null, permissions: { screenRecording: 'disabled', captureCapable: true },
      },
      chromeCollector: browser.state,
      evidenceSchemaVersion: GUARDIAN_EVIDENCE_SCHEMA_VERSION,
      selectedSource: browser.state.ready ? 'chrome' : 'vision_fallback',
      updateInstructions: browser.state.detected ? [] : ['Chrome detail is unavailable until the LifeOS extension reports evidence.'],
    };
  }

  const expected = process.env.LIFEOS_MACBOOK_DEVICE_ID?.trim();
  const row = (expected
    ? getDb().prepare('SELECT * FROM native_client_status WHERE device_id = ?').get(expected)
    : getDb().prepare('SELECT * FROM native_client_status ORDER BY updated_at DESC LIMIT 1').get()
  ) as Record<string, unknown> | undefined;

  if (!row) {
    const browser = browserCollectorReadiness(null, nowMs);
    return {
      ready: false, required: true, reason: 'never_seen', deviceId: expected || null,
      clientVersion: null, lastSeenAt: null, heartbeatAgeMs: null,
      screenRecordingStatus: 'unknown', captureCapable: false,
      frontmostApp: null, frontmostWindowTitle: null, systemState: 'active',
      activeSessionId: null, wakeSupported: true,
      clockSkewMs: browser.state.clockSkewMs,
      nativeCollector: {
        ready: false, compatible: false, version: null, minimumVersion: MIN_NATIVE_COLLECTOR_VERSION,
        lastSeenAt: null, permissions: { screenRecording: 'unknown', captureCapable: false },
      },
      chromeCollector: browser.state,
      evidenceSchemaVersion: GUARDIAN_EVIDENCE_SCHEMA_VERSION,
      selectedSource: 'unavailable',
      updateInstructions: [
        'Install or start the MacBook collector before beginning a Guardian session.',
        ...(!browser.state.detected ? ['Reload or install the LifeOS Chrome extension for browser detail.'] : []),
      ],
    };
  }

  const lastSeenAt = String(row.last_seen_at || '');
  const heartbeatAgeMs = Math.max(0, nowMs - parseServerTime(row.updated_at));
  const screenRecordingStatus = String(row.screen_recording_status || 'unknown');
  const captureCapable = Number(row.capture_capable) === 1;
  let reason: GuardianClientReadiness['reason'] = 'ready';
  if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > CLIENT_STALE_MS) reason = 'stale';
  else if (screenRecordingStatus !== 'authorized') reason = 'permission_required';
  else if (!captureCapable) reason = 'capture_unavailable';
  else if (!collectorIsCompatible('native', String(row.client_version || 'unknown'))) reason = 'incompatible_client';

  const activeSessionId = row.active_session_id ? String(row.active_session_id) : null;
  const browser = browserCollectorReadiness(activeSessionId, nowMs);
  const browserRow = browser.row;
  const browserCompatible = browser.state.compatible;
  const browserReady = browser.state.ready;
  const nativeCompatible = collectorIsCompatible('native', String(row.client_version || 'unknown'));
  const chromeFrontmost = isChromeApplication(row.frontmost_app ? String(row.frontmost_app) : null);
  const nativeClockSkewMs = Date.parse(lastSeenAt) - parseServerTime(row.updated_at);
  const clockSkewValues = [nativeClockSkewMs, browser.state.clockSkewMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const clockSkewMs = clockSkewValues.length > 0
    ? clockSkewValues.sort((left, right) => Math.abs(right) - Math.abs(left))[0]
    : null;
  const clockWarning = clockSkewMs !== null && Math.abs(clockSkewMs) > 60_000
    ? [`Collector and LifeOS server clocks differ by about ${Math.round(Math.abs(clockSkewMs) / 1_000)} seconds. Sync the Mac Mini clock; session start/end times and validation windows can otherwise disagree.`]
    : [];

  return {
    ready: reason === 'ready', required: true, reason,
    deviceId: String(row.device_id),
    clientVersion: String(row.client_version || 'unknown'),
    lastSeenAt,
    heartbeatAgeMs,
    screenRecordingStatus,
    captureCapable,
    frontmostApp: row.frontmost_app ? String(row.frontmost_app) : null,
    frontmostWindowTitle: row.frontmost_window_title ? String(row.frontmost_window_title) : null,
    systemState: row.system_state === 'idle' || row.system_state === 'locked' ? row.system_state : 'active',
    activeSessionId,
    wakeSupported: true,
    clockSkewMs,
    nativeCollector: {
      ready: reason === 'ready', compatible: nativeCompatible,
      version: String(row.client_version || 'unknown'), minimumVersion: MIN_NATIVE_COLLECTOR_VERSION,
      lastSeenAt, permissions: { screenRecording: screenRecordingStatus, captureCapable },
    },
    chromeCollector: browser.state,
    evidenceSchemaVersion: GUARDIAN_EVIDENCE_SCHEMA_VERSION,
    selectedSource: reason !== 'ready'
      ? 'unavailable'
      : row.system_state === 'locked'
        ? 'idle'
        : chromeFrontmost
          ? browserReady ? 'chrome' : 'vision_fallback'
          : 'vision',
    updateInstructions: [
      ...(!nativeCompatible ? ['Update the MacBook collector with scripts/install-native-copilot.sh --update.'] : []),
      ...(browserRow && !browserCompatible ? ['Reload or update the LifeOS Chrome extension.'] : []),
      ...(!browserRow ? ['Chrome detail is unavailable until the LifeOS extension reports evidence; Vision fallback will be used.'] : []),
      ...clockWarning,
    ],
  };
}

export function assertGuardianClientReady() {
  const readiness = getGuardianClientReadiness();
  if (!readiness.ready) throw new VisionClientUnavailableError(readiness);
  return readiness;
}

export function isChromeApplication(app: string | null | undefined) {
  const value = (app || '').trim().toLowerCase();
  return value === 'google chrome' || value === 'chrome' || value.includes('google chrome');
}

export function recordBrowserCollectorHeartbeat(input: {
  deviceId?: string | null;
  sessionId?: string | null;
  windowFocused?: boolean;
  collectorVersion?: string | null;
  mediaPlaybackActive?: boolean;
  mediaTitle?: string | null;
  observedAt?: string | null;
}) {
  const deviceId = input.deviceId?.trim() || 'chrome-primary';
  const receivedAt = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO browser_collector_status (
      device_id, last_seen_at, session_id, window_focused, collector_version,
      media_playback_active, media_title, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      session_id = excluded.session_id,
      window_focused = excluded.window_focused,
      collector_version = excluded.collector_version,
      media_playback_active = excluded.media_playback_active,
      media_title = excluded.media_title,
      updated_at = excluded.updated_at
  `).run(
    deviceId,
    isoOrNow(input.observedAt),
    input.sessionId?.trim() || null,
    input.windowFocused === false ? 0 : 1,
    input.collectorVersion?.trim() || 'unknown',
    input.mediaPlaybackActive === true ? 1 : 0,
    input.mediaTitle?.trim() || null,
    receivedAt,
  );
}

export function getBrowserCollectorState(sessionId: string, nowMs = Date.now()) {
  const rows = getDb().prepare(`
    SELECT last_seen_at, updated_at, window_focused, media_playback_active, media_title, collector_version
    FROM browser_collector_status
    WHERE session_id = ?
    ORDER BY updated_at DESC
  `).all(sessionId) as Array<{
    last_seen_at: string;
    updated_at: string;
    window_focused: number;
    media_playback_active: number;
    media_title: string | null;
    collector_version: string;
  }>;
  const row = rows.find(candidate => {
    const age = Math.max(0, nowMs - parseServerTime(candidate.updated_at));
    return candidate.window_focused === 1
      && collectorIsCompatible('chrome', candidate.collector_version)
      && Number.isFinite(age)
      && age <= BROWSER_STALE_MS;
  });
  if (!row) {
    return { fresh: false, mediaPlaybackActive: false, mediaTitle: null };
  }
  return {
    fresh: true,
    mediaPlaybackActive: row.media_playback_active === 1,
    mediaTitle: row.media_title,
  };
}

export function isBrowserCollectorFresh(sessionId: string, nowMs = Date.now()) {
  return getBrowserCollectorState(sessionId, nowMs).fresh;
}

export function selectedCaptureSource(sessionId: string): 'chrome' | 'vision' | 'idle' | 'private' | 'unavailable' {
  const client = getGuardianClientReadiness();
  if (!client.ready) return 'unavailable';
  const browser = getBrowserCollectorState(sessionId);
  const chromeFrontmost = isChromeApplication(client.frontmostApp) && browser.fresh;
  if (client.systemState === 'locked') return 'idle';
  // Advancing foreground media is intentional passive engagement, not absence.
  // Lock always wins, and stale/background Chrome can never override native idle.
  if (client.systemState === 'idle') {
    return chromeFrontmost && browser.mediaPlaybackActive ? 'chrome' : 'idle';
  }
  if (chromeFrontmost) return 'chrome';
  return 'vision';
}
