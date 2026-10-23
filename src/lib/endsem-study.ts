import { randomUUID } from 'node:crypto';
import { getDb, getSetting, setSetting } from './db';
import { getStudyWindow, studyCalendarDate } from './study-window';
import {
  ENDSEM_START, ENDSEM_END, ENDSEM_TARGET_SECONDS, ENDSEM_TIME_ZONE,
  type EndsemDay, type EndsemState, type StudySubject,
} from './endsem-contract';

export class EndsemInputError extends Error {}
type Config = {checkpoint_hours: string; probability_finished_at: string | null; paused: number; conversational_mode: number};
type DayRow = {date: string; delay_until: string | null; delay_count: number; blocker: string | null; review: string | null; next_start_at: string | null};
type Evidence = {session_id: string; target_title: string | null; goal_title: string | null; started_at: number; start: string; end: string; session_state: string};
type Span = {start: number; end: number; subject: StudySubject; measured: boolean; active: boolean; classAttendance?: boolean};

export function endsemDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: ENDSEM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
}
export function endsemHour(now: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', {timeZone: ENDSEM_TIME_ZONE, hour: '2-digit', hourCycle: 'h23'}).format(now));
}
function midnight(date: string): number { return Date.parse(`${date}T00:00:00+05:30`); }
function subjectFor(title: string): StudySubject | null {
  const probability = /\bprobability\b/i.test(title);
  const adsa = /\badsa\b/i.test(title);
  return probability === adsa ? null : probability ? 'probability' : 'adsa';
}
function loadConfig(): Config {
  return getDb().prepare('SELECT * FROM endsem_config WHERE id = 1').get() as Config;
}

// Lightweight context shared by agents/planner/Guardian. Do not infer study
// progress from generic productivity or repeat an old narrative as evidence.
export function getEndsemDirective(now = new Date()): string | null {
  const date = endsemDate(now);
  if(date<'2026-10-21' || date>ENDSEM_END) return null;
  const config = loadConfig();
  const probabilityDone = date>'2026-11-10' || (!!config.probability_finished_at && config.probability_finished_at<=now.toISOString());
  const period=getStudyWindow(now);
  if(period.anchor!==null)return `ENDSEM COMMITMENT: eight hours of actual Probability/ADSA study per consecutive 24-hour window, through 13 November 2026 IST. Current window: ${new Date(period.start).toISOString()} to ${new Date(period.end).toISOString()}; no midnight reset. Probability exam: 10 November; ADSA: 13 November. ${probabilityDone?'Prioritize ADSA.':'Prioritize both exams, Probability first.'} Calendar entries are provisional commitments, not attendance evidence or immutable rules: honor explicit skips and unplanned obligations, then rebalance. Protect declared sleep and expected returns. Never infer study credit from a calendar, return message, or vague claim about studying overnight; use the ledger and explicit actual intervals. Keep the eight-hour target unchanged. ${config.paused?'Prompts are paused.':''}`;
  return `ENDSEM COMMITMENT (explicitly agreed by Rohan): 480 minutes (8 hours) of actual study every day, 22 October through 13 November 2026 inclusive, Asia/Kolkata. Probability endsem: 10 November 2026. ADSA endsem: 13 November 2026. These are the highest priorities. ${probabilityDone?'Probability is finished; ADSA is now the sole exam priority.':'Protect both subjects; Probability is the nearest exam. Do not invent exam start/end times.'} Use firm, concrete next study actions and the existing Guardian workflow. Adapt block size and breaks, but do not silently reduce the eight-hour daily target. Breaks/distractions do not count; paper logs are explicitly self-reported. Do not invent hours studied from generic activity; the Endsem counter is the source of truth. ${config.paused?'Accountability prompts are paused by the user; respect that.':''}`;
}

