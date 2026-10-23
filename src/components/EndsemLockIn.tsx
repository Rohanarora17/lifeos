'use client';

import Link from 'next/link';
import styles from './EndsemLockIn.module.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGuardianSession } from '@/hooks/useGuardianSession';
import { createClientRequestId } from '@/lib/polyfill-crypto-uuid';
import { STUDY_SUBJECT_LABELS, studyDuration, type EndsemState, type StudySubject } from '@/lib/endsem-contract';
import StudyChat from './StudyChat';

function dateLabel(date: string) {
  return new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short'});
}
function nextDay(date: string) {
  return new Date(Date.parse(`${date}T12:00:00Z`)+86_400_000).toISOString().slice(0,10);
}

export default function EndsemLockIn({expanded = false}: {expanded?: boolean}) {
  const [state,setState] = useState<EndsemState | null>(null);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [subject,setSubject] = useState<StudySubject | ''>('');
  const [topic,setTopic] = useState('');
  const [blocker,setBlocker] = useState('');
  const [paperDate,setPaperDate] = useState(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  const [paperStart,setPaperStart] = useState('');
  const [paperEnd,setPaperEnd] = useState('');
  const [paperNotes,setPaperNotes] = useState('');
  const [reflection,setReflection] = useState('');
  const [firstStart,setFirstStart] = useState('08:00');
  const [hours,setHours] = useState<number[] | null>(null);
  const paperRequestId = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const {session,start,startError} = useGuardianSession();
  const refresh = useCallback(async()=>{
    const version = ++requestVersion.current;
    try {
      const response = await fetch('/api/endsem',{cache:'no-store'});
      if (!response.ok) throw new Error('Could not load the study counter.');
      const data = await response.json() as EndsemState;
      if (mounted.current && version===requestVersion.current) {setState(data);setError('');}
    } catch (failure) {
      if (mounted.current && version===requestVersion.current) setError(failure instanceof Error?failure.message:'Study counter unavailable.');
    }
  },[]);
  useEffect(()=>{
    mounted.current=true;
    void refresh();
    const timer=setInterval(()=>void refresh(),15_000);
    return ()=>{mounted.current=false;clearInterval(timer);};
  },[refresh]);

  async function action(input: Record<string,unknown>, success: string) {
    if (busy) return false;
    setBusy(true);setError('');setNotice('');
    // An older poll must not overwrite this mutation with an older snapshot.
    ++requestVersion.current;
    try {
      const response=await fetch('/api/endsem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save study action.');
      ++requestVersion.current;
      setState(data as EndsemState);setNotice(success);return true;
    } catch(failure) {setError(failure instanceof Error?failure.message:'Could not save study action.');return false;}
    finally {setBusy(false);}
  }
  async function startBlock() {
    if (!state || busy || session.active) return;
    setBusy(true);setError('');setNotice('');
    const chosen=subject || state.nextSubject;
    // Guardian resolves conceptNodeName before topic. Use the complete explicit
    // subject title so all entry points persist an unambiguous study label.
    const title=`${STUDY_SUBJECT_LABELS[chosen]} — ${topic.trim() || 'Endsem study'}`;
    const id=await start({conceptNodeName:title,durationMinutes:Math.max(5,Math.min(50,Math.ceil(state.today.remainingSeconds/60))),source:'dashboard',sessionContext:'Endsem Lock-In: eight hours daily through 13 November 2026. Probability exam 10 November; ADSA exam 13 November. Count only actual on-topic study.'});
    if(id) {setNotice('Session started. Only measured study adds to the counter.');await refresh();}
    setBusy(false);
  }
  async function logPaper(event: React.FormEvent) {
    event.preventDefault();
    if(!state) return;
    paperRequestId.current ||= createClientRequestId();
    const ok=await action({action:'paper',requestId:paperRequestId.current,subject:subject || state.nextSubject,startedAt:`${paperDate}T${paperStart}:00+05:30`,endedAt:`${paperEnd<=paperStart?nextDay(paperDate):paperDate}T${paperEnd}:00+05:30`,notes:paperNotes},'Paper study saved as self-reported. Overlapping time counts once.');
    if(ok) {setPaperNotes('');setPaperStart('');setPaperEnd('');paperRequestId.current=null;}
  }
  const resetPaperRequest = ()=>{paperRequestId.current=null;};

  if(!state) return <section className="card mb-6" aria-label="Endsem Lock-In"><p>{error || 'Loading Endsem Lock-In…'}</p>{error && <button className="btn btn-ghost mt-2" onClick={()=>void refresh()}>Retry study counter</button>}</section>;
  if(state.phase==='finished' && !expanded) return null;
  const today=state.today, active=state.phase==='active';
  const selected=subject || state.nextSubject;
  const color=today.status==='complete'?'#22c55e':today.status==='behind'?'#fb7185':'#a5b4fc';
  const snoozed=!!today.delayUntil && Date.parse(today.delayUntil)>Date.now();
  const actionable=active && !state.paused;
  const completed=state.days.filter(day=>day.status==='complete').length;
  return (
    <section className={`${styles.panel} card mb-6 space-y-4`} style={{borderColor:color,background:'linear-gradient(120deg, rgba(99,102,241,.09), var(--bg-card))'}} aria-label="Endsem Lock-In">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{color}}>Endsem Lock-In · 22 Oct–13 Nov 2026</p>
          <h2 className="mt-1 text-xl font-bold">{state.phase==='setup'?'Your eight-hour commitment starts 22 October':state.phase==='finished'?'Campaign complete — review the actual results':today.status==='complete'?`Eight hours reached ${state.window?'this window':'today'}`:state.paused?'Accountability prompts paused':`${studyDuration(today.remainingSeconds)} left. Lock in.`}</h2>
          <p className="mt-1 text-sm" style={{color:'var(--text-secondary)'}}>Probability · <strong>10 Nov</strong> &nbsp; / &nbsp; ADSA · <strong>13 Nov</strong> &nbsp; · &nbsp; {dateLabel(state.date)} · IST</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums" data-testid="endsem-total">{studyDuration(today.totalSeconds)} <span className="text-sm font-normal" style={{color:'var(--text-muted)'}}>/ 8h</span></p>
          <p className="text-xs" style={{color:'var(--text-secondary)'}}>{studyDuration(today.measuredSeconds)} measured · {studyDuration(Math.max(0,today.selfReportedSeconds-(today.classSeconds || 0)))} paper · {studyDuration(today.classSeconds || 0)} attended class</p>
        </div>
      </div>
      {state.window && <p className="text-sm" style={{color:'var(--text-secondary)'}}>24-hour window: {new Date(state.window.startsAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} → {new Date(state.window.endsAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST. Midnight does not reset progress.</p>}
      <progress className="h-3 w-full" style={{accentColor:color}} value={Math.min(today.totalSeconds,state.targetSeconds)} max={state.targetSeconds} aria-label={state.window?'24-hour eight-hour study progress':'Daily eight-hour study progress'} />
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm" style={{color:'var(--text-secondary)'}}>
        <span>Probability: <strong>{studyDuration(today.subjectSeconds.probability)}</strong></span>
        <span>ADSA: <strong>{studyDuration(today.subjectSeconds.adsa)}</strong></span>
        <span>{completed} / {state.days.length} {state.window?'windows':'days'} reached</span>
        {today.expectedSeconds>0 && active && <span>{state.window?'Window pace':state.conversationalMode?'Planned by now':'Checkpoint target'}: {studyDuration(today.expectedSeconds)}</span>}
      </div>
      {state.phase==='setup' && <p className="text-sm">Today is setup. From tomorrow, eight hours every day, including exam days. Breaks and distractions add zero; missed hours stay on that day.</p>}
      {active && !state.conversationalMode && today.status==='behind' && !state.paused && <p className="rounded-lg p-3 text-sm font-medium" style={{background:'rgba(251,113,133,.1)',color:'#fda4af'}} role="status">{snoozed?`Delay ends at ${new Date(today.delayUntil!).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})}. The target is still eight hours.`:`${studyDuration(today.remainingSeconds)} remaining. Start the next block of ${STUDY_SUBJECT_LABELS[selected]}.`}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Subject<select className="input-field mt-1 block" value={selected} onChange={e=>{setSubject(e.target.value as StudySubject);resetPaperRequest();}}><option value="probability">Probability</option><option value="adsa">ADSA</option></select></label>
        {expanded && <label className="min-w-48 flex-1 text-sm">Next concrete task<input className="input-field mt-1 w-full" placeholder="e.g. solve five conditional probability problems" value={topic} maxLength={200} onChange={e=>setTopic(e.target.value)} /></label>}
        {session.active ? <Link className="btn btn-primary" href="/guardian">{session.paused?'Open paused Guardian session':'Open active Guardian session'}</Link> : state.conversationalMode ? <Link className="btn btn-primary" href="/study-plan">Start through study chat</Link> : <button className="btn btn-primary" disabled={busy || !active || today.remainingSeconds===0} onClick={()=>void startBlock()}>{busy?'Working…':`Start now · ${Math.max(5,Math.min(50,Math.ceil(today.remainingSeconds/60)))} min`}</button>}
        {!state.conversationalMode && <button className="btn btn-ghost" disabled={busy || !actionable || today.remainingSeconds===0} onClick={()=>void action({action:'delay'},'Delayed ten minutes. LifeOS will check again; your target is unchanged.')}>Delay 10 minutes{today.delayCount>0?` (${today.delayCount} today)`:''}</button>}
        {!expanded && <Link className="btn btn-ghost" href="/study-plan">Study chat & study record</Link>}
      </div>
      {(error || startError) && <p className="text-sm text-rose-400" role="alert">{error || startError}</p>}
      {notice && <p className="text-sm text-emerald-400" role="status">{notice}</p>}
      {(!state.collectorReady || !state.telegramConfigured || !state.telegramEnabled) && <div className="text-xs leading-relaxed" style={{color:'var(--text-secondary)'}}>
        {!state.collectorReady && <p>Guardian collector is not ready. Connect LifeOSCopilot and its Screen Recording permission to measure computer study. Paper work can be logged below as self-reported.</p>}
        {(!state.telegramConfigured || !state.telegramEnabled) && <p>Telegram nudges are {state.telegramConfigured?'disabled':'not configured'}. In-app prompts work while LifeOS is open. Configure Telegram in <Link className="underline" href="/settings">Settings</Link> for prompts away from this page.</p>}
      </div>}
      {expanded && <>
        <StudyChat />
        <div className="grid gap-5 lg:grid-cols-2">
          <form className="space-y-2" onSubmit={async e=>{e.preventDefault();if(await action({action:'blocker',text:blocker},'Blocker recorded. Choose one smaller next action; the target stays eight hours.')) setBlocker('');}}>
            <h3 className="font-semibold">What is stopping the next block?</h3>
            <label className="block text-sm">Record a blocker<textarea className="input-field mt-1 w-full" value={blocker} onChange={e=>setBlocker(e.target.value)} maxLength={1000} required placeholder="Name the obstacle and the smallest useful next step." /></label>
            <button className="btn btn-ghost" disabled={busy || !active}>Record blocker</button>
            {today.blocker && <p className="text-xs" style={{color:'var(--text-secondary)'}}>Latest blocker: {today.blocker}</p>}
          </form>
          <form className="space-y-2" onSubmit={logPaper}>
            <h3 className="font-semibold">Log actual paper study · self-reported</h3>
            <p className="text-xs" style={{color:'var(--text-secondary)'}}>For {STUDY_SUBJECT_LABELS[selected]}, using the actual study date in IST. An end before the start means the following morning. Enter past time only, up to four hours per entry. Overlap with measured study counts once.</p>
            <div className="flex flex-wrap gap-3"><label className="text-sm">Study date<input className="input-field mt-1 block" type="date" min={state.startDate} max={state.endDate} value={paperDate} onChange={e=>{setPaperDate(e.target.value);resetPaperRequest();}} required /></label><label className="text-sm">Paper start<input className="input-field mt-1 block" type="time" value={paperStart} onInput={e=>{setPaperStart(e.currentTarget.value);resetPaperRequest();}} required /></label><label className="text-sm">Paper end<input className="input-field mt-1 block" type="time" value={paperEnd} onInput={e=>{setPaperEnd(e.currentTarget.value);resetPaperRequest();}} required /></label></div>
            <label className="block text-sm">Work completed<input className="input-field mt-1 w-full" value={paperNotes} maxLength={1000} onChange={e=>{setPaperNotes(e.target.value);resetPaperRequest();}} required placeholder="Problems solved, proofs worked, or pages reviewed" /></label>
            <button className="btn btn-ghost" disabled={busy || !active}>Save self-reported study</button>
          </form>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {!state.window && <form className="space-y-2" onSubmit={async e=>{e.preventDefault();if(await action({action:'review',text:reflection,...(state.date<state.endDate?{nextStartAt:`${nextDay(state.date)}T${firstStart}:00+05:30`}:{})},'Review saved. Today’s actual hours remain unchanged.')) setReflection('');}}>
            <h3 className="font-semibold">Nightly review & next start</h3>
            <label className="block text-sm">What did you finish, and what needs work?<textarea className="input-field mt-1 w-full" value={reflection} maxLength={1000} onChange={e=>setReflection(e.target.value)} required /></label>
            {state.date<state.endDate && <label className="block text-sm">Tomorrow’s first start (IST)<input className="input-field ml-2" type="time" value={firstStart} min="08:00" max="22:59" onInput={e=>setFirstStart(e.currentTarget.value)} required /></label>}
            <button className="btn btn-ghost" disabled={busy || !active}>Save review & commitment</button>
            {today.review && <p className="text-xs" style={{color:'var(--text-secondary)'}}>Saved review: {today.review}{today.nextStartAt?` · Next start ${new Date(today.nextStartAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`:''}</p>}
          </form>}
          {!state.conversationalMode && <form className="space-y-2" onSubmit={async e=>{e.preventDefault();if(await action({action:'checkpoints',hours:hours || state.checkpointHours},'Checkpoint hours saved in IST.')) setHours(null);}}>
            <h3 className="font-semibold">Daily checkpoints · IST</h3>
            <div className="flex flex-wrap gap-3">{(hours || state.checkpointHours).map((hour,index)=><label className="text-sm" key={index}>{(index+1)*2}h by<input className="input-field mt-1 block w-20" aria-label={`${(index+1)*2} hour checkpoint`} type="number" min={8} max={22} value={hour} onChange={e=>{const next=[...(hours || state.checkpointHours)];next[index]=Number(e.target.value);setHours(next);}} /></label>)}</div>
            <button className="btn btn-ghost" disabled={busy}>Save checkpoints</button>
            <p className="text-xs" style={{color:'var(--text-secondary)'}}>When behind: check every ten minutes, 08:00–23:00. Prompts stay quiet during measured study. Snoozes and blockers never earn hours.</p>
          </form>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {active && state.date>='2026-11-10' && !state.probabilityFinishedAt && <button className="btn btn-ghost" disabled={busy} onClick={()=>void action({action:'probability_finished'},'Probability marked finished. ADSA is now the sole priority.')}>Probability exam finished</button>}
          <button className="btn btn-ghost" disabled={busy} onClick={()=>void action({action:state.paused?'resume':'pause'},state.paused?'Accountability prompts resumed.':'Prompts paused. Study history and the eight-hour target remain visible.')}>{state.paused?'Resume accountability prompts':'Pause accountability prompts'}</button>
          <span className="text-xs" style={{color:'var(--text-muted)'}}>{state.lastTelegramSentAt?`Last Telegram delivery: ${new Date(state.lastTelegramSentAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`:'No Telegram reminder delivered yet.'}</span>
        </div>
        <details open={state.phase==='finished'}>
          <summary className="cursor-pointer text-sm font-semibold">{state.window?'24-hour window record':'Daily record'} · missed hours stay visible</summary>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="py-2">{state.window?'Window starting':'Date'}</th><th>Measured</th><th>Self-reported</th><th>Total / 8h</th><th>Result</th></tr></thead><tbody>{state.days.map(day=><tr key={day.date} style={{borderTop:'1px solid var(--border)'}}><td className="py-2">{dateLabel(day.date)}</td><td>{studyDuration(day.measuredSeconds)}</td><td>{studyDuration(day.selfReportedSeconds)}</td><td>{studyDuration(day.totalSeconds)}</td><td style={{color:day.status==='complete'?'#4ade80':day.status==='missed'?'#fb7185':'var(--text-secondary)'}}>{day.status.replace('_',' ')}{day.status==='missed'?` · ${studyDuration(day.remainingSeconds)} short`:''}</td></tr>)}</tbody></table></div>
        </details>
        <p className="text-xs" style={{color:'var(--text-muted)'}}>Measured means Guardian classified the recorded activity as productive within a clearly named Probability or ADSA session. It does not prove comprehension. Paper logs are your own declaration. Keep the LifeOS server running for scheduled nudges.</p>
      </>}
    </section>
  );
}
