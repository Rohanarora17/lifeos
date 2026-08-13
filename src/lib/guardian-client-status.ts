import { getDb } from '@/lib/db';

export const CLIENT_STALE_MS = 15_000;
// Chrome MV3 alarms fire every 30 seconds. Allow one alarm period plus normal
// scheduler jitter; the native frontmost-app heartbeat still prevents
// background Chrome from being selected during this window.
export const BROWSER_STALE_MS = 45_000;

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
  reason: 'ready' | 'disabled' | 'never_seen' | 'stale' | 'permission_required' | 'capture_unavailable';
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

export function recordNativeClientHeartbeat(input: NativeClientHeartbeat) {
  const deviceId = normalizeDeviceId(input.deviceId);
  const observedAt = isoOrNow(input.observedAt);
  const systemState: ClientSystemState = input.systemState === 'idle' || input.systemState === 'locked'
    ? input.systemState
    : 'active';
  getDb().prepare(`
    INSERT INTO native_client_status (
      device_id, client_version, last_seen_at, screen_recording_status,
      capture_capable, frontmost_app, frontmost_window_title, system_state,
      active_session_id, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
      updated_at = datetime('now')
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
  );
  return getGuardianClientReadiness();
}

export function getGuardianClientReadiness(nowMs = Date.now()): GuardianClientReadiness {
  const required = guardianClientRequired();
  if (!required) {
    return {
      ready: true, required: false, reason: 'disabled', deviceId: null,
      clientVersion: null, lastSeenAt: null, heartbeatAgeMs: null,
      screenRecordingStatus: 'disabled', captureCapable: true,
      frontmostApp: null, frontmostWindowTitle: null, systemState: 'active',
      activeSessionId: null, wakeSupported: true,
    };
  }

  const expected = process.env.LIFEOS_MACBOOK_DEVICE_ID?.trim();
  const row = (expected
    ? getDb().prepare('SELECT * FROM native_client_status WHERE device_id = ?').get(expected)
    : getDb().prepare('SELECT * FROM native_client_status ORDER BY last_seen_at DESC LIMIT 1').get()
  ) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      ready: false, required: true, reason: 'never_seen', deviceId: expected || null,
      clientVersion: null, lastSeenAt: null, heartbeatAgeMs: null,
      screenRecordingStatus: 'unknown', captureCapable: false,
      frontmostApp: null, frontmostWindowTitle: null, systemState: 'active',
      activeSessionId: null, wakeSupported: true,
    };
  }

  const lastSeenAt = String(row.last_seen_at || '');
  const heartbeatAgeMs = Math.max(0, nowMs - Date.parse(lastSeenAt));
  const screenRecordingStatus = String(row.screen_recording_status || 'unknown');
  const captureCapable = Number(row.capture_capable) === 1;
  let reason: GuardianClientReadiness['reason'] = 'ready';
  if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > CLIENT_STALE_MS) reason = 'stale';
  else if (screenRecordingStatus !== 'authorized') reason = 'permission_required';
  else if (!captureCapable) reason = 'capture_unavailable';

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
    activeSessionId: row.active_session_id ? String(row.active_session_id) : null,
    wakeSupported: true,
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
  getDb().prepare(`
    INSERT INTO browser_collector_status (
      device_id, last_seen_at, session_id, window_focused, collector_version,
      media_playback_active, media_title, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      session_id = excluded.session_id,
      window_focused = excluded.window_focused,
      collector_version = excluded.collector_version,
      media_playback_active = excluded.media_playback_active,
      media_title = excluded.media_title,
      updated_at = datetime('now')
  `).run(
    deviceId,
    isoOrNow(input.observedAt),
    input.sessionId?.trim() || null,
    input.windowFocused === false ? 0 : 1,
    input.collectorVersion?.trim() || 'unknown',
    input.mediaPlaybackActive === true ? 1 : 0,
    input.mediaTitle?.trim() || null,
  );
}

export function getBrowserCollectorState(sessionId: string, nowMs = Date.now()) {
  const row = getDb().prepare(`
    SELECT last_seen_at, window_focused, media_playback_active, media_title
    FROM browser_collector_status
    WHERE session_id = ?
    ORDER BY last_seen_at DESC
    LIMIT 1
  `).get(sessionId) as {
    last_seen_at: string;
    window_focused: number;
    media_playback_active: number;
    media_title: string | null;
  } | undefined;
  if (!row || row.window_focused !== 1) {
    return { fresh: false, mediaPlaybackActive: false, mediaTitle: null };
  }
  const age = nowMs - Date.parse(row.last_seen_at);
  const fresh = Number.isFinite(age) && age >= 0 && age <= BROWSER_STALE_MS;
  return {
    fresh,
    mediaPlaybackActive: fresh && row.media_playback_active === 1,
    mediaTitle: fresh ? row.media_title : null,
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