// Select exactly the same pipeline as Guardian: authoritative finalized slices,
// otherwise counted legacy intervals. Shadow slices are comparison data only.
function loadSpans(now: Date): Span[] {
  const db = getDb();
  const lower = new Date(midnight(ENDSEM_START)).toISOString();
  const upper = new Date(Math.min(now.getTime(), midnight(ENDSEM_END) + 86_400_000)).toISOString();
  if (upper <= lower) return [];
  const rows = db.prepare(`
    SELECT s.session_id,s.target_title,s.goal_title,s.started_at,s.state AS session_state,
      i.observed_start AS start,i.observed_end AS end
    FROM session_activity_intervals i JOIN guardian_sessions s ON s.session_id = i.session_id
    WHERE s.evidence_pipeline_mode != 'authoritative'
      AND i.observed_end > ? AND i.observed_start < ?
      AND i.counted = 1 AND i.score_eligible = 1 AND i.state = 'active'
      AND i.category = 'productive' AND i.source IN ('chrome','vision')
      AND i.engagement_state IN ('interactive','passive_engaged','confirmed_active')
    UNION ALL
    SELECT s.session_id,s.target_title,s.goal_title,s.started_at,s.state,
      i.slice_start,i.slice_end
    FROM guardian_activity_slices i JOIN guardian_sessions s ON s.session_id = i.session_id
    WHERE s.evidence_pipeline_mode = 'authoritative' AND i.pipeline_mode = 'authoritative'
      AND i.provisional = 0 AND i.slice_end > ? AND i.slice_start < ?
      AND i.counted = 1 AND i.score_eligible = 1 AND i.state = 'active'
      AND i.category = 'productive' AND i.source IN ('chrome','vision')
      AND i.engagement_state IN ('interactive','passive_engaged','confirmed_active')
  `).all(lower,upper,lower,upper) as Evidence[];
  const spans: Span[] = [];
  for (const row of rows) {
    // The specific session title wins over a broader goal. Ambiguous sessions
    // do not guess which exam the time belongs to.
    const subject = subjectFor(row.target_title || '') || (!row.target_title ? subjectFor(row.goal_title || '') : null);
    const start = Math.max(Date.parse(row.start), Number(row.started_at), midnight(ENDSEM_START));
    const end = Math.min(Date.parse(row.end), now.getTime(), midnight(ENDSEM_END) + 86_400_000);
    if (subject && Number.isFinite(start) && end > start) {
      spans.push({start,end,subject,measured:true,active:row.session_state === 'ACTIVE'});
    }
  }
  const paper = db.prepare('SELECT subject,started_at,ended_at FROM endsem_paper_logs WHERE ended_at > ? AND started_at < ?')
    .all(lower,upper) as Array<{subject: StudySubject; started_at: string; ended_at: string}>;
  for (const log of paper) spans.push({start:Date.parse(log.started_at),end:Math.min(Date.parse(log.ended_at),now.getTime()),subject:log.subject,measured:false,active:false});
  const attendance = db.prepare('SELECT subject,attended_start,attended_end FROM study_class_attendance WHERE attended_end > ? AND attended_start < ?').all(lower,upper) as Array<{subject:StudySubject;attended_start:string;attended_end:string}>;
  for (const entry of attendance) spans.push({start:Date.parse(entry.attended_start),end:Math.min(Date.parse(entry.attended_end),now.getTime()),subject:entry.subject,measured:false,active:false,classAttendance:true});
  // Measured evidence has priority over self-reports when both cover a period.
  return spans.sort((a,b)=>Number(b.measured)-Number(a.measured) || a.start-b.start || a.subject.localeCompare(b.subject));
}

// Add the uncovered edges only. This also prevents two collectors, overlapping
// sessions, retries or paper logs from counting the same minute twice.
function creditDay(spans: Span[], start: number, end: number) {
  const covered: Array<[number,number]> = [];
  const totals = {measuredSeconds:0,selfReportedSeconds:0,classSeconds:0,subjectSeconds:{probability:0,adsa:0}};
  for (const span of spans) {
    const a = Math.max(start,span.start), b = Math.min(end,span.end);
    if (b <= a) continue;
    let cursor = a, milliseconds = 0;
    for (const [x,y] of covered) {
      if (y <= cursor) continue;
      if (x >= b) break;
      milliseconds += Math.max(0,Math.min(x,b)-cursor);
      cursor = Math.max(cursor,y);
      if (cursor >= b) break;
    }
    milliseconds += Math.max(0,b-cursor);
    const seconds = milliseconds/1000;
    totals[span.measured ? 'measuredSeconds' : 'selfReportedSeconds'] += seconds;
    if (span.classAttendance) totals.classSeconds += seconds;
    totals.subjectSeconds[span.subject] += seconds;
    covered.push([a,b]);
    covered.sort((x,y)=>x[0]-y[0]);
    const merged: Array<[number,number]> = [];
    for (const range of covered) {
      const previous = merged[merged.length-1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1],range[1]);
      else merged.push([...range]);
    }
    covered.splice(0,covered.length,...merged);
  }
  return totals;
}

