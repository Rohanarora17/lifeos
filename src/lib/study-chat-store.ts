import { getDb } from './db';
import { endsemDate } from './endsem-study';
import { ENDSEM_START, ENDSEM_END } from './endsem-contract';
import type { StudyActivity, StudyChatPrompt, StudyProtectedInterval, StudyCalendarEvent } from './study-chat-contract';

export interface PendingStudyQuestion {
  type: 'return_time' | 'attendance' | 'class_end' | 'window' | 'start';
  question: string;
  activityId?: string;
  event?: StudyCalendarEvent;
  subject?: 'probability' | 'adsa';
}
export interface StudyDayRow {
  date: string; revision: number; pending_json: string | null;
  preferred_subject: 'probability' | 'adsa' | null;
  wake_at: string | null; day_end_at: string | null; plan_json: string | null; calendar_json: string | null;
}
export function readStudyDay(now = new Date()): StudyDayRow | null {
  return getDb().prepare('SELECT * FROM study_chat_days WHERE date = ?').get(endsemDate(now)) as StudyDayRow | undefined || null;
}
export function ensureStudyDay(now: Date): StudyDayRow {
  getDb().prepare('INSERT OR IGNORE INTO study_chat_days(date) VALUES(?)').run(endsemDate(now));
  return readStudyDay(now)!;
}
export function readPendingStudyQuestion(day: StudyDayRow | null): PendingStudyQuestion | null {
  if (!day?.pending_json) return null;
  try { return JSON.parse(day.pending_json) as PendingStudyQuestion; } catch { return null; }
}
export function readStudyActivity(now = new Date()): StudyActivity | null {
  const row = getDb().prepare("SELECT * FROM study_activities WHERE date=? AND status IN ('pending','away') ORDER BY revision DESC LIMIT 1").get(endsemDate(now)) as {id:string;kind:StudyActivity['kind'];title:string;started_at:string;expected_return_at:string|null;status:StudyActivity['status'];revision:number;calendar_event_id:string|null} | undefined;
  return row ? {id:row.id,kind:row.kind,title:row.title,startedAt:row.started_at,expectedReturnAt:row.expected_return_at,status:row.status,revision:row.revision,calendarEventId:row.calendar_event_id} : null;
}
/** Exact exported focus bounds represent the same planned study, not another
 * commitment. A moved event or a merely similar title remains protected. */
