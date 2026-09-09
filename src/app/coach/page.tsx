'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type EngagementState = 'active' | 'slipping' | 'disengaged' | 'reconnecting' | 'paused';

interface CoachState {
  engagement: EngagementState;
  coverage: 'current' | 'partial' | 'missing';
  coverageSources: {
    activity: 'current' | 'partial' | 'missing';
    screenVision: 'current' | 'partial' | 'missing';
    phone: 'current' | 'partial' | 'missing';
  };
  reason: string;
  evidence: string[];
  missedOpportunities: number;
  overdueTasks: number;
  unansweredOutreach: number;
  daysSinceHumanContact: number | null;
  daysSinceCompletedSession: number | null;
  episode: {
    blockerKind: string | null;
    blockerText: string | null;
    nextActionText: string | null;
    restartMinutes: number;
  } | null;
  restart: { minutes: number; title: string; taskId: number | null };
}

interface CoachDecision {
  id: number;
  actionType: string;
  status: string;
  reason: string;
  message: string | null;
  actualOutcome: string | null;
  createdAt: string;
}

interface SessionPerformance {
  sampleSize: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  averageFocusScore: number | null;
  averageCompletionRatio: number | null;
  completedAsPlannedRate: number | null;
  recommendedMinutes: number | null;
  bestStartHours: number[];
  trend: 'improving' | 'declining' | 'stable' | 'unknown';
  explanation: string;
}

const stateLabels: Record<EngagementState, string> = {
  active: 'Participating',
  slipping: 'Starting to slip',
  disengaged: 'Recovery needed',
  reconnecting: 'Reconnecting',
  paused: 'Coaching paused',
};

const stateColors: Record<EngagementState, string> = {
  active: '#22c55e',
  slipping: '#f59e0b',
  disengaged: '#ef4444',
  reconnecting: '#38bdf8',
  paused: '#94a3b8',
};

