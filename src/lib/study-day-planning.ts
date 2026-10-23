import { getStudyWindow } from './study-window';
import { studyExternalCalendarEvents } from './study-chat-store';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, getSetting } from './db';
import { syncCalendarFromICS } from './calendar';
import { endsemDate, getEndsemState } from './endsem-study';
import { ENDSEM_START, ENDSEM_END, STUDY_SUBJECT_LABELS, type StudySubject } from './endsem-contract';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import type { StudyCalendarSnapshot, StudyCalendarEvent, StudyProtectedInterval, StudyDayPlan, StudyDaySession } from './study-chat-contract';

const MINUTE = 60_000;
const CALENDAR_MAX_AGE = 15 * MINUTE;
type Range = { start: number; end: number };
type SessionRow = {id:string; plan_id:number; task_id:number|null; title:string; planned_start:string; planned_end:string; duration_minutes:number; rule_json:string; status:string;calendar_event_id:string|null;invalidated_reason:string|null};
type DayRow = {revision:number; wake_at:string|null; day_end_at:string|null; plan_json:string|null};

// SQLite UTC timestamps have a space and no suffix; ISO timestamps already
// carry their zone. Appending Z to ISO values produces an invalid timestamp.
function instant(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}
function subjectOf(title: string): StudySubject | null {
  const p = /\bprobability\b/i.test(title), a = /\badsa\b/i.test(title);
  return p === a ? null : p ? 'probability' : 'adsa';
}
function classSubject(title: string): StudySubject | null {
  return /\b(exam|endsem|test|study|focus|revision|practice)\b/i.test(title) ? null : subjectOf(title);
}
function json(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function merge(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of ranges.filter(r=>Number.isFinite(r.start) && Number.isFinite(r.end) && r.end>r.start).sort((a,b)=>a.start-b.start)) {
    const previous=result[result.length-1];
    if(previous && range.start<=previous.end) previous.end=Math.max(previous.end,range.end);
    else result.push({...range});
  }
  return result;
}
function durationMs(ranges: Range[]): number {return merge(ranges).reduce((sum,r)=>sum+r.end-r.start,0);}
function minutes(ranges: Range[]): number {return durationMs(ranges)/MINUTE;}
function availableMinutes(ranges: Range[], blocked: Range[]): number {
  const fixed=merge(blocked);
  return merge(ranges).reduce((sum,range)=>{
    const overlap=durationMs(fixed.map(r=>({start:Math.max(range.start,r.start),end:Math.min(range.end,r.end)})));
    return sum+range.end-range.start-overlap;
  },0)/MINUTE;
}

