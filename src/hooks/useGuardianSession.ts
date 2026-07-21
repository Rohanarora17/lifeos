'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawSession {
  sessionId: string;
  targetTitle: string | null;
  durationMinutes: number;
  state: string;
  startedAt?: number;
  focusScoreHistory?: number[];
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
  };
}

function derive(raw: RawSession | null, now: number, defaultDurationMinutes: number): SessionView {
  if (!raw) return idleView(defaultDurationMinutes);
  const startedAt = raw.startedAt ?? now;
  const durationMinutes = normalizeDurationMinutes(raw.durationMinutes, defaultDurationMinutes);
  const durationMs = durationMinutes * 60_000;
  const elapsedMs = Math.max(0, now - startedAt);
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
  const rawRef = useRef<RawSession | null>(null);

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
        const next = data.activeSession?.state === 'ACTIVE' ? data.activeSession : null;
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

  const start = useCallback(async (opts: StartOptions): Promise<string | null> => {
    try {
      const res = await fetch('/api/guardian/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'dashboard', ...opts }),
      });
      const data = await res.json() as { session?: RawSession };
      if (data.session) {
        setRaw(data.session);
        rawRef.current = data.session;
        return data.session.sessionId;
      }
    } catch { }
    return null;
  }, []);

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
    start,
    end,
  };
}
