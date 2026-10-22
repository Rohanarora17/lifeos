'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
it('starts the exact planned Guardian block within the next class window, pauses for lunch and resumes only after return',async t=>{
 const now=new Date('2026-10-22T06:30:00Z');
 t.mock.timers.enable({apis:['Date'],now:now.getTime()});
 delete process.env.GOOGLE_CLOUD_PROJECT;delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
 process.env.LIFEOS_REQUIRE_VISION_CLIENT='true';
 const env=createIsolatedDb('lifeos-study-lifecycle-'),db=env.db;
 const client=env.requireLib('guardian-client-status.ts');
 client.recordNativeClientHeartbeat({deviceId:'test',clientVersion:'0.3.0',screenRecordingStatus:'authorized',captureCapable:true,frontmostApp:'Preview',systemState:'active'});
 const chat=env.requireLib('study-chat.ts');
 const event={id:'upcoming-class',title:'ADSA class',subject:'adsa',start:'2026-10-22T06:40:00Z',end:'2026-10-22T07:40:00Z'};
 const calendar=async()=>({status:'fresh',events:[event],syncedAt:now.toISOString(),warning:null});
 const send=(message,revision,id)=>chat.processStudyChatMessage({date:'2026-10-22',message,revision,requestId:id},{now,calendar,interpret:async()=>null});
 let s=await send('I wake at 08:00 and sleep at 23:00',0,'window');
 const block=s.plan.sessions.find(x=>x.subject==='probability'&&x.start===now.toISOString());assert.ok(block);assert.equal(block.durationMinutes,10);
 s=await send('start Probability',s.revision,'start');
 const session=db.prepare("SELECT * FROM guardian_sessions WHERE state='ACTIVE'").get();
 try {
  assert.ok(session,s.reply);assert.equal(session.duration_minutes,10);
  const started=db.prepare("SELECT * FROM planned_focus_sessions WHERE status='started'").all();assert.equal(started.length,1);assert.equal(started[0].duration_minutes,10);
  const commitment=db.prepare('SELECT * FROM coaching_commitments WHERE session_id=?').get(session.session_id);assert.equal(commitment.source_id,started[0].id);
  assert.match(s.reply,/Guardian started/);assert.equal(s.measuredSeconds,0);
  const retry=await send('start Probability',1,'start');assert.equal(retry.revision,s.revision);assert.equal(db.prepare('SELECT COUNT(*) n FROM guardian_sessions').get().n,1);
  s=await send('lunch for 5 minutes',s.revision,'lunch');assert.equal(db.prepare('SELECT state FROM guardian_sessions WHERE session_id=?').get(session.session_id).state,'BREAK');assert.match(s.reply,/Guardian is paused/);
  s=await send("I'm back",s.revision,'return');assert.equal(db.prepare('SELECT state FROM guardian_sessions WHERE session_id=?').get(session.session_id).state,'BREAK');
  s=await send('yes',s.revision,'resume');assert.equal(db.prepare('SELECT state FROM guardian_sessions WHERE session_id=?').get(session.session_id).state,'ACTIVE');assert.match(s.reply,/Guardian resumed/);
 } finally {
  if(session)env.requireLib('guardian-runtime.ts').endGuardianSession(session.session_id);
  delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;
 }
});
it('a long paused Guardian block cannot resume into a class ten minutes away',async t=>{
 const start=new Date('2026-10-22T06:30:00Z');t.mock.timers.enable({apis:['Date'],now:start.getTime()});
 delete process.env.GOOGLE_CLOUD_PROJECT;delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;
 process.env.LIFEOS_REQUIRE_VISION_CLIENT='true';
 const env=createIsolatedDb('lifeos-study-paused-'),db=env.db,client=env.requireLib('guardian-client-status.ts'),chat=env.requireLib('study-chat.ts');
 const heartbeat=()=>client.recordNativeClientHeartbeat({deviceId:'paused',clientVersion:'0.3.0',screenRecordingStatus:'authorized',captureCapable:true,frontmostApp:'Preview',systemState:'active'});
 heartbeat();
 const event={id:'later-class',title:'ADSA class',subject:'adsa',start:'2026-10-22T07:40:00Z',end:'2026-10-22T08:40:00Z'};
 const calendar=async at=>({status:'fresh',events:[event],syncedAt:at.toISOString(),warning:null});
 const send=(message,revision,id)=>chat.processStudyChatMessage({date:'2026-10-22',message,revision,requestId:id},{now:new Date(),calendar,interpret:async()=>null});
 let s=await send('I wake at 08:00 and sleep at 23:00',0,'pause-window');s=await send('start Probability',s.revision,'pause-start');
 const session=db.prepare("SELECT * FROM guardian_sessions WHERE state='ACTIVE'").get();
 try {
  assert.ok(session,s.reply);assert.ok(session.duration_minutes>10);
  s=await send('lunch for 60 minutes',s.revision,'pause-meal');
  t.mock.timers.tick(60*60_000);heartbeat();
  s=await send("I'm back",s.revision,'pause-return');s=await send('yes',s.revision,'pause-resume');
  assert.match(s.reply,/remaining duration overlaps/);assert.equal(db.prepare('SELECT state FROM guardian_sessions WHERE session_id=?').get(session.session_id).state,'BREAK');
 } finally {if(session)env.requireLib('guardian-runtime.ts').endGuardianSession(session.session_id);delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;}
});