/** Runtime reads the app's configured calendar; no MCP dependency or event writes. */
export async function refreshStudyCalendar(now = new Date()): Promise<StudyCalendarSnapshot> {
  const db = getDb(), period=getStudyWindow(now), lower=period.start, upper=period.end;
  const icsUrl = getSetting('calendar_ics_url');
  const oauthToken = getSetting('google_calendar_refresh_token');
  const warning = 'Calendar availability is uncertain. Refresh or configure the calendar before scheduling study.';
  if (!icsUrl && !oauthToken) return {status:'unconfigured',events:[],syncedAt:null,warning};
  let syncedAt: string | null = null;
  if (icsUrl) {
    const source = createHash('sha256').update(icsUrl).digest('hex');
    const stamp = getSetting('calendar_ics_last_success_at');
    const age = now.getTime()-instant(stamp);
    const current = getSetting('calendar_ics_last_success_source')===source && age>=0 && age<CALENDAR_MAX_AGE;
    const result = current ? null : await syncCalendarFromICS();
    if (current || result?.errors.length===0) syncedAt=getSetting('calendar_ics_last_success_at') || null;
  }
  if (!syncedAt && oauthToken) {
    // Existing convenience helpers swallow API errors into [] and cap at ten
    // events. Availability requires a complete, successful, paginated read.
    try {
      const { google } = await import('googleapis');
      const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID || '', process.env.GOOGLE_CLIENT_SECRET || '');
      auth.setCredentials({refresh_token:oauthToken});
      const calendar = google.calendar({version:'v3',auth});
      const events: StudyCalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const response = await calendar.events.list({calendarId:process.env.GOOGLE_CALENDAR_ID || getSetting('google_calendar_id') || 'primary',
          timeMin:new Date(lower).toISOString(),timeMax:new Date(upper).toISOString(),singleEvents:true,orderBy:'startTime',maxResults:2500,pageToken});
        for(const event of response.data.items || []) {
          if(event.status==='cancelled' || event.transparency==='transparent') continue;
          const start=event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00+05:30` : '');
          const end=event.end?.dateTime || (event.end?.date ? `${event.end.date}T00:00:00+05:30` : '');
          if(!event.id || !Number.isFinite(instant(start)) || !(instant(end)>instant(start))) throw new Error('Calendar event has unknown bounds');
          const subject=classSubject(event.summary || '');
          events.push({id:`study_oauth:${event.id}`,title:event.summary || 'Calendar commitment',start:new Date(instant(start)).toISOString(),end:new Date(instant(end)).toISOString(),subject,kind:subject?'class':'commitment'});
        }
        pageToken=response.data.nextPageToken || undefined;
      } while(pageToken);
      syncedAt=now.toISOString();
      db.transaction(()=>{
        db.prepare("DELETE FROM calendar_events WHERE id LIKE 'study_oauth:%' AND julianday(end_time)>julianday(?) AND julianday(start_time)<julianday(?)").run(new Date(lower).toISOString(),new Date(upper).toISOString());
        const save=db.prepare('INSERT OR REPLACE INTO calendar_events(id,title,start_time,end_time,synced_at) VALUES(?,?,?,?,?)');
        for(const event of events) save.run(event.id,event.title,event.start,event.end,syncedAt);
      })();
      return {status:'fresh',events,syncedAt,warning:null};
    } catch {
      return {status:'stale',events:[],syncedAt:null,warning};
    }
  }
  if (!syncedAt) return {status:'stale',events:[],syncedAt:null,warning};
  const rows=db.prepare("SELECT id,title,start_time,end_time FROM calendar_events WHERE id NOT LIKE 'study_oauth:%'").all() as Array<{id:string;title:string;start_time:string;end_time:string}>;
  const events: StudyCalendarEvent[]=[];
  for(const row of rows) {
    const start=instant(row.start_time), end=instant(row.end_time);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start) return {status:'stale',events:[],syncedAt,warning:'A calendar event has unknown bounds. Refresh the calendar before scheduling.'};
    if(end>lower && start<upper) {const subject=classSubject(row.title); events.push({id:row.id,title:row.title,start:new Date(start).toISOString(),end:new Date(end).toISOString(),subject,kind:subject?'class':'commitment'});}
  }
  return {status:'fresh',events,syncedAt,warning:null};
}

export function readStudyDayPlan(now = new Date()): StudyDayPlan | null {
  const row=getDb().prepare('SELECT plan_json FROM study_chat_days WHERE date=?').get(getStudyWindow(now).key) as {plan_json:string|null}|undefined;
  if(!row?.plan_json) return null;
  try {return JSON.parse(row.plan_json) as StudyDayPlan;} catch {return null;}
}

/** Rebalance remaining LifeOS-owned, unstarted work. Earned time stays in the ledger. */
export function rebalanceStudyDay(input: {now:Date; calendar:StudyCalendarSnapshot; protectedIntervals:StudyProtectedInterval[]; subject:StudySubject; revision:number}): StudyDayPlan {
  const db=getDb(), {now,calendar,revision}=input, period=getStudyWindow(now), date=period.key, timestamp=now.getTime();
  return db.transaction(()=>{
    const day=db.prepare('SELECT * FROM study_chat_days WHERE date=?').get(date) as DayRow|undefined;
    if(day && revision!==day.revision) throw new Error('Study plan revision changed; refresh before applying this plan.');
    const ledger=getEndsemState(now);
    const remainingSeconds=ledger.today.remainingSeconds;
    const end=instant(day?.day_end_at), wake=instant(day?.wake_at);
    // Availability never moves the target's agreed deadline.
    const endAt=Number.isFinite(end) ? new Date(Math.min(end,period.end)).toISOString() : null;
    const plan: StudyDayPlan={date,revision,sessions:[],remainingSeconds,scheduledMinutes:0,shortfallMinutes:Math.ceil(remainingSeconds/60),anticipatedClassMinutes:0,calendarStatus:calendar.status,needsInput:null,warning:calendar.warning,endAt};
    const rows=db.prepare('SELECT * FROM planned_focus_sessions WHERE julianday(planned_end)>julianday(?) AND julianday(planned_start)<julianday(?)').all(new Date(period.start).toISOString(),new Date(period.end).toISOString()) as SessionRow[];
    const owned=(row:SessionRow)=>{
      const marker=json(row.rule_json).studyChat;
      return marker===true || (!!marker && typeof marker==='object' && (marker as {date?:string}).date===date);
    };
    const commitments=input.protectedIntervals.map(e=>({start:instant(e.start),end:instant(e.end)}));
    const cancel=(row:SessionRow)=>db.prepare("UPDATE planned_focus_sessions SET status='cancelled',invalidated_reason='study_chat_rebalance',invalidated_at=?,updated_at=? WHERE id=?").run(now.toISOString(),now.toISOString(),row.id);
    // A missed proposed start is still unstarted work, not an active session.
    // Keep fully past rows as history; supersede any remaining live proposal.
    const replace=rows.filter(r=>owned(r) && r.status==='planned' && instant(r.planned_end)>timestamp);
    // A known meal/return still invalidates conflicting owned work while
    // calendar availability is uncertain. It cannot authorize a new free slot.
    for(const row of replace) if(commitments.some(c=>c.end>Math.max(timestamp,instant(row.planned_start)) && c.start<instant(row.planned_end))) {cancel(row);row.status='cancelled';}
    const save=()=>{
      db.prepare('INSERT INTO study_chat_days(date,revision,plan_json) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET plan_json=excluded.plan_json').run(date,revision,JSON.stringify(plan));
      return plan;
    };
    if(endsemDate(now)<ENDSEM_START || endsemDate(now)>ENDSEM_END) {plan.needsInput='Study campaign is outside its active dates.'; return save();}
    if(!Number.isFinite(end)) {plan.needsInput='What time does your study day end, or when will you sleep tonight?';return save();}
    if(calendar.status!=='fresh') {plan.needsInput='Calendar availability is uncertain. Refresh or configure your calendar first.';plan.warning='No new study was scheduled. Conflicting future study was cancelled; other existing sessions remain unverified until the calendar is fresh.';return save();}
    if(day?.wake_at && !Number.isFinite(wake)) {plan.needsInput='Please confirm a valid wake time.';return save();}
    const start=Math.max(timestamp,Number.isFinite(wake)?wake:timestamp);
    const stop=Math.min(end,period.end);
    const mirrored=(row:SessionRow,event:StudyCalendarEvent)=>{
      const id=row.calendar_event_id;
      return !!id && (event.id===id || event.id===`study_oauth:${id}` || (event.id.startsWith(`${id}_`) && instant(event.id.slice(id.length+1))===instant(event.start)));
    };
    const kept=rows.filter(r=>!replace.includes(r) && !['cancelled','skipped','completed'].includes(r.status) && instant(r.planned_end)>timestamp);
    // An unchanged retained session and its exact linked mirror are one study
    // interval. A moved mirror remains protected separately; only owned future
    // work being replaced may release a different exported interval.
    // Replanning is internal: an exact export of superseded owned work may
    // still exist on the calendar on the next turn. It cannot re-block the
    // released interval; an externally moved mirror still remains protected.
    const released=rows.filter(r=>owned(r) && r.status==='cancelled' && r.invalidated_reason==='study_chat_rebalance');
    const events=studyExternalCalendarEvents(calendar).filter(e=>!replace.some(r=>mirrored(r,e)) && ![...kept,...released].some(r=>mirrored(r,e) && instant(e.start)===instant(r.planned_start) && instant(e.end)===instant(r.planned_end)));
    const movedMirror=rows.some(r=>!replace.includes(r) && ['planned','started'].includes(r.status) && events.some(e=>mirrored(r,e) && (instant(e.start)!==instant(r.planned_start) || instant(e.end)!==instant(r.planned_end))));
    const calendarRanges=events.map(e=>({start:instant(e.start),end:instant(e.end)}));
    if([...calendarRanges,...commitments].some(r=>!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end<=r.start)) {plan.needsInput='A commitment has unknown bounds. Confirm its start and return time.';return save();}
    plan.anticipatedClassMinutes=Math.floor(minutes(events.filter(e=>classSubject(e.title) && (ledger.nextSubject!=='adsa' || classSubject(e.title)==='adsa')).map(e=>({start:Math.max(start,instant(e.start)),end:Math.min(stop,instant(e.end))}))));
    const active=db.prepare("SELECT session_id,started_at,duration_minutes FROM guardian_sessions WHERE state='ACTIVE'").all() as Array<{session_id:string;started_at:number;duration_minutes:number}>;
    const activeRanges=active.map(r=>({start:Number(r.started_at),end:Number(r.started_at)+r.duration_minutes*MINUTE}));
    if(activeRanges.some(r=>r.end<=timestamp) || rows.some(r=>r.status==='started' && instant(r.planned_end)<=timestamp)) {plan.needsInput='An active study session has passed its planned end. Confirm its end before replanning.';return save();}
    const blocked=merge([...calendarRanges,...commitments,...kept.map(r=>({start:instant(r.planned_start),end:instant(r.planned_end)})),...activeRanges]);
    // Existing future study is planned capacity, never earned ledger credit.
    plan.sessions=kept.flatMap(r=>{
      const subject=subjectOf(r.title);
      if(!subject) return [];
      return [{id:r.id,title:r.title,subject,start:r.planned_start,end:r.planned_end,durationMinutes:Math.max(0,Math.floor((Math.min(stop,instant(r.planned_end))-Math.max(start,instant(r.planned_start)))/MINUTE)),status:r.status}];
    });
    const fixed=[...calendarRanges,...commitments];
    const keptRanges=plan.sessions.map(s=>({start:Math.max(start,instant(s.start)),end:Math.min(stop,instant(s.end))}));
    const rawKeptCapacity=availableMinutes(keptRanges,fixed);
    const keptCapacity=Math.floor(rawKeptCapacity);
    const hasExistingConflict=rawKeptCapacity<minutes(keptRanges);
    let needed=Math.max(0,Math.ceil(remainingSeconds/60)-keptCapacity-plan.anticipatedClassMinutes);
    const windows:Range[]=[];
    let cursor=start;
    for(const range of blocked) {
      if(range.end<=cursor || range.start>=stop) continue;
      if(range.start>cursor) windows.push({start:cursor,end:Math.min(stop,range.start)});
      cursor=Math.max(cursor,range.end);
    }
    if(cursor<stop) windows.push({start:cursor,end:stop});
    const template=replace.find(r=>subjectOf(r.title)===input.subject) || replace[0];
    const templateRule=template?json(template.rule_json):{};
    const preferred=getAdaptiveSessionMinutes(templateRule.preferredMinutes || template?.duration_minutes);
    const breakMinutes=typeof templateRule.breakMinutes==='number' && templateRule.breakMinutes>=0 ? Math.min(60,templateRule.breakMinutes) : 8;
    const probabilityDone=ledger.nextSubject==='adsa';
    let subject:StudySubject=probabilityDone?'adsa':input.subject;
    db.prepare("INSERT INTO daily_plans(plan_date,generation_source) VALUES(?,'study_chat') ON CONFLICT(plan_date) DO NOTHING").run(date);
    const parent=db.prepare('SELECT id FROM daily_plans WHERE plan_date=?').get(date) as {id:number};
    for(const row of replace) cancel(row);
    let nextStart=start;
    for(const window of windows) {
      let position=Math.max(window.start,nextStart);
      // Guardian starts require at least five available minutes. Do not count
      // tiny calendar gaps as capacity; a final partial target can use a full
      // five-minute block without inventing earned credit.
      while(needed>0 && position+5*MINUTE<=window.end) {
        let duration=Math.min(preferred,Math.max(5,needed),Math.floor((window.end-position)/MINUTE));
        // Leave a startable final block instead of rounding an otherwise exact
        // target up because the preferred block would leave 1–4 minutes.
        const tail=needed-duration;
        if(tail>0 && tail<5 && duration-(5-tail)>=5)duration-=5-tail;
        const model=replace.find(r=>subjectOf(r.title)===subject);
        const id=`study_chat_${randomUUID()}`;
        const session:StudyDaySession={id,title:model?.title || `${STUDY_SUBJECT_LABELS[subject]} — Endsem study`,subject,start:new Date(position).toISOString(),end:new Date(position+duration*MINUTE).toISOString(),durationMinutes:duration,status:'planned'};
        const rule={...(model?json(model.rule_json):{}),mode:'study',preferredMinutes:duration,breakMinutes,studyChat:{date,revision},calendarSyncPending:true};
        db.prepare("INSERT INTO planned_focus_sessions(id,plan_id,task_id,title,planned_start,planned_end,duration_minutes,rule_json,session_type,status,origin) VALUES(?,?,?,?,?,?,?,?,'study','planned','study_chat')")
          .run(id,parent.id,model?.task_id || null,session.title,session.start,session.end,duration,JSON.stringify(rule));
        plan.sessions.push(session); needed-=duration;
        position+= (duration+breakMinutes)*MINUTE;
        nextStart=position;
        if(!probabilityDone) subject=subject==='probability'?'adsa':'probability';
      }
    }
    plan.sessions.sort((a,b)=>instant(a.start)-instant(b.start));
    plan.scheduledMinutes=Math.floor(availableMinutes(plan.sessions.map(s=>({start:Math.max(start,instant(s.start)),end:Math.min(stop,instant(s.end))})),fixed));
    plan.shortfallMinutes=Math.max(0,Math.ceil(remainingSeconds/60)-plan.scheduledMinutes-plan.anticipatedClassMinutes);
    if(plan.anticipatedClassMinutes>0) plan.warning=`${plan.anticipatedClassMinutes} class minutes are anticipated only. Attendance confirmation is required before they count toward earned study.`;
    if(plan.shortfallMinutes>0) plan.needsInput=`The remaining window is short by ${plan.shortfallMinutes} study minutes including planned breaks. Which future commitment or study window can change?`;
    if(hasExistingConflict) plan.needsInput=`An existing session overlaps a protected commitment. Resolve that conflict before starting it.${plan.needsInput?` ${plan.needsInput}`:''}`;
    if(movedMirror) plan.needsInput=`An existing session moved on your calendar. Its calendar time is protected; confirm which time to keep.${plan.needsInput?` ${plan.needsInput}`:''}`;
    return save();
  })();
}
