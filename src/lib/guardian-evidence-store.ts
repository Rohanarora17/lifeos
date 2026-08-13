import { createHash } from 'crypto';
import { getDb } from '@/lib/db';
import {
  collectorIsCompatible,
  GUARDIAN_SLICE_MS,
  GUARDIAN_WATERMARK_MS,
  type GuardianEvidenceV2,
  validateGuardianEvidenceV2,
} from '@/lib/guardian-evidence-contract';
import {
  isChromeApplication,
  recordBrowserCollectorHeartbeat,
  recordNativeClientHeartbeat,
} from '@/lib/guardian-client-status';
import type { CanonicalScoringInterval } from '@/lib/session-activity';

export type GuardianEvidenceMode = 'legacy' | 'shadow' | 'authoritative';

export interface GuardianEvidenceIngestResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; errors: string[] }>;
  incompatible: Array<{ index: number; collector: string; version: string }>;
  canonicalizedSessions: string[];
}

type EvidenceRow = {
  event_id: string;
  collector: 'native' | 'chrome';
  observed_start: string;
  observed_end: string;
  privacy_decision: string;
  payload_json: string;
};

function parsePayload(row: EvidenceRow): GuardianEvidenceV2 {
  return JSON.parse(row.payload_json) as GuardianEvidenceV2;
}

export function configuredGuardianEvidenceMode(): GuardianEvidenceMode {
  const value = process.env.LIFEOS_GUARDIAN_EVIDENCE_MODE?.trim().toLowerCase();
  if (value === 'authoritative' || value === 'legacy') return value;
  return 'shadow';
}

export function getSessionEvidenceMode(sessionId: string): GuardianEvidenceMode {
  const value = getDb().prepare(`
    SELECT evidence_pipeline_mode FROM guardian_sessions WHERE session_id = ?
  `).pluck().get(sessionId);
  return value === 'authoritative' || value === 'shadow' ? value : 'legacy';
}

function overlapMs(row: EvidenceRow, startMs: number, endMs: number) {
  return Math.max(0, Math.min(endMs, Date.parse(row.observed_end)) - Math.max(startMs, Date.parse(row.observed_start)));
}

function bestEvidence(rows: EvidenceRow[], startMs: number, endMs: number) {
  return [...rows].sort((left, right) => {
    const overlap = overlapMs(right, startMs, endMs) - overlapMs(left, startMs, endMs);
    return overlap || Date.parse(right.observed_end) - Date.parse(left.observed_end);
  })[0] ?? null;
}

function sessionCategory(sessionId: string, domain: string | null, app: string | null) {
  if (domain) {
    const classification = getDb().prepare(`
      SELECT classification FROM session_domain_classifications
      WHERE session_id = ? AND domain = ?
    `).pluck().get(sessionId, domain);
    if (classification === 'on_topic') return 'productive' as const;
    if (classification === 'distraction') return 'distraction' as const;
  }
  if (app) {
    const category = getDb().prepare(`
      SELECT category FROM activities
      WHERE guardian_session_id = ? AND domain = ?
      ORDER BY started_at DESC LIMIT 1
    `).pluck().get(sessionId, app);
    if (category === 'productive' || category === 'distraction') return category;
  }
  return 'neutral' as const;
}

