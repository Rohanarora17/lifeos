'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClientRequestId } from '@/lib/polyfill-crypto-uuid';
import { studyDuration } from '@/lib/endsem-contract';
import type { StudyChatState } from '@/lib/study-chat-contract';
import styles from './StudyChat.module.css';

type Submission = { action: 'message'; message: string; requestId: string; revision: number; date: string };
const DRAFT_KEY = 'lifeos.study-chat.draft.v1';
const RETRY_KEY = 'lifeos.study-chat.retry.v1';
function time(at: string) {
  return new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
}

export default function StudyChat() {
  const [state, setState] = useState<StudyChatState | null>(null);
  const [draft, setDraft] = useState('');
  const [retry, setRetry] = useState<Submission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const version = useRef(0);
  const sending = useRef(false);
  const mounted = useRef(true);
  const conversation = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const requestVersion = ++version.current;
    try {
      const response = await fetch('/api/study-chat', { cache: 'no-store' });
      if (!response.ok) throw new Error('Study chat is unavailable. Your draft stays here.');
      const next = await response.json() as StudyChatState;
      if (mounted.current && requestVersion === version.current && !sending.current) {
        setState(next); setConnectionError('');
      }
    } catch (failure) {
      if (mounted.current && requestVersion === version.current) setConnectionError(failure instanceof Error ? failure.message : 'Could not connect.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    try {
      setDraft(localStorage.getItem(DRAFT_KEY) || '');
      const pending = JSON.parse(localStorage.getItem(RETRY_KEY) || 'null') as Submission | null;
      if (pending?.action === 'message' && typeof pending.message === 'string' && typeof pending.requestId === 'string' && Number.isInteger(pending.revision) && typeof pending.date === 'string') {
        setRetry(pending); setDraft(pending.message); setError('The last message has no confirmed response. Retry it to check whether it was saved.');
      }
    } catch { /* Storage may be unavailable in a private browser. */ }
    setLoaded(true);
    void refresh();
    const timer = setInterval(() => { if (!sending.current) void refresh(); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(DRAFT_KEY, draft); } catch { /* Keep the in-memory draft. */ }
  }, [draft, loaded]);
  useEffect(() => {
    const element = conversation.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [state?.messages.length]);

  function saveRetry(pending: Submission | null) {
    setRetry(pending);
    try { if (pending) localStorage.setItem(RETRY_KEY, JSON.stringify(pending)); else localStorage.removeItem(RETRY_KEY); } catch { /* In-memory retry remains safe. */ }
  }
  async function send() {
    if (!state?.enabled || sending.current || (!retry && !draft.trim())) return;
    const submission = retry || { action: 'message' as const, message: draft.trim(), requestId: createClientRequestId(), revision: state.revision, date: state.date };
    sending.current = true; setBusy(true); setError(''); ++version.current;
    saveRetry(submission);
    try {
      const response = await fetch('/api/study-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission) });
      const data = await response.json();
      if (!mounted.current) return;
      ++version.current;
      if (!response.ok) {
        if (data.state) setState(data.state as StudyChatState);
        if (response.status === 409) {
          saveRetry(null);
          setError('The agreement changed on another screen. Review the latest conversation, then send your message again.');
        } else if (response.status >= 400 && response.status < 500) {
          saveRetry(null); setError(data.error || 'Please revise the message. It was not saved.');
        } else setError(data.error || 'No confirmed response. Retry this message; it will not apply twice.');
        return;
      }
      setState(data as StudyChatState); setDraft(''); saveRetry(null); setConnectionError('');
    } catch {
      if (mounted.current) setError('No confirmed response. Your message is kept for retry; LifeOS has not confirmed the change.');
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const plan = state?.plan;
  return <section className={styles.panel} aria-label="Study conversation">
    <div className={styles.heading}>
      <div><h2>Study check-in</h2><p>Tell me where you’re going, when you’ll return, or what’s stopping you.</p></div>
      {state && <span className={styles.remaining}>{studyDuration(state.remainingSeconds)} left / 8h</span>}
    </div>
    {state?.window && <p className={styles.agreement}>Eight-hour window ends {new Date(state.window.endsAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} IST · no midnight reset</p>}
    {state?.activity && <p className={styles.agreement}>{state.activity.title}{state.activity.expectedReturnAt ? ` · return ${time(state.activity.expectedReturnAt)} IST` : ' · return time needed'}</p>}
    <div ref={conversation} className={styles.messages} role="log" aria-label="Saved study messages" aria-live="polite">
      {!state ? <p>{connectionError || 'Loading your saved conversation…'}</p> : !state.messages.length ? <p className={styles.empty}>Start with “I’m ready to study” or “I’m going for lunch.” I’ll ask for missing timings and help fit the remaining study around your day.</p> : state.messages.map(message => <div key={message.id} className={message.role === 'user' ? styles.user : styles.assistant}>
        <span className={styles.speaker}>{message.role === 'user' ? 'You' : 'LifeOS'}</span>
        <p>{message.text}</p>
      </div>)}
    </div>
    {state?.pendingPrompt && <p className={styles.prompt} role="status">{state.pendingPrompt.text}</p>}
    {plan && <details className={styles.plan}>
      <summary>{plan.needsInput ? 'Remaining plan · needs your input' : `Remaining plan · ${plan.scheduledMinutes} min scheduled`}</summary>
      {plan.needsInput && <p>{plan.needsInput}</p>}
      {plan.warning && <p>{plan.warning}</p>}
      {plan.anticipatedClassMinutes > 0 && <p>{plan.anticipatedClassMinutes} min in upcoming relevant classes. Attendance must be confirmed before it earns credit.</p>}
      {plan.sessions.length > 0 && <ol>{plan.sessions.map(session => <li key={session.id}>{time(session.start)}–{time(session.end)} · {session.title} · {session.durationMinutes} min</li>)}</ol>}
    </details>}
    <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
      <label htmlFor="study-chat-message">Message LifeOS</label>
      <textarea id="study-chat-message" placeholder="e.g. Going for lunch, back in 40 minutes" value={draft} maxLength={2000} disabled={busy || !!retry || (!!state && !state.enabled)} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className={styles.actions}><span>{state && !state.enabled ? 'Campaign inactive · history remains available' : 'Enter to send · Shift+Enter for a new line'}</span><button className="btn btn-primary" disabled={busy || !state?.enabled || (!retry && !draft.trim())}>{busy ? 'Saving…' : retry ? 'Retry message' : 'Send'}</button></div>
    </form>
    {(error || connectionError) && <div className={styles.error} role="alert"><p>{error || connectionError}</p>{connectionError && <button className="btn btn-ghost" onClick={() => void refresh()}>Reconnect</button>}{retry && !busy && <button className="btn btn-ghost" onClick={() => { saveRetry(null); setError('Previous delivery remains unconfirmed. Review the conversation before sending a different message.'); void refresh(); }}>Edit after reviewing</button>}</div>}
    <p className={styles.footnote}>Same conversation as the Mac menu’s Study Chat. Meals and breaks earn no study time.</p>
  </section>;
}