export default function CoachPage() {
  const router = useRouter();
  const [state, setState] = useState<CoachState | null>(null);
  const [decisions, setDecisions] = useState<CoachDecision[]>([]);
  const [performance, setPerformance] = useState<SessionPerformance | null>(null);
  const [reply, setReply] = useState('');
  const [coachReply, setCoachReply] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/coaching/state');
    if (response.status === 401) {
      router.replace('/login?returnTo=/coach');
      return;
    }
    if (!response.ok) throw new Error('LifeOS could not load the coaching state.');
    const payload = await response.json();
    setState(payload.state);
    setPerformance(payload.performance);
    setDecisions(payload.decisions || []);
  }, [router]);

  useEffect(() => {
    refresh().catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false));
  }, [refresh]);

  async function act(action: string, body: Record<string, unknown> = {}) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/coaching/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'The coaching action failed.');
      setCoachReply(payload.reply ? payload.reply.replace(/<[^>]+>/g, '') : null);
      setState(payload.state);
      setReply('');
      await refresh();
      return payload.state as CoachState;
    } finally {
      setSaving(false);
    }
  }

  async function beginRestart() {
    if (!state) return;
    const accepted = await act('accept_restart', {
      minutes: state.restart.minutes,
      nextActionText: state.restart.title,
    });
    const response = await fetch('/api/guardian/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: accepted.restart.title,
        durationMinutes: accepted.restart.minutes,
        source: 'dashboard',
        sessionContext: 'Accepted from the active coaching recovery flow.',
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || 'Guardian could not start the restart session.');
    router.push('/guardian');
  }

  if (loading) return <div className="py-20 text-center" style={{ color: 'var(--text-secondary)' }}>Loading coaching state…</div>;
  if (!state) return <div className="card"><p>{error || 'Coaching state is unavailable.'}</p></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6 animate-fade-in">
      <div>
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: stateColors[state.engagement] }}>Active coaching</p>
        <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>{stateLabels[state.engagement]}</h1>
        <p className="mt-2 max-w-3xl" style={{ color: 'var(--text-secondary)' }}>{state.reason}</p>
      </div>

      {error && <div className="card" style={{ borderColor: '#ef4444', color: '#ef4444' }}>{error}</div>}

      <section className="card space-y-5" style={{ borderColor: stateColors[state.engagement] }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>What LifeOS is acting on</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Device evidence: {state.coverage}. Missing evidence is never counted as inactivity.</p>
          </div>
          <span className="rounded-full px-3 py-1 text-sm font-semibold" style={{ color: stateColors[state.engagement], background: `${stateColors[state.engagement]}18` }}>
            {stateLabels[state.engagement]}
          </span>
        </div>

        {state.evidence.length > 0 ? (
          <ul className="space-y-2">
            {state.evidence.map(item => <li key={item} className="text-sm" style={{ color: 'var(--text-secondary)' }}>• {item}</li>)}
          </ul>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>No recovery evidence is currently active.</p>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          {Object.entries(state.coverageSources).map(([source, coverage]) => (
            <div key={source} className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--border)' }}>
              <span className="capitalize" style={{ color: 'var(--text-secondary)' }}>{source.replace(/([A-Z])/g, ' $1')}</span>
              <span className="float-right font-medium" style={{ color: coverage === 'current' ? '#22c55e' : coverage === 'partial' ? '#f59e0b' : 'var(--text-muted)' }}>{coverage}</span>
            </div>
          ))}
        </div>

        {(state.engagement === 'disengaged' || state.engagement === 'reconnecting' || state.engagement === 'slipping') && (
          <div className="space-y-3 border-t pt-5" style={{ borderColor: 'var(--border)' }}>
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Resolve what is blocking the next session</h3>
            {state.episode?.blockerText && <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Recorded context: “{state.episode.blockerText}”</p>}
            <label htmlFor="recovery-context" className="sr-only">What is blocking the restart?</label>
            <textarea
              id="recovery-context"
              value={reply}
              onChange={event => setReply(event.target.value)}
              rows={3}
              placeholder="What is actually blocking the restart?"
              className="w-full rounded-xl border bg-transparent p-3 outline-none"
              style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={saving || !reply.trim()}
                onClick={() => act(state.episode?.blockerText ? 'correct' : 'reply', { text: reply })}
                className="btn btn-ghost"
              >
                {state.episode?.blockerText ? 'Correct recorded context' : 'Explain what happened'}
              </button>
              <button type="button" disabled={saving} onClick={() => beginRestart().catch(error => setError(error instanceof Error ? error.message : String(error)))} className="btn btn-primary">
                Start {state.restart.minutes}-minute reset
              </button>
            </div>
            {coachReply && <p className="rounded-xl p-3 text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{coachReply}</p>}
          </div>
        )}

        <div className="flex gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          {state.engagement === 'paused'
            ? <button type="button" disabled={saving} onClick={() => act('resume')} className="btn btn-primary">Resume coaching</button>
            : <button type="button" disabled={saving} onClick={() => act('pause')} className="btn btn-ghost">Pause coaching</button>}
        </div>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>What sessions are teaching LifeOS</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            These values change session length and timing only when repeated outcomes support the change.
          </p>
        </div>
        {performance ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Observed sessions" value={String(performance.sampleSize)} />
              <Metric label="Planned time completed" value={performance.averageCompletionRatio === null ? 'Learning' : `${Math.round(performance.averageCompletionRatio * 100)}%`} />
              <Metric label="Average focus" value={performance.averageFocusScore === null ? 'Learning' : String(performance.averageFocusScore)} />
              <Metric label="Current session policy" value={performance.recommendedMinutes === null ? '45m cold start' : `${performance.recommendedMinutes}m`} />
            </div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{performance.explanation}.</p>
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Confidence: {performance.confidence} · Outcome trend: {performance.trend}
            </p>
          </>
        ) : <p style={{ color: 'var(--text-secondary)' }}>Session learning is unavailable.</p>}
      </section>

      <section className="card">
        <h2 className="mb-4 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Recent coaching decisions</h2>
        {decisions.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No coaching decisions have been recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {decisions.map(decision => (
              <div key={decision.id} className="border-b pb-3 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap justify-between gap-2">
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{decision.actionType.replaceAll('_', ' ')}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{new Date(decision.createdAt).toLocaleString()}</p>
                </div>
                <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{decision.reason}</p>
                <p className="mt-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{decision.status}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="mt-1 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{value}</p>
    </div>
  );
}