function hasTaskAlignedVisionEvidence(sessionId: string, app: string, startMs: number, endMs: number) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM screen_observations
    WHERE session_id = ? AND app = ? AND productive_for_goals = 1
      AND confidence >= 0.6
      AND observed_at >= ? AND observed_at < ?
    LIMIT 1
  `).get(
    sessionId,
    app,
    new Date(startMs - GUARDIAN_WATERMARK_MS).toISOString(),
    new Date(endMs + GUARDIAN_WATERMARK_MS).toISOString(),
  ));
}

function canonicalDecision(
  sessionId: string,
  startMs: number,
  endMs: number,
  evidence: EvidenceRow[],
) {
  const nativeRows = evidence.filter(row => row.collector === 'native');
  const chromeRows = evidence.filter(row => row.collector === 'chrome');
  const nativeRow = bestEvidence(nativeRows, startMs, endMs);
  if (!nativeRow) {
    return {
      source: 'unverified', state: 'unverified', app: null, windowTitle: null,
      url: null, domain: null, title: null, category: 'neutral', subcategory: 'missing_native_evidence',
      engagementState: 'disconnected', engagementConfidence: 1, scoreEligible: false, counted: false,
      reason: 'No time-aligned native evidence was available; background browser evidence cannot be counted.',
      evidenceIds: [] as string[],
    } as const;
  }

  const native = parsePayload(nativeRow);
  const nativePayload = native.native!;
  if (nativePayload.systemState === 'locked') {
    return {
      source: 'idle', state: 'locked', app: 'macOS', windowTitle: null,
      url: null, domain: null, title: 'Device locked', category: 'neutral', subcategory: 'locked',
      engagementState: 'inactive', engagementConfidence: 1, scoreEligible: false, counted: true,
      reason: 'Time-aligned native evidence confirmed that the MacBook was locked.',
      evidenceIds: [nativeRow.event_id],
    } as const;
  }
  if (nativePayload.sensitive || native.privacy.decision !== 'allow') {
    return {
      source: 'private', state: 'private', app: 'Sensitive App', windowTitle: null,
      url: null, domain: null, title: 'Private activity', category: 'neutral', subcategory: 'privacy_filtered',
      engagementState: 'private', engagementConfidence: 1, scoreEligible: false, counted: true,
      reason: 'The native client identified a sensitive context; no visual or browser content was retained.',
      evidenceIds: [nativeRow.event_id],
    } as const;
  }

  const app = nativePayload.frontmostApp || 'Unknown App';
  if (isChromeApplication(app)) {
    const focusedChrome = chromeRows.filter(row => {
      const event = parsePayload(row);
      return event.privacy.decision === 'allow' && event.chrome?.windowFocused === true;
    });
    const chromeRow = bestEvidence(focusedChrome, startMs, endMs);
    if (chromeRow) {
      const browser = parsePayload(chromeRow).chrome!;
      const interactive = browser.interaction.keyboard
        || browser.interaction.pointer
        || browser.interaction.scroll
        || browser.interaction.navigation;
      const passive = browser.media.playing && browser.media.progressed;
      const engagementState = passive ? 'passive_engaged' : interactive ? 'interactive' : 'uncertain';
      const domain = browser.domain;
      return {
        source: 'chrome', state: 'active', app: 'Google Chrome', windowTitle: browser.title,
        url: browser.url, domain, title: browser.title || browser.media.title,
        category: sessionCategory(sessionId, domain, null), subcategory: passive ? 'foreground_media' : 'browser',
        engagementState, engagementConfidence: passive ? 0.98 : interactive ? 0.95 : 0.35,
        scoreEligible: passive || interactive, counted: true,
        reason: passive
          ? 'Native evidence confirmed Chrome was frontmost and the focused media position advanced.'
          : interactive
            ? 'Native evidence confirmed Chrome was frontmost and the extension reported foreground interaction.'
            : 'Chrome was frontmost, but neither interaction nor advancing foreground media was verified.',
        evidenceIds: [nativeRow.event_id, chromeRow.event_id],
      } as const;
    }
    const active = nativePayload.inputIdleSeconds < 180;
    return {
      source: 'vision', state: 'active', app, windowTitle: nativePayload.windowTitle,
      url: 'native://google-chrome', domain: 'native:google chrome', title: nativePayload.windowTitle || app,
      category: sessionCategory(sessionId, null, app), subcategory: 'chrome_vision_fallback',
      engagementState: active ? 'interactive' : 'uncertain', engagementConfidence: active ? 0.8 : 0.3,
      scoreEligible: active, counted: true,
      reason: 'Native evidence confirmed Chrome was frontmost, but compatible extension evidence was unavailable.',
      evidenceIds: [nativeRow.event_id],
    } as const;
  }

  const visionProgress = hasTaskAlignedVisionEvidence(sessionId, app, startMs, endMs);
  const interactive = nativePayload.inputIdleSeconds < 180;
  const engagementState = visionProgress ? 'passive_engaged' : interactive ? 'interactive' : 'uncertain';
  return {
    source: 'vision', state: 'active', app, windowTitle: nativePayload.windowTitle,
    url: `native://${encodeURIComponent(app)}`, domain: `native:${app.toLowerCase()}`,
    title: nativePayload.windowTitle || app, category: sessionCategory(sessionId, null, app),
    subcategory: 'native_app', engagementState,
    engagementConfidence: visionProgress ? 0.9 : interactive ? 0.85 : 0.3,
    scoreEligible: visionProgress || interactive, counted: true,
    reason: visionProgress
      ? 'A non-Chrome app was frontmost and privacy-filtered vision evidence showed task-aligned progress.'
      : interactive
        ? 'A non-Chrome app was frontmost and recent MacBook input was verified.'
        : 'A non-Chrome app was frontmost, but engagement could not yet be verified.',
    evidenceIds: [nativeRow.event_id],
  } as const;
}

