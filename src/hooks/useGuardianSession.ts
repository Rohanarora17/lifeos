'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClientRequestId } from '@/lib/polyfill-crypto-uuid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawSession {
  sessionId: string;
  targetTitle: string | null;
  durationMinutes: number;
  state: string;
  startedAt?: number;
  focusScoreHistory?: number[];
  pauseReason?: 'client_unavailable' | 'presence_unconfirmed' | 'manual' | null;
  pausedAt?: number | null;
  totalPausedMs?: number;
}

export interface GuardianAdaptiveDefaults {
  recommendedSessionMinutes: number;
}

export interface SessionView {
  /** True when a guardian session is active */
  active: boolean;
  sessionId: string | null;
  targetTitle: string | null;
  durationMinutes: number;
  startedAt: number | null;
  /** Updates every second when active */
  timeLeftSeconds: number;
  elapsedSeconds: number;
  /** 0–100 */
  progressPct: number;
  /** Latest focus score, or null if no history */
  focusScore: number | null;
  paused: boolean;
  pauseReason: 'client_unavailable' | 'presence_unconfirmed' | 'manual' | null;
}

export interface StartOptions {
  goalId?: string | null;
  goalTitle?: string | null;
  conceptNodeName?: string | null;
  durationMinutes?: number;
  mood?: 'high' | 'medium' | 'low' | null;
  source?: 'dashboard' | 'extension' | 'voice' | 'api';
  sessionContext?: string;
}

export interface GuardianClientReadiness {
  ready: boolean;
  reason: string;
  lastSeenAt: string | null;
  screenRecordingStatus: string;
  frontmostApp: string | null;
  wakeSupported: boolean;
}

// ─── Derived view ─────────────────────────────────────────────────────────────

const INITIAL_DEFAULT_SESSION_MINUTES = 45;

function normalizeDurationMinutes(value: unknown, fallback: number): number {
  const minutes = Number(value);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.max(5, Math.min(240, Math.round(minutes)));
  }
  return fallback;
}

function idleView(defaultDurationMinutes: number): SessionView {
  return {
    active: false, sessionId: null, targetTitle: null,
    durationMinutes: defaultDurationMinutes, startedAt: null,
    timeLeftSeconds: 0, elapsedSeconds: 0, progressPct: 0, focusScore: null,
    paused: false, pauseReason: null,
  };
}

