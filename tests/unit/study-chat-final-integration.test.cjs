'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
const noon=Date.parse('2026-10-22T06:30:00Z');
const probability={id:'p',title:'Probability',subject:'probability',kind:'class',start:'2026-10-22T04:30:00Z',end:'2026-10-22T05:30:00Z'};
function setup(t,events=[]){
 t.mock.timers.enable({apis:['Date'],now:noon});
 t.mock.method(global,'fetch',async()=>{throw new Error('External network forbidden in integration fixture');});
 const env=createIsolatedDb('lifeos-final-integration-');
 env.requireLib('ai.ts').tryGetGenAI=()=>null;
 const chat=env.requireLib('study-chat.ts');let request=0;
 return {...env,chat,send:(message,revision,interpret=async()=>null)=>chat.processStudyChatMessage({date:'2026-10-22',message,revision,requestId:`final-${++request}`},{now:new Date(),calendar:async at=>({status:'fresh',events,syncedAt:at.toISOString(),warning:null}),interpret})};
}
it('elapsed unstarted proposals rebalance around lunch and accepted ADSA starts exactly one linked Guardian block',async t=>{
 const events=[],{db,send,requireLib}=setup(t,events);
 process.env.LIFEOS_REQUIRE_VISION_CLIENT='true';
 const heartbeat=()=>requireLib('guardian-client-status.ts').recordNativeClientHeartbeat({deviceId:'final-ready',clientVersion:'0.3.0',screenRecordingStatus:'authorized',captureCapable:true,frontmostApp:'Preview',systemState:'active'});
 try {
  let s=await send('I wake at 08:00 and sleep at 23:00',0);
  const first=db.prepare('SELECT * FROM planned_focus_sessions WHERE id=?').get(s.plan.sessions[0].id);
  db.prepare('UPDATE planned_focus_sessions SET calendar_event_id=? WHERE id=?').run('original-mirror',first.id);
  events.push({id:'original-mirror',title:first.title,kind:'commitment',start:first.planned_start,end:first.planned_end});
  t.mock.timers.tick(6*60_000);
  s=await send('lunch for 20 minutes',s.revision);
  const cancelled=db.prepare('SELECT * FROM planned_focus_sessions WHERE id=?').get(first.id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.invalidated_reason,'study_chat_rebalance');
  assert.equal(cancelled.planned_start,first.planned_start);assert.equal(cancelled.planned_end,first.planned_end);
  assert.equal(cancelled.invalidated_at,new Date().toISOString());
  assert.ok(s.plan.sessions.every(x=>Date.parse(x.end)<=noon+6*60_000 || Date.parse(x.start)>=noon+26*60_000));
  assert.doesNotMatch(s.reply,/existing session overlaps/i);
  t.mock.timers.tick(4*60_000);s=await send("I'm back",s.revision);
  t.mock.timers.tick(60_000);s=await send('make it ADSA instead',s.revision);
  assert.equal(s.plan.sessions[0].subject,'adsa');assert.equal(s.plan.sessions[0].start,new Date().toISOString());
  t.mock.timers.tick(60_000);heartbeat();s=await send('yes',s.revision);
  const sessions=db.prepare('SELECT * FROM guardian_sessions').all();assert.equal(sessions.length,1,s.reply);
  assert.equal(sessions[0].state,'ACTIVE');assert.match(sessions[0].target_title,/ADSA/);
  const blocks=db.prepare("SELECT * FROM planned_focus_sessions WHERE status='started'").all();assert.equal(blocks.length,1);
  assert.match(blocks[0].title,/ADSA/);
  const link=db.prepare('SELECT source_id FROM coaching_commitments WHERE session_id=?').get(sessions[0].session_id);
  assert.equal(link.source_id,blocks[0].id);assert.match(s.reply,/Guardian started for ADSA/);assert.equal(s.measuredSeconds,0);
 } finally {
  for(const row of db.prepare("SELECT session_id FROM guardian_sessions WHERE state IN ('ACTIVE','BREAK')").all())requireLib('guardian-runtime.ts').endGuardianSession(row.session_id);
  delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;
 }
});
it('elapsed replacement preserves fully past, completed, started, manual rows and actual active Guardian capacity',t=>{
 const {db,requireLib}=setup(t),planner=requireLib('study-day-planning.ts');
 db.prepare("INSERT INTO study_chat_days(date,revision,day_end_at) VALUES('2026-10-22',1,'2026-10-22T17:30:00Z')").run();
 db.prepare("INSERT INTO daily_plans(plan_date) VALUES('2026-10-22')").run();const plan=db.prepare('SELECT id FROM daily_plans').get();
 const insert=(id,start,end,status,owned)=>db.prepare('INSERT INTO planned_focus_sessions(id,plan_id,title,planned_start,planned_end,duration_minutes,status,rule_json) VALUES(?,?,?,?,?,30,?,?)').run(id,plan.id,'ADSA exercises',start,end,status,JSON.stringify(owned?{studyChat:{date:'2026-10-22'}}:{}));
 insert('past','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z','planned',true);
 insert('done','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z','completed',true);
 insert('started','2026-10-22T06:00:00Z','2026-10-22T07:00:00Z','started',true);
 insert('manual','2026-10-22T07:30:00Z','2026-10-22T08:00:00Z','planned',false);
 insert('missed','2026-10-22T06:25:00Z','2026-10-22T07:00:00Z','planned',true);
 db.prepare("INSERT INTO guardian_sessions(session_id,target_title,started_at,duration_minutes,state) VALUES('real-active','ADSA',?,60,'ACTIVE')").run(Date.parse('2026-10-22T06:30:00Z'));
 const before=db.prepare("SELECT * FROM planned_focus_sessions WHERE id!='missed' ORDER BY id").all(),active=db.prepare('SELECT * FROM guardian_sessions').all();
 const p=planner.rebalanceStudyDay({now:new Date(),calendar:{status:'fresh',events:[],syncedAt:new Date().toISOString(),warning:null},protectedIntervals:[],subject:'probability',revision:1});
 assert.equal(db.prepare("SELECT status FROM planned_focus_sessions WHERE id='missed'").get().status,'cancelled');
 assert.deepEqual(db.prepare("SELECT * FROM planned_focus_sessions WHERE id IN ('past','done','started','manual') ORDER BY id").all(),before);
 assert.deepEqual(db.prepare('SELECT * FROM guardian_sessions').all(),active);
 assert.ok(p.sessions.filter(x=>!['started','manual'].includes(x.id)).every(x=>Date.parse(x.start)>=Date.parse('2026-10-22T08:00:00Z')));
});
for(const disjoint of [false,true])it(`explicit attendance subject correction stores ADSA occurrence with ${disjoint?'disjoint':'overlapping'} class times`,async t=>{
 const p=disjoint?{...probability,start:'2026-10-22T03:30:00Z',end:'2026-10-22T04:30:00Z'}:probability;
 const adsa={...probability,id:'a',title:'ADSA',subject:'adsa'}, {send,db}=setup(t,[p,adsa]);
 let s=await send('I attended Probability',0);assert.match(s.pendingQuestion,/Probability/);
 t.mock.timers.tick(60_000);s=await send('I attended ADSA from 10:00 to 11:00',s.revision);
 assert.deepEqual(db.prepare('SELECT calendar_event_id,subject,attended_start,attended_end FROM study_class_attendance').all(),[{calendar_event_id:'a',subject:'adsa',attended_start:'2026-10-22T04:30:00.000Z',attended_end:'2026-10-22T05:30:00.000Z'}]);
 assert.match(s.reply,/confirmed ADSA attendance/);assert.equal(s.pendingQuestion,null);
});
it('action rejects a stale interpreted attendance event subject and resolves the explicitly requested subject',async t=>{
 const adsa={...probability,id:'a',title:'ADSA',subject:'adsa'}, {send,db}=setup(t,[probability,adsa]);
 let s=await send('I attended Probability',0);
 s=await send('correct the saved class please',s.revision,async()=>({type:'attendance',subject:'adsa',eventId:'p',start:adsa.start,end:adsa.end}));
 assert.deepEqual(db.prepare('SELECT calendar_event_id,subject FROM study_class_attendance').all(),[{calendar_event_id:'a',subject:'adsa'}]);
});
it('ambiguous corrected attendance drops old pending identity and durably asks which ADSA occurrence',async t=>{
 const a={...probability,id:'a',title:'ADSA one',subject:'adsa'},b={...a,id:'b',title:'ADSA two'};
 const {send,db,chat}=setup(t,[probability,a,b]);let s=await send('I attended Probability',0);
 s=await send('I attended ADSA from 10:00 to 11:00',s.revision);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM study_class_attendance').get().n,0);
 assert.match(s.pendingQuestion,/which.*ADSA|ADSA.*occurrence/i);
 const pending=JSON.parse(db.prepare('SELECT pending_json FROM study_chat_days').get().pending_json);
 assert.equal(pending.subject,'adsa');assert.equal(pending.event,undefined);assert.equal(chat.getStudyChatState(new Date()).pendingQuestion,s.pendingQuestion);
});
it('duration-only attendance followup preserves exact pending occurrence among matching subjects',async t=>{
 const events=[probability],{send,db}=setup(t,events);let s=await send('I attended Probability',0);
 events.unshift({...probability,id:'other',title:'Probability other'});
 t.mock.timers.tick(60_000);s=await send('from 10:00 to 11:00',s.revision);
 assert.deepEqual(db.prepare('SELECT calendar_event_id,subject FROM study_class_attendance').all(),[{calendar_event_id:'p',subject:'probability'}]);assert.equal(s.classSeconds,3600);
});