export function canonicalizeGuardianSession(sessionId: string, nowMs = Date.now(), observedThroughMs = nowMs) {
  const db = getDb();
  const session = db.prepare(`
    SELECT started_at, evidence_pipeline_mode FROM guardian_sessions WHERE session_id = ?
  `).get(sessionId) as { started_at: number; evidence_pipeline_mode: GuardianEvidenceMode } | undefined;
  if (!session || session.evidence_pipeline_mode === 'legacy') return { finalized: 0, provisional: 0 };

  const pipelineMode = session.evidence_pipeline_mode;
  const sessionStart = Number(session.started_at);
  const watermark = nowMs - GUARDIAN_WATERMARK_MS;
  const latestFinalized = db.prepare(`
    SELECT MAX(slice_bucket) FROM guardian_activity_slices
    WHERE session_id = ? AND provisional = 0
  `).pluck().get(sessionId) as string | null;
  const earliestProvisional = db.prepare(`
    SELECT MIN(slice_bucket) FROM guardian_activity_slices
    WHERE session_id = ? AND provisional = 1
  `).pluck().get(sessionId) as string | null;
  let cursor = earliestProvisional
    ? Date.parse(earliestProvisional)
    : latestFinalized
      ? Date.parse(latestFinalized) + GUARDIAN_SLICE_MS
      : Math.floor(sessionStart / GUARDIAN_SLICE_MS) * GUARDIAN_SLICE_MS;
  cursor = Number.isFinite(cursor)
    ? cursor
    : Math.floor(sessionStart / GUARDIAN_SLICE_MS) * GUARDIAN_SLICE_MS;

  const selectEvidence = db.prepare(`
    SELECT event_id, collector, observed_start, observed_end, privacy_decision, payload_json
    FROM guardian_evidence_events
    WHERE session_id = ? AND compatible = 1
      AND observed_start < ? AND observed_end > ?
    ORDER BY observed_end DESC
  `);
  const upsert = db.prepare(`
    INSERT INTO guardian_activity_slices (
      slice_id, session_id, slice_bucket, slice_start, slice_end, duration_seconds,
      source, state, app, window_title, url, domain, title, category, subcategory,
      engagement_state, engagement_confidence, score_eligible, counted,
      selection_reason, evidence_ids_json, provisional, finalized_at, pipeline_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, slice_bucket) DO UPDATE SET
      slice_end = excluded.slice_end,
      duration_seconds = excluded.duration_seconds,
      source = excluded.source,
      state = excluded.state,
      app = excluded.app,
      window_title = excluded.window_title,
      url = excluded.url,
      domain = excluded.domain,
      title = excluded.title,
      category = excluded.category,
      subcategory = excluded.subcategory,
      engagement_state = excluded.engagement_state,
      engagement_confidence = excluded.engagement_confidence,
      score_eligible = excluded.score_eligible,
      counted = excluded.counted,
      selection_reason = excluded.selection_reason,
      evidence_ids_json = excluded.evidence_ids_json,
      provisional = excluded.provisional,
      finalized_at = excluded.finalized_at,
      pipeline_mode = excluded.pipeline_mode,
      updated_at = datetime('now')
    WHERE guardian_activity_slices.provisional = 1
  `);

  let finalized = 0;
  let provisional = 0;
  db.transaction(() => {
    while (cursor < observedThroughMs) {
      const end = Math.min(cursor + GUARDIAN_SLICE_MS, observedThroughMs);
      const effectiveStart = Math.max(cursor, sessionStart);
      if (end <= effectiveStart) {
        cursor += GUARDIAN_SLICE_MS;
        continue;
      }
      const isFinal = end <= watermark;
      const evidence = selectEvidence.all(
        sessionId,
        new Date(end).toISOString(),
        new Date(effectiveStart).toISOString(),
      ) as EvidenceRow[];
      const decision = canonicalDecision(sessionId, effectiveStart, end, evidence);
      const sliceBucket = new Date(cursor).toISOString();
      const sliceStart = new Date(effectiveStart).toISOString();
      const sliceEnd = new Date(end).toISOString();
      const sliceId = createHash('sha256').update(`${sessionId}:${sliceBucket}`).digest('hex').slice(0, 32);
      const counted = pipelineMode === 'authoritative' && decision.counted ? 1 : 0;
      upsert.run(
        sliceId, sessionId, sliceBucket, sliceStart, sliceEnd, (end - effectiveStart) / 1_000,
        decision.source, decision.state, decision.app, decision.windowTitle,
        decision.url, decision.domain, decision.title, decision.category, decision.subcategory,
        decision.engagementState, decision.engagementConfidence,
        decision.scoreEligible ? 1 : 0, counted,
        decision.reason, JSON.stringify(decision.evidenceIds),
        isFinal ? 0 : 1, isFinal ? new Date(nowMs).toISOString() : null, pipelineMode,
      );
      if (isFinal) finalized += 1;
      else provisional += 1;
      cursor += GUARDIAN_SLICE_MS;
    }
  })();
  return { finalized, provisional };
}

