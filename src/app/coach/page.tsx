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
  commitmentId: number | null;
  actionType: string;
  variant: string | null;
  contextKey: string | null;
  status: string;
  reason: string;
  message: string | null;
  actualOutcome: string | null;
  outcomeScore: number | null;
  evaluatedAt: string | null;
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

interface CoachingCommitment {
  id: number;
  title: string;
  plannedStartAt: string;
  plannedMinutes: number;
  state: 'scheduled' | 'due' | 'missed' | 'started' | 'completed' | 'abandoned' | 'rescheduled' | 'cancelled';
  blockerKind: string | null;
  blockerText: string | null;
  outcomeReason: string | null;
}

interface InterventionLearning {
  totalEvaluated: number;
  variants: Array<{
    variant: 'direct_start' | 'tiny_start' | 'choice';
    evaluated: number;
    completed: number;
    started: number;
    averageOutcome: number | null;
  }>;
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
  const [commitment, setCommitment] = useState<CoachingCommitment | null>(null);
  const [interventionLearning, setInterventionLearning] = useState<InterventionLearning | null>(null);
  const [reply, setReply] = useState('');
  const [commitmentBlocker, setCommitmentBlocker] = useState('');
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
    setCommitment(payload.currentCommitment || null);
    setInterventionLearning(payload.interventionLearning || null);
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
      if (payload.state) setState(payload.state);
      setReply('');
      await refresh();
      return payload;
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
        topic: accepted.state.restart.title,
        durationMinutes: accepted.state.restart.minutes,
        source: 'dashboard',
        sessionContext: 'Accepted from the active coaching recovery flow.',
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || 'Guardian could not start the restart session.');
    router.push('/guardian');
  }

  async function startCommitment() {
    if (!commitment) return;
    const accepted = await act('commit_start', { commitmentId: commitment.id });
    const response = await fetch('/api/guardian/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: accepted.startPlan.commitment.title,
        durationMinutes: accepted.startPlan.minutes,
        source: 'dashboard',
        sessionContext: `Started from coaching commitment ${commitment.id}.`,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || 'Guardian could not start this commitment.');
    router.push('/guardian');
  }

  async function rescheduleCurrentCommitment() {
    if (!commitment) return;
    await act('commit_reschedule', { commitmentId: commitment.id, delayMinutes: 30 });
    setCoachReply('Commitment moved by 30 minutes. LifeOS will evaluate the new start time.');
  }

  async function saveCommitmentBlocker() {
    if (!commitment || !commitmentBlocker.trim()) return;
    await act('commit_blocked', { commitmentId: commitment.id, text: commitmentBlocker });
    setCommitmentBlocker('');
    setCoachReply('Blocker attached to this commitment and its intervention outcome.');
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

      <section className="card space-y-4" style={{ borderColor: commitment?.state === 'missed' ? '#ef4444' : 'var(--border)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Current commitment</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>One planned start, one response, and one measured outcome.</p>
          </div>
          {commitment && (
            <span className="rounded-full px-3 py-1 text-sm font-semibold capitalize" style={{ background: 'var(--bg-secondary)', color: commitment.state === 'missed' ? '#ef4444' : 'var(--text-secondary)' }}>
              {commitment.state}
            </span>
          )}
        </div>
        {commitment ? (
          <>
            <div>
              <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{commitment.title}</p>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {new Date(commitment.plannedStartAt).toLocaleString()} · {commitment.plannedMinutes} minutes
              </p>
              {commitment.blockerText && <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>Recorded blocker: “{commitment.blockerText}”</p>}
              {commitment.outcomeReason && <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{commitment.outcomeReason}</p>}
            </div>
            {commitment.state === 'started' ? (
              <button type="button" onClick={() => router.push('/guardian')} className="btn btn-primary">Open active session</button>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  <button type="button" disabled={saving} onClick={() => startCommitment().catch(error => setError(error instanceof Error ? error.message : String(error)))} className="btn btn-primary">
                    Start now
                  </button>
                  <button type="button" disabled={saving} onClick={() => rescheduleCurrentCommitment().catch(error => setError(error instanceof Error ? error.message : String(error)))} className="btn btn-ghost">
                    Move 30 minutes
                  </button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label htmlFor="commitment-blocker" className="sr-only">Why did this commitment not start?</label>
                  <input
                    id="commitment-blocker"
                    value={commitmentBlocker}
                    onChange={event => setCommitmentBlocker(event.target.value)}
                    placeholder="What stopped the start?"
                    className="min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 outline-none"
                    style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  />
                  <button type="button" disabled={saving || !commitmentBlocker.trim()} onClick={() => saveCommitmentBlocker().catch(error => setError(error instanceof Error ? error.message : String(error)))} className="btn btn-ghost">
                    Record blocker
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p style={{ color: 'var(--text-secondary)' }}>No active commitment. The next planned focus session will appear here.</p>
        )}
      </section>

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

      <section className="card space-y-4">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Which interventions work</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>LifeOS compares actual starts and completed sessions after each missed-start response.</p>
        </div>
        {!interventionLearning || interventionLearning.totalEvaluated === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>Collecting evidence. Policy changes begin after measured outcomes, so a reply alone is not counted as success.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {interventionLearning.variants.map(item => (
              <div key={item.variant} className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                <p className="font-semibold capitalize" style={{ color: 'var(--text-primary)' }}>{item.variant.replaceAll('_', ' ')}</p>
                <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{item.completed}/{item.evaluated} completed · {item.started} started</p>
                <p className="mt-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Outcome {item.averageOutcome === null ? 'learning' : `${Math.round(item.averageOutcome * 100)}%`}
                </p>
              </div>
            ))}
          </div>
        )}
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
                <p className="mt-1 text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  {decision.status}
                  {decision.variant ? ` · ${decision.variant.replaceAll('_', ' ')}` : ''}
                  {decision.outcomeScore !== null ? ` · outcome ${Math.round(decision.outcomeScore * 100)}%` : ''}
                </p>
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