export function studyExternalCalendarEvents(calendar:{events:StudyCalendarEvent[]}):StudyCalendarEvent[] {
  const linked=getDb().prepare('SELECT calendar_event_id,planned_start,planned_end FROM planned_focus_sessions WHERE calendar_event_id IS NOT NULL').all() as Array<{calendar_event_id:string;planned_start:string;planned_end:string}>;
  const instant=(value:string)=>Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)?value.replace(' ','T')+'Z':value);
  return calendar.events.filter(e=>!linked.some(row=>{
    const id=row.calendar_event_id;
    const exactId=e.id===id || e.id==='study_oauth:'+id || (e.id.startsWith(id+'_') && instant(e.id.slice(id.length+1))===instant(e.start));
    return exactId && instant(e.start)===instant(row.planned_start) && instant(e.end)===instant(row.planned_end);
  }));
}
/** Current persisted row and complete remaining window own start invitations. */
export function studyStartWindowUsable(sessionId:string,now=new Date()):boolean {
  const day=readStudyDay(now);
  if(!day?.wake_at || !day.day_end_at || now.getTime()<Date.parse(day.wake_at) || now.getTime()>=Date.parse(day.day_end_at))return false;
  const row=getDb().prepare("SELECT planned_start,planned_end FROM planned_focus_sessions WHERE id=? AND status='planned'").get(sessionId) as {planned_start:string;planned_end:string}|undefined;
  if(!row)return false;
  const start=Math.max(now.getTime(),Date.parse(row.planned_start)),end=Date.parse(row.planned_end);
  if(Date.parse(row.planned_start)>now.getTime() || end-start<5*60_000 || end>Date.parse(day.day_end_at))return false;
  try {
    const calendar=JSON.parse(day.calendar_json||'null') as {status:string;syncedAt:string|null;events:StudyCalendarEvent[]}|null;
    const age=now.getTime()-Date.parse(calendar?.syncedAt||'');
    if(!calendar || calendar.status!=='fresh' || !Number.isFinite(age) || age < -5_000 || age>15*60_000)return false;
    if(studyExternalCalendarEvents(calendar).some(e=>Date.parse(e.start)<end && Date.parse(e.end)>start))return false;
    if(studyProtectedIntervals(now).some(e=>Date.parse(e.start)<end && Date.parse(e.end)>start))return false;
    return true;
  } catch {return false;}
}
export function readStudyPrompt(now = new Date()): StudyChatPrompt | null {
  const row = getDb().prepare("SELECT p.* FROM study_chat_prompts p WHERE date=? AND resolved_at IS NULL AND (session_id IS NULL OR EXISTS (SELECT 1 FROM planned_focus_sessions s WHERE s.id=p.session_id AND s.status='planned')) ORDER BY created_at DESC,id DESC LIMIT 1").get(endsemDate(now)) as {id:string;text:string;kind:StudyChatPrompt['kind'];created_at:string;session_id:string|null}|undefined;
  if(row?.kind==='start' && row.session_id && !studyStartWindowUsable(row.session_id,now))return null;
  return row ? {id:row.id,text:row.text,kind:row.kind,createdAt:row.created_at} : null;
}
export function studyProtectedIntervals(now = new Date()): StudyProtectedInterval[] {
  return (getDb().prepare("SELECT id,title,started_at AS start,expected_return_at AS end,kind FROM study_activities WHERE date=? AND status IN ('pending','away') AND expected_return_at IS NOT NULL").all(endsemDate(now)) as StudyProtectedInterval[]).filter(r=>Date.parse(r.end)>now.getTime());
}
// No imports of Guardian, AI, planner or coaching: safe for their lightweight gates.
export function getStudyProtection(now = new Date()): {protected:boolean; reason:string|null; until:string|null} {
  const date = endsemDate(now);
  if (date<ENDSEM_START || date>ENDSEM_END) return {protected:false,reason:null,until:null};
  const mode = getDb().prepare('SELECT conversational_mode FROM endsem_config WHERE id=1').get() as {conversational_mode:number};
  if (!mode.conversational_mode) return {protected:false,reason:null,until:null};
  const day = readStudyDay(now);
  if (day?.wake_at && now.getTime()<Date.parse(day.wake_at)) return {protected:true,reason:'Before the explicitly agreed waking window.',until:day.wake_at};
  if (day?.day_end_at && now.getTime()>=Date.parse(day.day_end_at)) return {protected:true,reason:'After the explicitly agreed study day.',until:null};
  // A refreshed calendar commitment protects itself, including one immediately
  // after a meal. The snapshot includes freshness even after a successful empty
  // sync, so an empty mirror is never treated as evidence of availability.
  if(day?.calendar_json) {
    try {
      const calendar=JSON.parse(day.calendar_json) as {status:string;syncedAt:string|null;events:StudyCalendarEvent[]};
      const age=now.getTime()-Date.parse(calendar.syncedAt||'');
      if(calendar.status==='fresh' && age>=-5_000 && age<=15*60_000) {
        const current=studyExternalCalendarEvents(calendar).find(e=>Date.parse(e.start)<=now.getTime() && Date.parse(e.end)>now.getTime());
        if(current)return {protected:true,reason:`Calendar commitment: ${current.title}.`,until:current.end};
      }
    } catch { /* unknown calendar is not a protected indefinite interval */ }
  }
  const activity = readStudyActivity(now);
  if (!activity) return {protected:false,reason:null,until:null};
  const until = activity.expectedReturnAt || new Date(Date.parse(activity.startedAt)+10*60_000).toISOString();
  return Date.parse(until)>now.getTime() ? {protected:true,reason:`Agreed ${activity.title}; awaiting return.`,until} : {protected:false,reason:null,until:null};
}
export function getStudyConversationDirective(now = new Date()): string | null {
  const date=endsemDate(now);
  if(date<ENDSEM_START || date>ENDSEM_END)return null;
  const mode = getDb().prepare('SELECT conversational_mode FROM endsem_config WHERE id=1').get() as {conversational_mode:number};
  if (!mode.conversational_mode) return null;
  const activity=readStudyActivity(now), pending=readPendingStudyQuestion(readStudyDay(now));
  return `Conversational study agreements own accountability; do not repeat fixed checkpoint reminders. ${activity ? `Declared ${activity.title} since ${activity.startedAt}; expected return ${activity.expectedReturnAt || 'not yet agreed'}. ` : ''}${pending ? `Pending question: ${pending.question} ` : ''}${getStudyProtection(now).protected ? 'Respect this protected activity or explicit sleep window; do not push a conflicting immediate start.' : 'Do not invent an absence duration or assume class attendance.'}`;
}