function derive(raw: RawSession | null, now: number, defaultDurationMinutes: number): SessionView {
  if (!raw) return idleView(defaultDurationMinutes);
  const startedAt = raw.startedAt ?? now;
  const durationMinutes = normalizeDurationMinutes(raw.durationMinutes, defaultDurationMinutes);
  const durationMs = durationMinutes * 60_000;
  const paused = raw.state === 'BREAK';
  const currentPauseMs = paused && raw.pausedAt ? Math.max(0, now - raw.pausedAt) : 0;
  const elapsedMs = Math.max(0, now - startedAt - (raw.totalPausedMs ?? 0) - currentPauseMs);
  const timeLeftMs = Math.max(0, durationMs - elapsedMs);
  return {
    active: true,
    sessionId: raw.sessionId,
    targetTitle: raw.targetTitle || 'Focus Session',
    durationMinutes,
    startedAt,
    timeLeftSeconds: Math.round(timeLeftMs / 1000),
    elapsedSeconds: Math.round(elapsedMs / 1000),
    progressPct: Math.min(100, Math.round((elapsedMs / durationMs) * 100)),
    focusScore: raw.focusScoreHistory?.length
      ? raw.focusScoreHistory[raw.focusScoreHistory.length - 1]
      : null,
    paused,
    pauseReason: raw.pauseReason ?? null,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for guardian session state across all web surfaces.
 *
 * - Polls `/api/guardian/state` every 5 s (picks up sessions started from
 *   Telegram, extension popup, or any other surface).
 * - Returns a live `SessionView` with `timeLeftSeconds` / `progressPct`
 *   that updates every second while a session is active.
 * - `start()` and `end()` are the only way to mutate session state.
 *   Both update local state immediately and let the next poll confirm.
 */
export function useGuardianSession() {
  const [raw, setRaw] = useState<RawSession | null>(null);
  const [adaptiveDefaults, setAdaptiveDefaults] = useState<GuardianAdaptiveDefaults>({
    recommendedSessionMinutes: INITIAL_DEFAULT_SESSION_MINUTES,
  });
  const [tick, setTick] = useState(() => Date.now());
  const [startError, setStartError] = useState<string | null>(null);
  const [clientReadiness, setClientReadiness] = useState<GuardianClientReadiness | null>(null);
  const rawRef = useRef<RawSession | null>(null);
  const pendingStartRequestIdRef = useRef<string | null>(null);

  // ── Poll server every 5 s ────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/guardian/state');
        if (!res.ok || !mounted) return;
        const data = await res.json() as {
          activeSession?: RawSession;
          pendingSpeech?: string | null;
          adaptiveDefaults?: Partial<GuardianAdaptiveDefaults>;
        };
        const recommendedSessionMinutes = normalizeDurationMinutes(
          data.adaptiveDefaults?.recommendedSessionMinutes,
          adaptiveDefaults.recommendedSessionMinutes,
        );
        setAdaptiveDefaults(prev =>
          prev.recommendedSessionMinutes === recommendedSessionMinutes
            ? prev
            : { recommendedSessionMinutes }
        );
        const next = data.activeSession?.state === 'ACTIVE' || data.activeSession?.state === 'BREAK'
          ? data.activeSession
          : null;
        setRaw(next);
        rawRef.current = next;
        if (data.pendingSpeech && typeof window !== 'undefined' && 'speechSynthesis' in window) {
          const utter = new SpeechSynthesisUtterance(data.pendingSpeech);
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utter);
        }
      } catch { /* network offline — keep last known state */ }
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [adaptiveDefaults.recommendedSessionMinutes]);

  // ── 1-second tick while session is active (drives timeLeftSeconds) ───────
  const isActive = !!raw;
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isActive]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const fetchReadiness = useCallback(async () => {
    const response = await fetch('/api/guardian/client-readiness', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not check MacBook vision client status.');
    const readiness = await response.json() as GuardianClientReadiness;
    setClientReadiness(readiness);
    return readiness;
  }, []);

  const ensureClientReady = useCallback(async () => {
    let readiness = await fetchReadiness();
    if (readiness.ready) return readiness;

    const requestId = createClientRequestId();
    window.postMessage({ type: 'LIFEOS_WAKE_COPILOT', requestId }, '*');
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'LIFEOS_WAKE_COPILOT', requestId }, '*');
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      readiness = await fetchReadiness();
      if (readiness.ready) return readiness;
    }
    throw new Error(
      readiness.screenRecordingStatus !== 'authorized'
        ? 'MacBook vision client needs Screen Recording permission before this session can start.'
        : 'MacBook vision client did not start. Open LifeOSCopilot on the MacBook, then retry.',
    );
  }, [fetchReadiness]);

  const start = useCallback(async (opts: StartOptions): Promise<string | null> => {
    setStartError(null);
    try {
      await ensureClientReady();
      const startRequestId = pendingStartRequestIdRef.current ?? createClientRequestId();
      pendingStartRequestIdRef.current = startRequestId;
      const res = await fetch('/api/guardian/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'dashboard', ...opts, startRequestId }),
      });
      const data = await res.json() as { session?: RawSession; error?: string; message?: string };
      if (data.session) {
        setRaw(data.session);
        rawRef.current = data.session;
        pendingStartRequestIdRef.current = null;
        return data.session.sessionId;
      }
      setStartError(data.message || data.error || 'Guardian session could not start.');
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Guardian session could not start.');
    }
    return null;
  }, [ensureClientReady]);

  const end = useCallback(async () => {
    const sessionId = rawRef.current?.sessionId;
    setRaw(null);
    rawRef.current = null;
    if (sessionId) {
      fetch('/api/guardian/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => { });
    }
  }, []);

  return {
    session: derive(raw, tick, adaptiveDefaults.recommendedSessionMinutes),
    adaptiveDefaults,
    startError,
    clientReadiness,
    start,
    end,
  };
}