export async function finalizeGuardianEvidenceSession(sessionId: string, timeoutMs = GUARDIAN_WATERMARK_MS) {
  if (getSessionEvidenceMode(sessionId) === 'legacy') return getEvidenceCoverage(sessionId);
  const existingEvidence = Number(getDb().prepare(`
    SELECT COUNT(*) FROM guardian_evidence_events WHERE session_id = ?
  `).pluck().get(sessionId));
  if (existingEvidence === 0) return getEvidenceCoverage(sessionId);
  const requestedAt = Date.now();
  const deadline = requestedAt + timeoutMs;
  let latestNative: string | null = null;
  while (Date.now() < deadline) {
    latestNative = getDb().prepare(`
      SELECT MAX(observed_end) FROM guardian_evidence_events
      WHERE session_id = ? AND collector = 'native' AND compatible = 1
    `).pluck().get(sessionId) as string | null;
    if (latestNative && Date.parse(latestNative) >= requestedAt) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const hasFreshNativeFlush = Boolean(latestNative && Date.parse(latestNative) >= requestedAt);
  const through = hasFreshNativeFlush ? Date.parse(latestNative!) : Date.now();
  canonicalizeGuardianSession(sessionId, through + GUARDIAN_WATERMARK_MS, through);
  return getEvidenceCoverage(sessionId);
}

function updateCollectorLiveness(event: GuardianEvidenceV2) {
  if (event.collector === 'native' && event.native) {
    recordNativeClientHeartbeat({
      deviceId: event.deviceId,
      clientVersion: event.collectorVersion,
      screenRecordingStatus: event.native.screenRecordingStatus,
      captureCapable: event.native.captureCapable,
      frontmostApp: event.native.frontmostApp,
      frontmostWindowTitle: event.native.windowTitle,
      systemState: event.native.systemState,
      activeSessionId: event.sessionId,
      metadata: { inputIdleSeconds: event.native.inputIdleSeconds, evidenceSchema: 2 },
      observedAt: event.observedEnd,
    });
  } else if (event.collector === 'chrome' && event.chrome) {
    recordBrowserCollectorHeartbeat({
      deviceId: event.deviceId,
      sessionId: event.sessionId,
      windowFocused: event.chrome.windowFocused,
      collectorVersion: event.collectorVersion,
      mediaPlaybackActive: event.chrome.media.playing && event.chrome.media.progressed,
      mediaTitle: event.chrome.media.title,
      observedAt: event.observedEnd,
    });
  }
}

export function ingestGuardianEvidence(inputs: unknown[], nowMs = Date.now()): GuardianEvidenceIngestResult {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO guardian_evidence_events (
      event_id, schema_version, sequence_number, collector, collector_version,
      device_id, session_id, observed_start, observed_end, duration_seconds,
      privacy_decision, privacy_reason, compatible, capabilities_json,
      payload_json, late_after_watermark
    ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result: GuardianEvidenceIngestResult = {
    accepted: 0, duplicates: 0, rejected: [], incompatible: [], canonicalizedSessions: [],
  };
  const sessions = new Set<string>();

  db.transaction(() => {
    inputs.forEach((input, index) => {
      const validation = validateGuardianEvidenceV2(input);
      if (!validation.ok || !validation.event) {
        result.rejected.push({ index, errors: validation.errors });
        return;
      }
      const event = validation.event;
      const session = db.prepare(`SELECT 1 FROM guardian_sessions WHERE session_id = ?`).get(event.sessionId);
      if (!session) {
        result.rejected.push({ index, errors: ['sessionId'] });
        return;
      }
      const compatible = collectorIsCompatible(event.collector, event.collectorVersion);
      const late = Date.parse(event.observedEnd) <= nowMs - GUARDIAN_WATERMARK_MS;
      const stored = insert.run(
        event.eventId, event.sequence, event.collector, event.collectorVersion,
        event.deviceId, event.sessionId, event.observedStart, event.observedEnd,
        (Date.parse(event.observedEnd) - Date.parse(event.observedStart)) / 1_000,
        event.privacy.decision, event.privacy.reason, compatible ? 1 : 0,
        JSON.stringify(event.capabilities), JSON.stringify(event), late ? 1 : 0,
      );
      if (stored.changes === 0) {
        result.duplicates += 1;
        return;
      }
      result.accepted += 1;
      if (!compatible) result.incompatible.push({ index, collector: event.collector, version: event.collectorVersion });
      updateCollectorLiveness(event);
      sessions.add(event.sessionId);
    });
  })();

  for (const sessionId of sessions) {
    canonicalizeGuardianSession(sessionId, nowMs);
    result.canonicalizedSessions.push(sessionId);
  }
  return result;
}

export function getEvidenceIntervals(
  sessionId: string,
  pipelineMode: 'shadow' | 'authoritative' = 'authoritative',
): CanonicalScoringInterval[] {
  const rows = getDb().prepare(`
    SELECT source, duration_seconds, state, domain, category, score_eligible,
           app, window_title, title, engagement_state, evidence_ids_json
    FROM guardian_activity_slices
    WHERE session_id = ? AND pipeline_mode = ?
      AND provisional = 0 AND (? = 'shadow' OR counted = 1)
    ORDER BY slice_start ASC
  `).all(sessionId, pipelineMode, pipelineMode) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    source: (row.source === 'chrome' ? 'chrome' : row.source === 'idle' ? 'idle' : row.source === 'private' ? 'private' : 'vision') as CanonicalScoringInterval['source'],
    durationSeconds: Number(row.duration_seconds || 0),
    state: String(row.state || 'active'),
    domain: row.domain ? String(row.domain) : null,
    category: (row.category === 'productive' || row.category === 'distraction' ? row.category : 'neutral') as CanonicalScoringInterval['category'],
    scoreEligible: Number(row.score_eligible) === 1,
    evidence: {
      evidenceIds: JSON.parse(String(row.evidence_ids_json || '[]')),
      engagementState: row.engagement_state,
      app: row.app,
      windowTitle: row.window_title,
      title: row.title,
    },
  }));
}

