import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { endsemDate, getEndsemState } from './endsem-study';
import { ENDSEM_START, ENDSEM_END, STUDY_SUBJECT_LABELS } from './endsem-contract';
import type { StudyCalendarSnapshot, StudyChatState, StudyCalendarEvent } from './study-chat-contract';
import { ensureStudyDay, readStudyDay, readStudyActivity, readStudyPrompt, readPendingStudyQuestion, studyProtectedIntervals, getStudyProtection, studyStartWindowUsable, studyExternalCalendarEvents, type PendingStudyQuestion } from './study-chat-store';
import { fallbackStudyIntent, interpretStudyIntent, validateStudyIntent, type StudyIntent, type IntentContext } from './study-chat-intent';
import { refreshStudyCalendar, rebalanceStudyDay, readStudyDayPlan } from './study-day-planning';

export class StudyChatError extends Error {
  constructor(message:string, public status:400|409|503=400) {super(message);this.name='StudyChatError';}
}
function timeLabel(iso:string):string {return new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));}
function prompt(kind:'return'|'overdue'|'start'|'clarification',key:string,text:string,now:Date,revision:number,activityId:string|null=null,sessionId:string|null=null) {
  const db=getDb(),date=endsemDate(now);
  // A prompt is superseded by a newer prompt for its agreement, not by display.
  if (db.prepare('SELECT 1 FROM study_chat_prompts WHERE prompt_key=?').get(key)) return;
  db.prepare('UPDATE study_chat_prompts SET resolved_at=? WHERE date=? AND resolved_at IS NULL').run(now.toISOString(),date);
  db.prepare('INSERT INTO study_chat_prompts(id,prompt_key,date,activity_id,session_id,revision,kind,text,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),key,date,activityId,sessionId,revision,kind,text,now.toISOString());
}
export function getStudyChatState(now=new Date()):StudyChatState {
  const endsem=getEndsemState(now),day=readStudyDay(now),pending=readPendingStudyQuestion(day);
  // The first conversation can be opened without Guardian. One durable daily
  // question makes the required explicit waking constraints reachable.
  if (endsem.phase==='active' && (!day?.wake_at || !day.day_end_at) && !readStudyPrompt(now)) {
    prompt('clarification',`${endsem.date}:setup`,'What time did you wake up, and when should today’s study day end? For example: “I wake at 08:00 and sleep at 23:00”.',now,day?.revision||0);
  }
  const messages=getDb().prepare('SELECT id,role,text,created_at AS createdAt FROM (SELECT * FROM study_chat_turns WHERE date=? ORDER BY id DESC LIMIT 100) ORDER BY id').all(endsem.date) as StudyChatState['messages'];
  return {ok:true,date:endsem.date,revision:day?.revision||0,enabled:endsem.phase==='active',messages,
    activity:readStudyActivity(now),pendingPrompt:getStudyProtection(now).protected?null:readStudyPrompt(now),pendingQuestion:pending?.question||null,plan:readStudyDayPlan(now),
    remainingSeconds:endsem.today.remainingSeconds,measuredSeconds:endsem.today.measuredSeconds,
    selfReportedSeconds:endsem.today.selfReportedSeconds-endsem.today.classSeconds,classSeconds:endsem.today.classSeconds};
}
export function acknowledgeStudyChatPrompt(promptId:unknown,deviceId:unknown,now=new Date()):void {
  if (typeof promptId!=='string' || !promptId || promptId.length>200 || typeof deviceId!=='string' || !deviceId.trim() || deviceId.length>200) throw new StudyChatError('A prompt ID and device ID are required.');
  getDb().prepare('UPDATE study_chat_prompts SET displayed_at=COALESCE(displayed_at,?),device_id=COALESCE(device_id,?) WHERE id=? AND resolved_at IS NULL').run(now.toISOString(),deviceId,promptId);
}
function freshCalendar(calendar:StudyCalendarSnapshot,now:Date):boolean {
  const age=now.getTime()-Date.parse(calendar.syncedAt||'');
  return calendar.status==='fresh' && Number.isFinite(age) && age>=-5_000 && age<=15*60_000;
}
function readCalendar(now:Date):StudyCalendarSnapshot {
  try {return JSON.parse(readStudyDay(now)?.calendar_json||'null') || {status:'unconfigured',events:[],syncedAt:null,warning:'Calendar availability is uncertain.'};}
  catch {return {status:'stale',events:[],syncedAt:null,warning:'Calendar availability is uncertain.'};}
}
function chainedReturn(at:number,calendar:StudyCalendarSnapshot,now:Date):number {
  if (!freshCalendar(calendar,now)) return at;
  let end=at,changed=true;
  const events=studyExternalCalendarEvents(calendar);
  while(changed) {changed=false;for(const e of events) if(Date.parse(e.start)<=end && Date.parse(e.end)>end) {end=Date.parse(e.end);changed=true;}}
  return end;
}
function calendarIdentity(calendar:StudyCalendarSnapshot):string {
  return JSON.stringify({status:calendar.status,events:calendar.events.map(e=>({id:e.id,title:e.title,start:e.start,end:e.end,kind:e.kind||null,subject:e.subject||null})).sort((a,b)=>a.id.localeCompare(b.id)||a.start.localeCompare(b.start))});
}
function cancelConflictingStudyBlocks(now:Date,calendar:StudyCalendarSnapshot):void {
  if(!freshCalendar(calendar,now))return;
  const db=getDb(),date=endsemDate(now),events=studyExternalCalendarEvents(calendar);
  const rows=db.prepare("SELECT id,planned_start,planned_end,rule_json FROM planned_focus_sessions WHERE status='planned' AND julianday(planned_end)>julianday(?)").all(now.toISOString()) as Array<{id:string;planned_start:string;planned_end:string;rule_json:string}>;
  for(const row of rows) {
    let marker:unknown;try {marker=JSON.parse(row.rule_json).studyChat;} catch {continue;}
    const owned=marker===true || (!!marker && typeof marker==='object' && (marker as {date?:string}).date===date);
    if(owned && events.some(e=>Date.parse(e.start)<Date.parse(row.planned_end) && Date.parse(e.end)>Math.max(now.getTime(),Date.parse(row.planned_start)))) {
      db.prepare("UPDATE planned_focus_sessions SET status='cancelled',invalidated_reason='study_chat_calendar_refresh',invalidated_at=?,updated_at=? WHERE id=? AND status='planned'").run(now.toISOString(),now.toISOString(),row.id);
    }
  }
}
export interface StudyChatOptions {
  now?:Date;
  interpret?:(message:string,context:IntentContext)=>Promise<unknown>;
  calendar?:(now:Date)=>Promise<StudyCalendarSnapshot>;
}
/** Scheduler refreshes the read-only calendar independently of conversation. */
export async function refreshStudyChatCalendar(now=new Date(),refresh=refreshStudyCalendar):Promise<void> {
  const state=getEndsemState(now),initial=readStudyDay(now);
  if(state.phase!=='active' || !state.conversationalMode || !initial)return;
  let calendar:StudyCalendarSnapshot;
  try {calendar=await refresh(now);} catch {calendar={status:'stale',events:[],syncedAt:null,warning:'Calendar availability is uncertain.'};}
  if(!freshCalendar(calendar,now))calendar={...calendar,status:calendar.status==='unconfigured'?'unconfigured':'stale'};
  const db=getDb();
  db.transaction(()=>{
    const day=readStudyDay(now);
    // A user message accepted while this read was in flight owns the newer
    // context. The next scheduler tick can refresh it without overwriting it.
    if(!day || day.revision!==initial.revision)return;
    const changed=calendarIdentity(readCalendar(now))!==calendarIdentity(calendar);
    if(!changed) {db.prepare('UPDATE study_chat_days SET calendar_json=? WHERE date=?').run(JSON.stringify(calendar),state.date);return;}
    const revision=day.revision+1;
    db.prepare('UPDATE study_chat_days SET revision=?,calendar_json=? WHERE date=?').run(revision,JSON.stringify(calendar),state.date);
    cancelConflictingStudyBlocks(now,calendar);
    db.prepare('UPDATE study_chat_prompts SET resolved_at=? WHERE date=? AND resolved_at IS NULL').run(now.toISOString(),state.date);
    rebalanceStudyDay({now,calendar,protectedIntervals:studyProtectedIntervals(now),subject:day.preferred_subject||state.nextSubject,revision});
  })();
}
export async function processStudyChatMessage(input:{message:unknown;requestId:unknown;revision:unknown;date:unknown},options:StudyChatOptions={}):Promise<StudyChatState> {
  if (typeof input.message!=='string' || !input.message.trim() || input.message.trim().length>2000 || typeof input.requestId!=='string' || !/^[\w.:-]{1,150}$/.test(input.requestId) || !Number.isInteger(input.revision) || Number(input.revision)<0) throw new StudyChatError('Send a message up to 2000 characters, a request ID and a nonnegative revision.');
  const now=options.now||new Date(),date=endsemDate(now),message=input.message.trim(),requestId=input.requestId,revision=Number(input.revision),db=getDb();
  if (date<ENDSEM_START || date>ENDSEM_END) throw new StudyChatError('Study chat agreements are available from 22 October through 13 November 2026.');
  if (input.date!==date) throw new StudyChatError('The study day changed. Review today’s state before sending this update.',409);
  const fingerprint=createHash('sha256').update(JSON.stringify({date,message,revision})).digest('hex');
  function existingReply():string|null {
    const existing=db.prepare('SELECT fingerprint,reply FROM study_chat_requests WHERE request_id=?').get(requestId) as {fingerprint:string;reply:string}|undefined;
    if (!existing) return null;
    if (existing.fingerprint!==fingerprint) throw new StudyChatError('This request ID belongs to a different message. Refresh and retry with a new ID.',409);
    return existing.reply;
  }
  const existing=existingReply();if(existing!==null)return {...getStudyChatState(now),reply:existing};
  const initial=getStudyChatState(now);
  if(initial.revision!==revision) throw new StudyChatError('The study agreement changed. Review the latest state and send again.',409);
  let calendar:StudyCalendarSnapshot;
  try {calendar=await (options.calendar||refreshStudyCalendar)(now);} catch {calendar={status:'stale',events:[],syncedAt:null,warning:'Could not refresh calendar; availability is uncertain.'};}
  if(!freshCalendar(calendar,now)) calendar={...calendar,status:calendar.status==='unconfigured'?'unconfigured':'stale',warning:calendar.warning||'Calendar availability is uncertain.'};
  const context:IntentContext={now,state:initial,pending:readPendingStudyQuestion(readStudyDay(now)),calendar};
  const deterministic=validateStudyIntent(fallbackStudyIntent(message,context));
  let intent:StudyIntent|null=deterministic;
  if(!intent) {try {intent=validateStudyIntent(await (options.interpret||interpretStudyIntent)(message,context));} catch {intent=null;}}
  // Load existing lifecycle only for real lifecycle actions, before the SQLite
  // transaction. All mutation validation and revision checks happen inside it.
  const guardian=intent && ['depart','start','class_late'].includes(intent.type) ? await import('./guardian-runtime') : null;
  const readiness=intent?.type==='start' ? await import('./guardian-client-status') : null;
  let lifecycle:(()=>string)|null=null;
  let reply=db.transaction(()=>{
    const retry=existingReply();if(retry!==null)return retry;
    const day=ensureStudyDay(now);
    if(day.revision!==revision) throw new StudyChatError('The study agreement changed while interpreting this message. Review and send again.',409);
    const next=revision+1,activity=readStudyActivity(now),pending=readPendingStudyQuestion(day);
    let question:PendingStudyQuestion|null=pending,text='I could not understand a safe study update. Tell me your meal/return time, actual class attendance, waking window, or “start Probability”.';
    let replan=calendarIdentity(readCalendar(now))!==calendarIdentity(calendar);
    const setReturn=(value:{minutes?:number;until?:string},base:number):string|null=>{
      const at=value.until?Date.parse(value.until):value.minutes?base+value.minutes*60_000:NaN;
      if(!Number.isFinite(at))return null;
      if(at<=now.getTime() || endsemDate(new Date(at))!==date || at-now.getTime()>12*60*60_000) throw new StudyChatError('Agree a future return time today, within twelve hours.');
      return new Date(at).toISOString();
    };
    if(intent?.type==='window') {
      const wake=Date.parse(intent.wakeAt),end=Date.parse(intent.endAt);
      if(endsemDate(new Date(wake))!==date || endsemDate(new Date(end))!==date || end<=wake || end<=now.getTime()) throw new StudyChatError('Give today’s wake and study end times, with the end after now and after waking.');
      db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=? WHERE date=?').run(new Date(wake).toISOString(),new Date(end).toISOString(),date);
      text=`Saved today’s waking/study window, ${timeLabel(intent.wakeAt)}–${timeLabel(intent.endAt)} IST. The target remains eight hours.`;question=null;replan=true;
    } else if(intent?.type==='depart') {
      const until=setReturn(intent,now.getTime()),id=randomUUID();
      db.prepare("UPDATE study_activities SET status='cancelled' WHERE date=? AND status IN ('pending','away')").run(date);
      db.prepare('INSERT INTO study_activities(id,date,kind,title,started_at,expected_return_at,status,revision,calendar_event_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id,date,intent.kind,intent.title,now.toISOString(),until,until?'away':'pending',next,intent.eventId||null);
      lifecycle=()=>{const session=guardian?.getActiveGuardianSession();return session?.state==='ACTIVE' && guardian?.pauseGuardianSession(session.sessionId)?' Guardian is paused.':'';};
      text=until?`Saved ${intent.title} from ${timeLabel(now.toISOString())}; agreed return ${timeLabel(until)} IST. This time earns no study credit.`:`Saved your ${intent.title} departure. How long will you be away, or when will you return?`;
      question=until?null:{type:'return_time',activityId:id,question:'How long will you be away, or when will you return?'};
      replan=true;
    } else if(intent?.type==='class_late') {
      const pendingClass=pending?.type==='class_end'?pending:null;
      const pendingEvent=(!intent.subject || pendingClass?.event?.subject===intent.subject)?pendingClass?.event:undefined;
      const requestedId=intent.eventId||pendingEvent?.id;
      const candidates=studyExternalCalendarEvents(calendar).filter(e=>(e.subject==='probability'||e.subject==='adsa'||e.kind==='class') && (!intent.subject || e.subject===intent.subject) && Date.parse(e.start)<=now.getTime() && Date.parse(e.end)>=now.getTime()-60*60_000);
      const activitySubject=activity?.kind==='class'?(/\bprobability\b/i.test(activity.title)?'probability':/\badsa\b/i.test(activity.title)?'adsa':null):null;
      const currentClass=activity?.kind==='class' && (!requestedId || activity.calendarEventId===requestedId) && (!intent.subject || activitySubject===intent.subject || calendar.events.some(e=>e.id===activity.calendarEventId && e.subject===intent.subject))?activity:null;
      const exactId=requestedId||currentClass?.calendarEventId;
      const event=exactId?(pendingEvent?.id===exactId?pendingEvent:candidates.find(e=>e.id===exactId)):candidates.length===1?candidates[0]:undefined;
      if(!currentClass && !event) {
        question={type:'class_end',subject:intent.subject,question:candidates.length>1?`Which class is running late: ${candidates.map(e=>e.title).join(' or ')}? Name the subject or exact occurrence before setting its new end time.`:'Which class is running late, and what is its new end time? Your meal agreement has not been extended.'};text=question.question;
      }
      else {
        const base=Math.max(now.getTime(),Date.parse(currentClass?.expectedReturnAt||event!.end));
        const until=setReturn(intent,base);
        if(!until) {question={type:'class_end',event,subject:event?.subject||intent.subject,activityId:currentClass?.id,question:`What is ${event?.title||currentClass?.title||'the class'}’s new end time, or how much longer will it run?`};text=question.question;}
        else {
          const id=currentClass?.id||randomUUID(),title=currentClass?.title||event!.title;
          if(currentClass)db.prepare("UPDATE study_activities SET expected_return_at=?,status='away',revision=? WHERE id=?").run(until,next,id);
          else {
            if(activity)db.prepare("UPDATE study_activities SET status='returned',revision=? WHERE id=?").run(next,activity.id);
            db.prepare("INSERT INTO study_activities(id,date,kind,title,started_at,expected_return_at,status,revision,calendar_event_id) VALUES(?,?,'class',?,?,?,'away',?,?)").run(id,date,title,event!.start,until,next,event!.id);
          }
          text=`Saved ${title} running late until ${timeLabel(until)} IST. Attendance is not yet credited.`;question=null;replan=true;
          lifecycle=()=>{const session=guardian?.getActiveGuardianSession();return session?.state==='ACTIVE' && guardian?.pauseGuardianSession(session.sessionId)?' Guardian is paused.':'';};
        }
      }
    } else if(intent?.type==='extend') {
      if(!activity) {text='Which current meal, class or break should I extend? Give its return time.';}
      else {
        const base=intent.fromNow || !activity.expectedReturnAt ? now.getTime() : Math.max(now.getTime(),Date.parse(activity.expectedReturnAt));
        const until=setReturn(intent,base);
        if(!until) {question={type:'return_time',activityId:activity.id,question:'How much longer, or what is the new return time?'};text=question.question;}
        else {
          db.prepare("UPDATE study_activities SET expected_return_at=?,status='away',revision=? WHERE id=?").run(until,next,activity.id);
          text=`Updated ${activity.title}: you left at ${timeLabel(activity.startedAt)}; latest agreed return ${timeLabel(until)} IST. Earlier return reminders are superseded.`;question=null;replan=true;
        }
      }
    } else if(intent?.type==='return') {
      if(activity) db.prepare("UPDATE study_activities SET status='returned',revision=? WHERE id=?").run(next,activity.id);
      const subject=day.preferred_subject||getEndsemState(now).nextSubject;
      question={type:'start',subject,question:`Ready to start ${STUDY_SUBJECT_LABELS[subject]}? Reply yes, choose another subject, or tell me about your next commitment.`};
      text=`Saved your return. ${question.question} A return alone does not earn study credit.`;replan=true;
    } else if(intent?.type==='propose_start') {
      const subject=intent.subject||day.preferred_subject||getEndsemState(now).nextSubject;
      question={type:'start',subject,question:`Start ${STUDY_SUBJECT_LABELS[subject]} now? Reply yes to confirm, or name a different subject.`};
      text=question.question;
      db.prepare('UPDATE study_chat_days SET preferred_subject=? WHERE date=?').run(subject,date);
      replan=true;
    } else if(intent?.type==='start') {
      const subject=intent.subject||day.preferred_subject||getEndsemState(now).nextSubject;
      const liveEvent=freshCalendar(calendar,now)?studyExternalCalendarEvents(calendar).find(e=>Date.parse(e.start)<=now.getTime() && Date.parse(e.end)>now.getTime()):null;
      if(!day.wake_at || !day.day_end_at) {text='Confirm today’s waking/study window before starting. For example: “I wake at 08:00 and sleep at 23:00”.';}
      else if(now.getTime()<Date.parse(day.wake_at) || now.getTime()>=Date.parse(day.day_end_at)) {text=`Your agreed waking/study window is ${timeLabel(day.wake_at)}–${timeLabel(day.day_end_at)} IST. Confirm an explicit window change before starting or resuming outside it.`;}
      else if(activity?.expectedReturnAt && Date.parse(activity.expectedReturnAt)>now.getTime()) {text=`Your ${activity.title} agreement lasts until ${timeLabel(activity.expectedReturnAt)} IST. Confirm “I’m back” before starting.`;}
      else if(liveEvent) {text=`${liveEvent.title} is scheduled until ${timeLabel(liveEvent.end)} IST. Is it finished or are you attending? I have not started study over it.`;}
      else {
        const ready=readiness!.getGuardianClientReadiness(now.getTime());
        if(!ready.ready) text=`Your message is saved, but measured study has not started: MacBook vision client is not ready (${ready.reason}). Open Guardian after fixing collector permission/readiness; paper study can be logged separately.`;
        else {
          const session=guardian!.getActiveGuardianSession();
          const label=STUDY_SUBJECT_LABELS[subject];
          if(session && !new RegExp(`\\b${subject}\\b`,'i').test(session.targetTitle||'')) text='Another Guardian session already exists. Open it and finish or change it explicitly before starting this subject.';
          else if(session?.state==='ACTIVE') text=`Guardian is already active for ${session.targetTitle}. Eligible measured study continues through its evidence ledger.`;
          else {
            text=`Your ${label} start request is saved; Guardian start has not yet been confirmed.`;
            lifecycle=()=>{
              // All plan/state SQL committed before touching runtime memory.
              // A failed lifecycle leaves an honest saved request, never an
              // optimistic start claim or a rolled-back in-memory session.
              const plan=readStudyDayPlan(now),current=readStudyDay(now);
              const block=plan?.sessions.find(s=>s.subject===subject && s.status==='planned' && Date.parse(s.start)<=now.getTime() && Date.parse(s.end)>now.getTime());
              const boundaries=[Date.parse(current?.day_end_at||''),...studyExternalCalendarEvents(calendar).map(e=>Date.parse(e.start)).filter(t=>t>now.getTime()),...studyProtectedIntervals(now).map(e=>Date.parse(e.start)).filter(t=>t>now.getTime())].filter(Number.isFinite);
              const available=boundaries.length?Math.floor((Math.min(...boundaries)-now.getTime())/60_000):NaN;
              if(!freshCalendar(calendar,now) || !current?.wake_at || !current?.day_end_at)return ' Guardian has not started: calendar availability and today’s waking/study window must be confirmed first.';
              if(now.getTime()<Date.parse(current.wake_at) || now.getTime()>=Date.parse(current.day_end_at))return ' Guardian has not started: now is outside the agreed waking/study window. Confirm a window change first.';
              if(!session && !block)return ' Guardian has not started: no concrete planned study block is available now. Review or change the current plan first.';
              const minutes=Math.min(block?Math.floor((Date.parse(block.end)-now.getTime())/60_000):50,available,Math.ceil(getEndsemState(now).today.remainingSeconds/60));
              if(minutes<5)return ' Guardian has not started: fewer than five study minutes fit before the next commitment or day end. Which window should change?';
              const remainingSessionMinutes=session?Math.ceil((session.endsAt-(session.pausedAt??now.getTime()))/60_000):0;
              if(session && remainingSessionMinutes>available)return ' Guardian has not resumed: its remaining duration overlaps a commitment. Open Guardian to adjust the block.';
              readiness!.assertGuardianClientReady();
              const started=session?guardian!.resumeGuardianSession(session.sessionId):guardian!.startGuardianSession({topic:`${label} — Endsem study`,durationMinutes:minutes,source:'api',startRequestId:requestId,plannedSessionId:block?.id});
              if(!started)return ' Guardian could not start. Please retry explicitly after checking readiness.';
              if(activity)db.prepare("UPDATE study_activities SET status='returned',revision=? WHERE id=?").run(next,activity.id);
              db.prepare('UPDATE study_chat_days SET pending_json=NULL WHERE date=? AND revision=?').run(date,next);
              return ` Guardian ${session?'resumed':'started'} for ${label}, ${minutes} minutes. Only eligible actual study evidence will count.`;
            };
          }
        }
      }
      if(!question || question.type!=='start')question={type:'start',subject,question:`Start ${STUDY_SUBJECT_LABELS[subject]} when readiness and availability are confirmed?`};
      db.prepare('UPDATE study_chat_days SET preferred_subject=? WHERE date=?').run(subject,date);replan=true;
    } else if(intent?.type==='attendance') {
      const choices=studyExternalCalendarEvents(calendar).filter(e=>(e.subject==='probability'||e.subject==='adsa') && (!intent.subject || e.subject===intent.subject) && Date.parse(e.start)<now.getTime());
      const pendingEvent=pending?.type==='attendance' && (!intent.subject || pending.event?.subject===intent.subject)?pending.event:undefined;
      const selected=calendar.events.find(e=>e.id===intent.eventId)||(pending?.type==='attendance' && pending.event?.id===intent.eventId?pending.event:undefined);
      // Validate interpreted IDs too: an explicit subject correction supersedes
      // a stale event identity, then resolves against the new subject's events.
      const requestedId=intent.subject && selected?.subject!==intent.subject?undefined:intent.eventId;
      const event:StudyCalendarEvent|undefined=requestedId?choices.find(e=>e.id===requestedId)||(pendingEvent?.id===requestedId?pendingEvent:undefined):choices.length===1?choices[0]:undefined;
      if(!event) {
        question={type:'attendance',subject:intent.subject,question:choices.length>1?`Which ${intent.subject?STUDY_SUBJECT_LABELS[intent.subject]:'Probability/ADSA'} class occurrence did you attend: ${choices.map(e=>`${e.title} (${timeLabel(e.start)}–${timeLabel(e.end)} IST)`).join(' or ')}? Confirm the occurrence and actual attendance times.`:'Which relevant Probability/ADSA class did you actually attend? I need the calendar occurrence and actual start/end times; scheduled class alone gives no credit.'};
        text=question.question;
      }
      else if(!intent.start || !intent.end) {question={type:'attendance',event,question:`For ${event.title}, what actual start and end times did you attend? Reply “from 10:00 to 11:00” (IST).`};text=question.question;}
      else {
        const start=Date.parse(intent.start),end=Date.parse(intent.end),subject=event.subject;
        if(!subject || end<=start || end>now.getTime() || end-start>12*60*60_000 || endsemDate(new Date(start))!==date || endsemDate(new Date(end))!==date || start>=Date.parse(event.end) || end<=Date.parse(event.start)) throw new StudyChatError('Confirm an actual past interval today overlapping that relevant class, with end after start (up to twelve hours).');
        const late=db.prepare("SELECT MAX(expected_return_at) AS end FROM study_activities WHERE calendar_event_id=? AND kind='class'").get(event.id) as {end:string|null};
        if(start<Date.parse(event.start) || end>Math.max(Date.parse(event.end),Date.parse(late.end||event.end))) {
          question={type:'attendance',event,question:`Those actual times fall outside the scheduled ${event.title} bounds. Confirm a class-running-late agreement first, or give the attended interval within ${timeLabel(event.start)}–${timeLabel(event.end)} IST.`};text=question.question;
        } else {
        const previous=db.prepare('SELECT attended_start,attended_end FROM study_class_attendance WHERE calendar_event_id=?').get(event.id) as {attended_start:string;attended_end:string}|undefined;
        if(previous && (Date.parse(previous.attended_start)!==start || Date.parse(previous.attended_end)!==end)) throw new StudyChatError('Attendance for this class is already confirmed. Review the saved interval before correcting it.');
        db.prepare('INSERT OR IGNORE INTO study_class_attendance(id,calendar_event_id,subject,attended_start,attended_end,request_id,calendar_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),event.id,subject,new Date(start).toISOString(),new Date(end).toISOString(),requestId,JSON.stringify(event),now.toISOString());
        if(activity?.calendarEventId===event.id)db.prepare("UPDATE study_activities SET status='returned',revision=? WHERE id=?").run(next,activity.id);
        text=`Saved your confirmed ${event.title} attendance, ${timeLabel(intent.start)}–${timeLabel(intent.end)} IST, as self-reported class time. Overlap with measured or paper study counts once.`;question=null;replan=true;
        }
      }
    } else if(intent?.type==='clarify') text=intent.question;
    db.prepare('UPDATE endsem_config SET conversational_mode=1 WHERE id=1').run();
    db.prepare('UPDATE study_chat_days SET revision=?,pending_json=?,calendar_json=? WHERE date=?').run(next,question?JSON.stringify(question):null,JSON.stringify(calendar),date);
    db.prepare('UPDATE study_chat_prompts SET resolved_at=? WHERE date=? AND resolved_at IS NULL').run(now.toISOString(),date);
    if(replan) {
      cancelConflictingStudyBlocks(now,calendar);
      const plan=rebalanceStudyDay({now,calendar,protectedIntervals:studyProtectedIntervals(now),subject:readStudyDay(now)?.preferred_subject||getEndsemState(now).nextSubject,revision:next});
      // An unknown return is the immediate question. Unknown availability is
      // missing input, not proof that 480 minutes cannot fit. Capacity questions
      // are already phrased once by the planner and remain visible in plan UI.
      if(!question && plan.needsInput)text+=` ${plan.needsInput}`;
      if(!question && plan.warning && !plan.needsInput)text+=` ${plan.warning}`;
    }
    db.prepare('INSERT INTO study_chat_turns(date,role,text,request_id,created_at) VALUES(?,?,?,?,?)').run(date,'user',message,requestId,now.toISOString());
    db.prepare('INSERT INTO study_chat_turns(date,role,text,request_id,created_at) VALUES(?,?,?,?,?)').run(date,'assistant',text,requestId,now.toISOString());
    db.prepare('INSERT INTO study_chat_requests(request_id,fingerprint,expected_revision,reply,created_at) VALUES(?,?,?,?,?)').run(requestId,fingerprint,revision,text,now.toISOString());
    return text;
  })();
  if(lifecycle) {
    let result:string;
    try {result=(lifecycle as ()=>string)();} catch {result=' Guardian lifecycle could not be confirmed. The conversation is saved; check collector readiness before explicitly trying again.';}
    reply+=result;
    db.transaction(()=>{
      db.prepare("UPDATE study_chat_turns SET text=? WHERE request_id=? AND role='assistant'").run(reply,requestId);
      db.prepare('UPDATE study_chat_requests SET reply=? WHERE request_id=?').run(reply,requestId);
    })();
  }
  return {...getStudyChatState(now),reply};
}

export function runStudyChatAccountability(now=new Date()):void {
  const state=getEndsemState(now),day=readStudyDay(now);
  if(state.phase!=='active' || !state.conversationalMode || state.paused || state.activeStudy || !day) return;
  if(getStudyProtection(now).protected)return;
  if((day.wake_at && now.getTime()<Date.parse(day.wake_at)) || (day.day_end_at && now.getTime()>=Date.parse(day.day_end_at)))return;
  const inWindow=!!day.wake_at && !!day.day_end_at && now.getTime()>=Date.parse(day.wake_at) && now.getTime()<Date.parse(day.day_end_at);
  const activity=readStudyActivity(now),calendar=readCalendar(now);
  let due=0,key='',text='',kind:'return'|'overdue'|'start'|'clarification'='start',sessionId:string|null=null;
  if(activity) {
    due=activity.expectedReturnAt?chainedReturn(Date.parse(activity.expectedReturnAt),calendar,now):Date.parse(activity.startedAt)+10*60_000;
    if(now.getTime()<due) return;
    const elapsed=now.getTime()-due,overdue=elapsed>=5*60_000;
    // First deadline prompt is part of an explicit agreement. Repeated prompts
    // require explicit daily waking constraints and use 10-minute buckets.
    if(overdue && !inWindow)return;
    kind=activity.expectedReturnAt?(overdue?'overdue':'return'):'clarification';
    key=`${state.date}:${activity.id}:${activity.revision}:${overdue?'overdue:'+Math.floor((elapsed-5*60_000)/600_000):'return'}`;
    text=activity.expectedReturnAt?`You left for ${activity.title} at ${timeLabel(activity.startedAt)}. ${overdue?`You are ${Math.floor(elapsed/60_000)} minutes past the latest agreed return.`:'It is the agreed return time.'} Are you back, extending it, or going to another commitment?`:`You left for ${activity.title} at ${timeLabel(activity.startedAt)}, but a return time is still unconfirmed. When will you return?`;
    if(!freshCalendar(calendar,now))text+=' Calendar availability is uncertain; tell me about any class or travel before starting.';
  } else {
    if(!inWindow || state.today.remainingSeconds<=0 || !freshCalendar(calendar,now))return;
    if(studyExternalCalendarEvents(calendar).some(e=>Date.parse(e.start)<=now.getTime() && Date.parse(e.end)>now.getTime()))return;
    const plan=readStudyDayPlan(now);
    const session=plan?.sessions.find(s=>Date.parse(s.start)+5*60_000<=now.getTime() && studyStartWindowUsable(s.id,now));
    if(!session)return;
    sessionId=session.id;due=Date.parse(session.start)+5*60_000;
    key=`${state.date}:start:${session.id}:${day.revision}:${Math.floor((now.getTime()-due)/600_000)}`;
    text=`Your agreed ${session.title} block was due at ${timeLabel(session.start)} IST. Ready to start, or has a commitment changed?`;
  }
  prompt(kind,key,text,now,day.revision,activity?.id||null,sessionId);
}
