'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('remaining study day planning', () => {
  let env, db, planner;
  const now = new Date('2026-10-22T06:30:00Z'); // noon IST
  const fresh = {status:'fresh',events:[],syncedAt:now.toISOString(),warning:null};
  const originalFetch = global.fetch;
  const google = require('googleapis').google;
  const originalGoogleCalendar = google.calendar;
  beforeEach(() => {
    env = createIsolatedDb('lifeos-study-plan-'); db = env.db;
    planner = env.requireLib('study-day-planning.ts');
    db.prepare('INSERT INTO study_chat_days(date,revision,day_end_at) VALUES(?,?,?)').run('2026-10-22',1,'2026-10-22T17:30:00Z');
  });
  afterEach(() => { global.fetch = originalFetch; google.calendar = originalGoogleCalendar; });
  function run(extra={}) {return planner.rebalanceStudyDay({now,calendar:fresh,protectedIntervals:[],subject:'probability',revision:1,...extra});}
  function row(id,start,end,status='planned',owned=false,title='ADSA exercises') {
    db.prepare("INSERT OR IGNORE INTO daily_plans(plan_date) VALUES('2026-10-22')").run();
    const plan = db.prepare("SELECT id FROM daily_plans WHERE plan_date='2026-10-22'").get();
    db.prepare('INSERT INTO planned_focus_sessions(id,plan_id,title,planned_start,planned_end,duration_minutes,status,rule_json) VALUES(?,?,?,?,?,30,?,?)')
      .run(id,plan.id,title,start,end,status,JSON.stringify(owned?{studyChat:{date:'2026-10-22'}}:{}));
  }
  it('reserves class and chained lunch/travel, anticipating relevant classes without credit', () => {
    const calendar={...fresh,events:[{id:'p',title:'Probability class',subject:'probability',start:'2026-10-22T07:30:00Z',end:'2026-10-22T08:30:00Z'}]};
    const protectedIntervals=[{title:'Lunch',start:now.toISOString(),end:'2026-10-22T07:00:00Z'},{title:'Travel',start:'2026-10-22T07:00:00Z',end:'2026-10-22T07:30:00Z'}];
    const plan=run({calendar,protectedIntervals});
    assert.equal(plan.remainingSeconds,28800); assert.equal(plan.anticipatedClassMinutes,60);
    assert.ok(plan.sessions.every(s=>Date.parse(s.start)>=Date.parse('2026-10-22T08:30:00Z')));
    assert.equal(env.requireLib('endsem-study.ts').getEndsemState(now).today.totalSeconds,0);
  });
  it('requires an explicit day end and does not infer a default sleep time', () => {
    db.prepare('UPDATE study_chat_days SET day_end_at=NULL').run();
    const plan=run(); assert.equal(plan.sessions.length,0); assert.match(plan.needsInput,/end|sleep/i); assert.equal(plan.endAt,null);
  });
  it('does not treat stale or unconfigured calendar as empty free time', () => {
    for(const status of ['stale','unconfigured']) {
      const plan=run({calendar:{...fresh,status}});
      assert.equal(plan.sessions.length,0); assert.match(plan.needsInput,/calendar/i); assert.equal(plan.shortfallMinutes,480);
    }
  });
  it('preserves past, completed, active and non-owned future sessions while replacing only future owned work', () => {
    row('past','2026-10-22T05:00:00Z','2026-10-22T05:30:00Z','planned',true);
    row('done','2026-10-22T05:30:00Z','2026-10-22T06:00:00Z','completed',true);
    row('active','2026-10-22T06:00:00Z','2026-10-22T07:00:00Z','started',true);
    row('manual','2026-10-22T07:00:00Z','2026-10-22T08:00:00Z');
    row('replace','2026-10-22T08:00:00Z','2026-10-22T08:30:00Z','planned',true);
    const before=db.prepare("SELECT * FROM planned_focus_sessions WHERE id IN ('past','done','active','manual') ORDER BY id").all();
    const plan=run();
    assert.deepEqual(db.prepare("SELECT * FROM planned_focus_sessions WHERE id IN ('past','done','active','manual') ORDER BY id").all(),before);
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='replace'").get().status,'cancelled');
    const generated=plan.sessions.filter(s=>!['active','manual'].includes(s.id));
    assert.ok(generated.every(s=>Date.parse(s.start)>=Date.parse('2026-10-22T08:00:00Z')));
  });
  it('fills partial windows, reports infeasibility, and persists both subjects without a fixed hour ratio', () => {
    db.prepare("UPDATE study_chat_days SET day_end_at='2026-10-22T08:00:00Z'").run();
    const plan=run({protectedIntervals:[{title:'Meal',start:'2026-10-22T07:00:00Z',end:'2026-10-22T07:15:00Z'}]});
    assert.ok(plan.sessions.some(s=>s.durationMinutes===30));
    assert.deepEqual(new Set(plan.sessions.map(s=>s.subject)),new Set(['probability','adsa']));
    assert.ok(plan.shortfallMinutes>0); assert.match(plan.needsInput,/short|fit|window/i);
    assert.equal(plan.remainingSeconds,28800);
    assert.deepEqual(planner.readStudyDayPlan(now),plan);
    assert.equal(planner.readStudyDayPlan(new Date('2026-10-23T00:00:00Z')),null);
    const rows=db.prepare("SELECT rule_json,calendar_status FROM planned_focus_sessions WHERE status='planned'").all();
    assert.ok(rows.every(r=>JSON.parse(r.rule_json).studyChat && JSON.parse(r.rule_json).calendarSyncPending===true));
  });
  it('respects wake constraints and uses ADSA only after Probability is finished', () => {
    db.prepare("UPDATE study_chat_days SET wake_at='2026-10-22T08:30:00Z'").run();
    let plan=run({subject:'adsa'}); assert.equal(plan.sessions[0].subject,'adsa');
    assert.ok(plan.sessions.every(s=>Date.parse(s.start)>=Date.parse('2026-10-22T08:30:00Z')));
    db.prepare("UPDATE endsem_config SET probability_finished_at='2026-10-22T06:00:00Z'").run();
    plan=run(); assert.ok(plan.sessions.every(s=>s.subject==='adsa'));
  });
  it('deducts earned ledger time only, refuses stale revision and expires at campaign end', () => {
    env.requireLib('endsem-study.ts').recordEndsemAction({action:'paper',requestId:'paper',subject:'adsa',startedAt:'2026-10-22T05:00:00Z',endedAt:'2026-10-22T06:00:00Z',notes:'Exercises'},now);
    assert.equal(run().remainingSeconds,25200);
    assert.throws(()=>run({revision:0}),/revision/i);
    assert.equal(run({now:new Date('2026-11-13T18:30:00Z')}).sessions.length,0);
  });
  it('protects an actual active Guardian session and asks for its end when it runs late', () => {
    db.prepare("INSERT INTO guardian_sessions(session_id,target_title,started_at,duration_minutes,state) VALUES('live','ADSA',?,60,'ACTIVE')").run(Date.parse('2026-10-22T06:00:00Z'));
    assert.ok(run().sessions.every(s=>Date.parse(s.start)>=Date.parse('2026-10-22T07:00:00Z')));
    const late=run({now:new Date('2026-10-22T07:01:00Z')});
    assert.equal(late.sessions.length,0); assert.match(late.needsInput,/active.*end/i);
  });
  it('does not silently discard a started planned session after its nominal end', () => {
    row('late','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z','started',true);
    const plan=run(); assert.equal(plan.sessions.length,0); assert.match(plan.needsInput,/active.*end/i);
  });
  it('keeps the full break between generated sessions across a short fixed commitment', () => {
    row('old','2026-10-22T08:00:00Z','2026-10-22T08:30:00Z','planned',true);
    db.prepare("UPDATE planned_focus_sessions SET rule_json=? WHERE id='old'").run(JSON.stringify({studyChat:{date:'2026-10-22'},breakMinutes:10}));
    const plan=run({protectedIntervals:[{title:'Quick call',start:'2026-10-22T07:00:00Z',end:'2026-10-22T07:02:00Z'}]});
    for(let i=1;i<plan.sessions.length;i++) assert.ok(Date.parse(plan.sessions[i].start)-Date.parse(plan.sessions[i-1].end)>=10*60_000);
  });
  it('stale calendar reports uncertainty without cancelling existing future owned work', () => {
    row('keep','2026-10-22T08:00:00Z','2026-10-22T08:30:00Z','planned',true);
    run({calendar:{...fresh,status:'stale'}});
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='keep'").get().status,'planned');
  });
  it('uses anticipated classes toward future capacity without earning time or anticipating exams and focus blocks', () => {
    const events=[{id:'class',title:'Probability',start:'2026-10-22T08:00:00Z',end:'2026-10-22T09:00:00Z'},{id:'exam',title:'ADSA endsem exam',start:'2026-10-22T10:00:00Z',end:'2026-10-22T11:00:00Z'},{id:'focus',title:'Probability focus',start:'2026-10-22T12:00:00Z',end:'2026-10-22T13:00:00Z'}];
    const plan=run({calendar:{...fresh,events}});
    assert.equal(plan.anticipatedClassMinutes,60); assert.equal(plan.remainingSeconds,28800);
    assert.ok(plan.scheduledMinutes<=420); assert.match(plan.warning,/anticipated.*Attendance/i);
  });
  it('deduplicates the external mirror of owned sessions and keeps their subject tasks when moving them', () => {
    row('linked','2026-10-22T08:00:00Z','2026-10-22T09:00:00Z','planned',true,'Probability exercises');
    db.prepare("UPDATE planned_focus_sessions SET calendar_event_id='gcal-focus' WHERE id='linked'").run();
    const plan=run({calendar:{...fresh,events:[{id:'gcal-focus_2026-10-22T08:00:00Z',title:'Probability exercises',start:'2026-10-22T08:00:00Z',end:'2026-10-22T09:00:00Z'}]},protectedIntervals:[{title:'Lunch',start:'2026-10-22T08:00:00Z',end:'2026-10-22T08:15:00Z'}]});
    assert.ok(plan.sessions.some(s=>s.title==='Probability exercises'));
    assert.ok(plan.sessions.some(s=>Date.parse(s.start)<Date.parse('2026-10-22T09:00:00Z') && Date.parse(s.end)>Date.parse('2026-10-22T08:15:00Z')));
  });
  it('protects the fresh external time of a moved non-owned linked session', () => {
    row('manual-moved','2026-10-22T07:00:00Z','2026-10-22T08:00:00Z');
    db.prepare("UPDATE planned_focus_sessions SET calendar_event_id='external' WHERE id='manual-moved'").run();
    const event={id:'study_oauth:external',title:'ADSA study',start:'2026-10-22T09:00:00Z',end:'2026-10-22T10:00:00Z'};
    const plan=run({calendar:{...fresh,events:[event]}});
    assert.ok(plan.sessions.filter(s=>s.id!=='manual-moved').every(s=>Date.parse(s.end)<=Date.parse(event.start) || Date.parse(s.start)>=Date.parse(event.end)));
    assert.match(plan.needsInput,/moved|calendar|disagree/i);
    assert.equal(db.prepare("SELECT planned_start FROM planned_focus_sessions WHERE id='manual-moved'").get().planned_start,'2026-10-22T07:00:00Z');
  });
  it('counts an unchanged linked non-owned session once without manufacturing an extra study hour', () => {
    row('manual-unchanged','2026-10-22T07:00:00Z','2026-10-22T08:00:00Z','planned',false,'ADSA focus');
    db.prepare("UPDATE planned_focus_sessions SET calendar_event_id='external' WHERE id='manual-unchanged'").run();
    const before=db.prepare("SELECT * FROM planned_focus_sessions WHERE id='manual-unchanged'").get();
    const event={id:'study_oauth:external',title:'ADSA focus',start:'2026-10-22T07:00:00Z',end:'2026-10-22T08:00:00Z'};
    const plan=run({calendar:{...fresh,events:[event]}});
    assert.equal(plan.sessions.reduce((sum,s)=>sum+s.durationMinutes,0),480);
    assert.equal(plan.scheduledMinutes,480); assert.equal(plan.shortfallMinutes,0); assert.equal(plan.needsInput,null);
    assert.deepEqual(db.prepare("SELECT * FROM planned_focus_sessions WHERE id='manual-unchanged'").get(),before);
  });
  it('uses conservative whole planned minutes near a class end while preserving exact earned seconds', () => {
    const at=new Date('2026-10-22T06:34:50.600Z');
    env.requireLib('endsem-study.ts').recordEndsemAction({action:'paper',requestId:'seconds',subject:'adsa',startedAt:'2026-10-22T05:59:00Z',endedAt:'2026-10-22T05:59:29Z',notes:'A completed paper problem'},at);
    const event={id:'class-tail',title:'Probability',start:'2026-10-22T06:00:00Z',end:'2026-10-22T06:50:00Z'};
    const plan=run({now:at,calendar:{...fresh,events:[event]}});
    assert.equal(plan.remainingSeconds,28771); assert.equal(plan.anticipatedClassMinutes,15);
    assert.equal(plan.scheduledMinutes,465); assert.equal(plan.shortfallMinutes,0);
    assert.ok(plan.sessions.every(s=>Number.isInteger(s.durationMinutes)));
    assert.match(plan.warning,/^15 class minutes/);
    assert.equal(env.requireLib('endsem-study.ts').getEndsemState(at).today.totalSeconds,29);
    assert.ok((plan.scheduledMinutes+plan.anticipatedClassMinutes)*60>=plan.remainingSeconds);
  });
  it('rounds retained partial capacity down without turning seconds into a conflict or shorter study target', () => {
    row('partial-started','2026-10-22T06:00:00Z','2026-10-22T07:00:00Z','started',false,'ADSA focus');
    const plan=run({now:new Date('2026-10-22T06:30:00.500Z')});
    assert.ok(plan.sessions.every(s=>Number.isInteger(s.durationMinutes)));
    assert.equal(plan.scheduledMinutes,480); assert.equal(plan.sessions.reduce((sum,s)=>sum+s.durationMinutes,0),480);
    assert.equal(plan.needsInput,null); assert.equal(plan.remainingSeconds,28800);
  });
  it('reuses the current session duration preference and task link when moving study', () => {
    const task=Number(db.prepare("INSERT INTO tasks(title,status) VALUES('Probability proofs','todo')").run().lastInsertRowid);
    row('pref','2026-10-22T08:00:00Z','2026-10-22T08:30:00Z','planned',true,'Probability proofs');
    db.prepare("UPDATE planned_focus_sessions SET task_id=?,rule_json=? WHERE id='pref'").run(task,JSON.stringify({studyChat:{date:'2026-10-22'},preferredMinutes:20,breakMinutes:7}));
    const plan=run(); assert.ok(plan.sessions.every(s=>s.durationMinutes<=20));
    assert.ok(db.prepare("SELECT * FROM planned_focus_sessions WHERE status='planned' AND title='Probability proofs'").all().every(r=>r.task_id===task));
  });
  it('invalidates known meal conflicts even when the calendar is stale', () => {
    row('meal-conflict','2026-10-22T08:00:00Z','2026-10-22T09:00:00Z','planned',true);
    const plan=run({calendar:{...fresh,status:'stale'},protectedIntervals:[{title:'Lunch',start:'2026-10-22T08:00:00Z',end:'2026-10-22T09:00:00Z'}]});
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='meal-conflict'").get().status,'cancelled');
    assert.equal(plan.scheduledMinutes,0); assert.match(plan.warning,/unverified/i);
  });
  it('does not treat a non-owned session overlapping a class as extra study capacity', () => {
    row('manual-conflict','2026-10-22T07:00:00Z','2026-10-22T08:00:00Z');
    const plan=run({calendar:{...fresh,events:[{id:'class',title:'Probability',start:'2026-10-22T07:00:00Z',end:'2026-10-22T08:00:00Z'}]}});
    const generated=plan.sessions.filter(s=>s.id!=='manual-conflict');
    assert.equal(plan.scheduledMinutes,generated.reduce((sum,s)=>sum+s.durationMinutes,0));
    assert.match(plan.needsInput,/conflict|overlap/i);
    assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='manual-conflict'").get().status,'planned');
  });
  it('successfully refreshes an empty ICS mirror and reuses its freshness without fetching again', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    let calls=0;
    global.fetch=async (_url,options)=>{calls++; assert.ok(!options.method || options.method==='GET'); return new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',{status:200});};
    const actualNow=new Date();
    assert.equal((await planner.refreshStudyCalendar(actualNow)).status,'fresh');
    assert.equal((await planner.refreshStudyCalendar(new Date())).status,'fresh');
    assert.equal(calls,1);
  });
  it('reports failed or malformed calendar refresh as stale and never claims empty free time', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    global.fetch=async()=>new Response('not a calendar',{status:200});
    assert.equal((await planner.refreshStudyCalendar(new Date())).status,'stale');
    global.fetch=async()=>new Response('',{status:503});
    assert.equal((await planner.refreshStudyCalendar(new Date())).status,'stale');
  });
  it('fails closed before mutating the mirror for unsupported timed ICS zones', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    db.prepare("INSERT INTO calendar_events(id,title,start_time,end_time,synced_at) VALUES('existing','Keep current mirror','2026-10-22T10:00:00Z','2026-10-22T11:00:00Z','2026-10-22T06:00:00Z')").run();
    const before=db.prepare('SELECT * FROM calendar_events').all();
    global.fetch=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:london\r\nSUMMARY:Probability\r\nDTSTART;TZID=Europe/London:20261022T120000\r\nDTEND;TZID=Europe/London:20261022T130000\r\nEND:VEVENT\r\nEND:VCALENDAR',{status:200});
    const snapshot=await planner.refreshStudyCalendar(now);
    assert.equal(snapshot.status,'stale'); assert.equal(env.requireLib('db.ts').getSetting('calendar_ics_last_success_at'),'');
    assert.deepEqual(db.prepare('SELECT * FROM calendar_events').all(),before);
    assert.equal(run({calendar:snapshot}).sessions.length,0);
  });
  for(const recurrence of ['RDATE:20261022T110000Z','EXDATE:20261022T110000Z','RECURRENCE-ID:20261022T110000Z']) {
    it(`rejects unsupported ICS ${recurrence.split(':')[0]} occurrence semantics before marking fresh`, async () => {
      env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
      global.fetch=async()=>new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:recurring\r\nSUMMARY:Probability\r\nDTSTART:20261020T110000Z\r\nDTEND:20261020T120000Z\r\n${recurrence}\r\nEND:VEVENT\r\nEND:VCALENDAR`,{status:200});
      const snapshot=await planner.refreshStudyCalendar(now);
      assert.equal(snapshot.status,'stale'); assert.equal(db.prepare('SELECT COUNT(*) n FROM calendar_events').get().n,0);
      assert.equal(run({calendar:snapshot}).sessions.length,0);
    });
  }
  it('rejects local-time RRULE expansion rather than shifting an IST BYDAY occurrence across midnight', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    global.fetch=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:local-weekly\r\nSUMMARY:Probability\r\nDTSTART;TZID=Asia/Kolkata:20261020T003000\r\nDTEND;TZID=Asia/Kolkata:20261020T013000\r\nRRULE:FREQ=WEEKLY;BYDAY=TU\r\nEND:VEVENT\r\nEND:VCALENDAR',{status:200});
    assert.equal((await planner.refreshStudyCalendar(now)).status,'stale');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM calendar_events').get().n,0);
  });
  it('falls back to the complete OAuth read when ICS uses unsupported semantics', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    env.setSetting('google_calendar_refresh_token','test-read-token');
    global.fetch=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:london\r\nSUMMARY:Probability\r\nDTSTART;TZID=Europe/London:20261022T120000\r\nDTEND;TZID=Europe/London:20261022T130000\r\nEND:VEVENT\r\nEND:VCALENDAR',{status:200});
    google.calendar=()=>({events:{list:async()=>({data:{items:[{id:'class',summary:'Probability',start:{dateTime:'2026-10-22T12:00:00+01:00'},end:{dateTime:'2026-10-22T13:00:00+01:00'}}]}})}});
    const snapshot=await planner.refreshStudyCalendar(now);
    assert.equal(snapshot.status,'fresh'); assert.equal(snapshot.events[0].start,'2026-10-22T11:00:00.000Z');
    assert.ok(run({calendar:snapshot}).sessions.every(s=>Date.parse(s.end)<=Date.parse('2026-10-22T11:00:00Z') || Date.parse(s.start)>=Date.parse('2026-10-22T12:00:00Z')));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE id LIKE 'london_%'").get().n,0);
  });
  it('imports a long nonrecurring commitment that starts before the mirror window and protects today', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    const current=new Date(), date=env.requireLib('endsem-study.ts').endsemDate(current);
    const previous=new Date(current.getTime()-20*86400000).toISOString().slice(0,10).replaceAll('-','');
    const later=new Date(current.getTime()+5*86400000).toISOString().slice(0,10).replaceAll('-','');
    global.fetch=async()=>new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:long\r\nSUMMARY:Family commitment\r\nDTSTART;VALUE=DATE:${previous}\r\nDTEND;VALUE=DATE:${later}\r\nEND:VEVENT\r\nEND:VCALENDAR`,{status:200});
    const snapshot=await planner.refreshStudyCalendar(current);
    assert.equal(snapshot.status,'fresh'); assert.equal(snapshot.events.length,1);
    const studyNow=new Date(`${date}T12:00:00+05:30`);
    db.prepare('INSERT INTO study_chat_days(date,revision,day_end_at) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET revision=1,day_end_at=excluded.day_end_at').run(date,1,`${date}T23:00:00+05:30`);
    assert.equal(run({now:studyNow,calendar:snapshot}).sessions.length,0);
    // A later empty sync must also remove the long overlapping commitment.
    global.fetch=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',{status:200});
    await env.requireLib('calendar.ts').syncCalendarFromICS();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE id LIKE 'long_%'").get().n,0);
  });
  it('uses complete paginated OAuth reads as a fallback and never invokes calendar writes', async () => {
    env.setSetting('google_calendar_refresh_token','test-read-token');
    let reads=0;
    google.calendar=()=>({events:{list:async(options)=>{
      reads++; assert.equal(options.singleEvents,true);
      if(!options.pageToken) return {data:{nextPageToken:'page2',items:[{id:'class',summary:'Probability',start:{dateTime:'2026-10-22T07:00:00Z'},end:{dateTime:'2026-10-22T08:00:00Z'}}]}};
      return {data:{items:[{id:'holiday',summary:'Family commitment',start:{date:'2026-10-21'},end:{date:'2026-10-23'}}]}};
    }}});
    const snapshot=await planner.refreshStudyCalendar(now);
    assert.equal(snapshot.status,'fresh'); assert.equal(reads,2); assert.equal(snapshot.events.length,2);
    assert.equal(snapshot.events[0].kind,'class'); assert.equal(snapshot.events[0].subject,'probability');
    assert.equal(snapshot.events[1].start,'2026-10-20T18:30:00.000Z');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM calendar_events WHERE id LIKE 'study_oauth:%'").get().n,2);
    google.calendar=()=>({events:{list:async()=>{throw new Error('offline');}}});
    assert.equal((await planner.refreshStudyCalendar(now)).status,'stale');
  });
  it('treats an all-day ICS event without DTEND as one full IST day', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    const current=new Date(), date=env.requireLib('endsem-study.ts').endsemDate(current);
    global.fetch=async()=>new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:all-day\r\nSUMMARY:Family event\r\nDTSTART;VALUE=DATE:${date.replaceAll('-','')}\r\nEND:VEVENT\r\nEND:VCALENDAR`,{status:200});
    const snapshot=await planner.refreshStudyCalendar(current);
    assert.equal(snapshot.status,'fresh'); assert.equal(snapshot.events.length,1);
    assert.equal(Date.parse(snapshot.events[0].end)-Date.parse(snapshot.events[0].start),86400000);
  });
  it('parses SQLite and ISO sync timestamps and protects multi-day all-day events', async () => {
    env.setSetting('calendar_ics_url','https://example.invalid/private.ics');
    env.setSetting('calendar_ics_last_success_source',require('node:crypto').createHash('sha256').update('https://example.invalid/private.ics').digest('hex'));
    for(const stamp of ['2026-10-22 06:29:00','2026-10-22T06:29:00.000Z']) {
      env.setSetting('calendar_ics_last_success_at',stamp);
      db.prepare("INSERT OR REPLACE INTO calendar_events(id,title,start_time,end_time,synced_at) VALUES('all','Family event','2026-10-21T18:30:00Z','2026-10-23T18:30:00Z',?)").run(stamp);
      global.fetch=async()=>{throw new Error('fresh mirror should avoid network');};
      const snapshot=await planner.refreshStudyCalendar(now);
      assert.equal(snapshot.status,'fresh'); assert.equal(snapshot.events.length,1);
      assert.equal(run({calendar:snapshot}).scheduledMinutes,0);
    }
  });
});