export function getEndsemState(now = new Date()): EndsemState {
  const db = getDb(), config = loadConfig(), period = getStudyWindow(now), date = period.key, calendarDate=endsemDate(now);
  const hours = JSON.parse(config.checkpoint_hours) as number[];
  const spans = loadSpans(now);
  const responses = db.prepare('SELECT * FROM endsem_days').all() as DayRow[];
  function day(key: string): EndsemDay {
    const response = responses.find(r=>r.date===key);
    const delayResolved = response?.delay_until && spans.some(span=>span.end>Date.parse(response.delay_until!)-10*60_000 && span.start<midnight(key)+86_400_000 && span.end>midnight(key));
    const anchored=period.anchor!==null && key>=studyCalendarDate(new Date(period.anchor));
    const start = !anchored?midnight(key):period.anchor! + Math.round((midnight(key)-midnight(studyCalendarDate(new Date(period.anchor!))))/86400000)*86400000;
    const end = Math.min(start+86400000,midnight(ENDSEM_END)+86400000);
    const totals = creditDay(spans,start,end);
    const totalSeconds = totals.measuredSeconds+totals.selfReportedSeconds;
    const expectedSeconds = anchored ? Math.min(ENDSEM_TARGET_SECONDS,Math.max(0,(now.getTime()-start)/86400000*ENDSEM_TARGET_SECONDS)) : key < date ? ENDSEM_TARGET_SECONDS : key > date ? 0 : hours.filter(h=>endsemHour(now)>=h).length*7200;
    return {date:key,...totals,totalSeconds,remainingSeconds:Math.max(0,ENDSEM_TARGET_SECONDS-totalSeconds),expectedSeconds,
      status:start>now.getTime()?'upcoming':totalSeconds>=ENDSEM_TARGET_SECONDS?'complete':end<=now.getTime()?'missed':totalSeconds<expectedSeconds?'behind':'on_track',
      delayUntil:delayResolved?null:response?.delay_until || null,delayCount:response?.delay_count || 0,blocker:response?.blocker || null,
      review:response?.review || null,nextStartAt:response?.next_start_at || null};
  }
  const days: EndsemDay[] = [];
  if(period.anchor!==null)for(let t=midnight(ENDSEM_START);t<midnight(studyCalendarDate(new Date(period.anchor)));t+=86400000)days.push(day(endsemDate(new Date(t))));
  for (let t=period.anchor??midnight(ENDSEM_START);t<midnight(ENDSEM_END)+86400000;t+=86_400_000) days.push(day(endsemDate(new Date(t))));
  const measured = spans.filter(s=>s.measured && s.active && s.end>now.getTime()-120_000 && s.start<=now.getTime());
  const client = db.prepare('SELECT last_seen_at,screen_recording_status,capture_capable FROM native_client_status ORDER BY last_seen_at DESC LIMIT 1').get() as {last_seen_at:string; screen_recording_status:string; capture_capable:number} | undefined;
  const latest = db.prepare('SELECT message FROM endsem_events WHERE date = ? ORDER BY created_at DESC LIMIT 1').get(date) as {message:string} | undefined;
  const delivered = db.prepare('SELECT MAX(telegram_sent_at) AS at FROM endsem_events').get() as {at:string|null};
  const nextStart = responses.map(r=>r.next_start_at).filter((at):at is string=>!!at && endsemDate(new Date(at))===date).sort()[0] || null;
  return {date,timeZone:ENDSEM_TIME_ZONE,startDate:ENDSEM_START,endDate:ENDSEM_END,targetSeconds:ENDSEM_TARGET_SECONDS,
    ...(period.anchor!==null?{window:{mode:'consecutive24' as const,startsAt:new Date(period.start).toISOString(),endsAt:new Date(period.end).toISOString()}}:{}),
    phase:calendarDate<ENDSEM_START?'setup':calendarDate>ENDSEM_END?'finished':'active',paused:config.paused===1,conversationalMode:config.conversational_mode===1,checkpointHours:hours,
    nextSubject:calendarDate>'2026-11-10' || (config.probability_finished_at && config.probability_finished_at<=now.toISOString())?'adsa':'probability',
    probabilityFinishedAt:config.probability_finished_at,exams:[{subject:'probability',date:'2026-11-10'},{subject:'adsa',date:'2026-11-13'}],
    today:day(date),days,activeStudy:measured.length>0,
    telegramConfigured:!!((process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token')) && (process.env.TELEGRAM_CHAT_ID || getSetting('telegram_chat_id'))),
    telegramEnabled:getSetting('telegram_enabled')!=='false',
    collectorReady:!!client && client.capture_capable===1 && client.screen_recording_status==='authorized' && now.getTime()-Date.parse(client.last_seen_at)<60_000,
    lastTelegramSentAt:delivered.at,latestPrompt:latest?.message || null,nextCommittedStartAt:nextStart};
}

function text(value: unknown, name: string, max = 1000): string {
  if (typeof value!=='string' || !value.trim() || value.trim().length>max) throw new EndsemInputError(`${name} is required (up to ${max} characters).`);
  return value.trim();
}
function dateInput(value: unknown, name: string): number {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new EndsemInputError(`${name} must include a valid date, time and timezone.`);
  return Date.parse(value);
}

export function recordEndsemAction(input: Record<string,unknown>, now = new Date()): void {
  const db = getDb(), date = endsemDate(now);
  if (input.action==='rolling_window') {
    if(date<ENDSEM_START || date>ENDSEM_END)throw new EndsemInputError('Study campaign is outside its active dates.');
    const anchor=input.anchorAt?dateInput(input.anchorAt,'Window start'):now.getTime();
    const existing=getSetting('study_window_anchor_at');
    if(existing && Date.parse(existing)!==anchor && input.anchorAt)throw new EndsemInputError('The 24-hour anchor is already set; do not reset earned progress.');
    const start=existing?Date.parse(existing):anchor;
    if(start>now.getTime() || start<now.getTime()-86400000)throw new EndsemInputError('Choose the agreed window start within the last 24 hours.');
    const wake=dateInput(input.wakeAt,'Expected wake time');
    const end=Math.min(start+86400000,midnight(ENDSEM_END)+86400000);
    if(wake<=now.getTime() || wake>=end)throw new EndsemInputError('The expected wake time must be after now and before this window ends.');
    db.transaction(()=>{
      setSetting('study_window_anchor_at',new Date(start).toISOString());
      const key=getStudyWindow(now).key,stamp=now.toISOString();
      db.prepare('INSERT OR IGNORE INTO study_chat_days(date) VALUES(?)').run(key);
      db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=?,revision=revision+1,plan_json=NULL,calendar_json=NULL WHERE date=?').run(new Date(wake).toISOString(),new Date(end).toISOString(),key);
      const row=db.prepare('SELECT revision FROM study_chat_days WHERE date=?').get(key) as {revision:number};
      const previous=db.prepare("SELECT id FROM study_activities WHERE date=? AND title='Sleep' AND status IN ('pending','away') ORDER BY revision DESC LIMIT 1").get(key) as {id:string}|undefined;
      db.prepare("UPDATE study_activities SET status='returned' WHERE date=? AND status IN ('pending','away') AND id!=?").run(key,previous?.id||'');
      if(previous)db.prepare("UPDATE study_activities SET expected_return_at=?,status='away',revision=? WHERE id=?").run(new Date(wake).toISOString(),row.revision,previous.id);
      else db.prepare("INSERT INTO study_activities(id,date,kind,title,started_at,expected_return_at,status,revision) VALUES(?,?,'commitment','Sleep',?,?,'away',?)").run(randomUUID(),key,stamp,new Date(wake).toISOString(),row.revision);
      db.prepare('UPDATE study_chat_prompts SET resolved_at=? WHERE date=? AND resolved_at IS NULL').run(stamp,key);
      db.prepare('UPDATE endsem_config SET conversational_mode=1,paused=0 WHERE id=1').run();
      const label=(at:number)=>new Date(at).toLocaleString('en-IN',{timeZone:ENDSEM_TIME_ZONE,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      db.prepare("INSERT OR IGNORE INTO study_chat_turns(date,role,text,request_id,created_at) VALUES(?,'assistant',?,?,?)").run(key,`Your eight-hour target now runs in consecutive 24-hour windows: ${label(start)} to ${label(end)} IST. Midnight will not reset it. Sleep is protected until ${label(wake)} IST; I will check back then. Tell me when plans change, including skipped classes or unplanned commitments, and I will rebalance.`, `rolling-window:${new Date(start).toISOString()}`,stamp);
    })();return;
  }
  if (input.action==='checkpoints') {
    const hours = input.hours;
    if (!Array.isArray(hours) || hours.length!==4 || hours.some((h,i)=>!Number.isInteger(h) || h<8 || h>22 || (i>0 && h<=hours[i-1]))) throw new EndsemInputError('Choose four increasing checkpoint hours between 08 and 22 IST.');
    db.prepare('UPDATE endsem_config SET checkpoint_hours = ? WHERE id = 1').run(JSON.stringify(hours));
    return;
  }
  if (input.action==='pause' || input.action==='resume') {
    db.prepare('UPDATE endsem_config SET paused = ? WHERE id = 1').run(input.action==='pause'?1:0); return;
  }
  if (input.action==='probability_finished') {
    if (date<'2026-11-10' || date>ENDSEM_END) throw new EndsemInputError('Mark Probability finished on or after its 10 November exam.');
    db.prepare('UPDATE endsem_config SET probability_finished_at = ? WHERE id = 1').run(now.toISOString()); return;
  }
  if (input.action==='paper') {
    const requestId = text(input.requestId,'Request ID',150), notes = text(input.notes,'Work notes');
    if (input.subject!=='probability' && input.subject!=='adsa') throw new EndsemInputError('Choose Probability or ADSA.');
    const start = dateInput(input.startedAt,'Start'), end = dateInput(input.endedAt,'End');
    if (start<midnight(ENDSEM_START) || end>midnight(ENDSEM_END)+86_400_000 || end>now.getTime() || end<=start || end-start>4*60*60_000) throw new EndsemInputError('Log an actual past study interval within the campaign, up to four hours per entry.');
    const existing = db.prepare('SELECT * FROM endsem_paper_logs WHERE request_id = ?').get(requestId) as {subject:string; started_at:string; ended_at:string; notes:string} | undefined;
    if (existing && (existing.subject!==input.subject || existing.started_at!==new Date(start).toISOString() || existing.ended_at!==new Date(end).toISOString() || existing.notes!==notes)) throw new EndsemInputError('This request ID already belongs to a different paper entry.');
    db.prepare('INSERT OR IGNORE INTO endsem_paper_logs(request_id,subject,started_at,ended_at,notes,created_at) VALUES(?,?,?,?,?,?)').run(requestId,input.subject,new Date(start).toISOString(),new Date(end).toISOString(),notes,now.toISOString()); return;
  }
  if (date<ENDSEM_START || date>ENDSEM_END) throw new EndsemInputError('Daily actions are available from 22 October through 13 November.');
  if (input.action==='delay') {
    db.prepare('INSERT INTO endsem_days(date,delay_until,delay_count) VALUES(?,?,1) ON CONFLICT(date) DO UPDATE SET delay_until=excluded.delay_until,delay_count=delay_count+1').run(getStudyWindow(now).key,new Date(now.getTime()+10*60_000).toISOString()); return;
  }
  if (input.action==='blocker') {
    const blocker = text(input.text,'Blocker');
    db.prepare('INSERT INTO endsem_days(date,blocker) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET blocker=excluded.blocker').run(getStudyWindow(now).key,blocker); return;
  }
  if (input.action==='review') {
    const review = text(input.text,'Reflection');
    const next = input.nextStartAt ? dateInput(input.nextStartAt,'Next start') : null;
    if (date<ENDSEM_END && (next===null || endsemDate(new Date(next))!==endsemDate(new Date(midnight(date)+86_400_000)) || next<=now.getTime() || endsemHour(new Date(next))<8 || endsemHour(new Date(next))>=23)) throw new EndsemInputError('Choose tomorrow’s first start between 08:00 and 23:00 IST.');
    db.prepare('INSERT INTO endsem_days(date,review,next_start_at) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET review=excluded.review,next_start_at=excluded.next_start_at').run(date,review,next===null?null:new Date(next).toISOString()); return;
  }
  throw new EndsemInputError('Unsupported study action.');
}