export function getFinalizedEvidenceIntervals(sessionId: string) {
  return getEvidenceIntervals(sessionId, 'authoritative');
}

export function getEvidenceCoverage(sessionId: string) {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN provisional = 0 AND source != 'unverified' THEN duration_seconds ELSE 0 END), 0) AS covered,
      COALESCE(SUM(CASE WHEN provisional = 0 AND score_eligible = 1 THEN duration_seconds ELSE 0 END), 0) AS eligible,
      COALESCE(SUM(CASE WHEN provisional = 0 AND source = 'unverified' THEN duration_seconds ELSE 0 END), 0) AS unverified,
      COALESCE(MAX(canonical_revision), 0) AS revision,
      MAX(CASE WHEN provisional = 0 THEN slice_end END) AS watermark
    FROM guardian_activity_slices WHERE session_id = ?
  `).get(sessionId) as { covered: number; eligible: number; unverified: number; revision: number; watermark: string | null };
  return {
    coveredSeconds: Number(row.covered), eligibleSeconds: Number(row.eligible),
    unverifiedSeconds: Number(row.unverified), canonicalRevision: Number(row.revision),
    watermark: row.watermark,
  };
}

export function recordGuardianScoreSnapshot(
  sessionId: string,
  score: number | null,
  components: Record<string, unknown> = {},
) {
  if (getSessionEvidenceMode(sessionId) !== 'authoritative') return null;
  const coverage = getEvidenceCoverage(sessionId);
  if (!coverage.watermark) return null;
  return getDb().prepare(`
    INSERT INTO guardian_score_snapshots (
      session_id, score, canonical_revision, evidence_watermark,
      eligible_seconds, covered_seconds, unverified_seconds, components_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, score, coverage.canonicalRevision, coverage.watermark,
    coverage.eligibleSeconds, coverage.coveredSeconds, coverage.unverifiedSeconds,
    JSON.stringify(components),
  ).lastInsertRowid;
}
