'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
const now=new Date('2026-10-22T06:30:00Z');
const events=[{id:'p',subject:'probability',kind:'class',title:'Probability',start:'2026-10-22T05:30:00Z',end:'2026-10-22T06:00:00Z'},{id:'a',subject:'adsa',kind:'class',title:'ADSA',start:'2026-10-22T06:00:00Z',end:'2026-10-22T07:00:00Z'}];
const fresh=(at,rows=[])=>({status:'fresh',events:rows,syncedAt:at.toISOString(),warning:null});
function setup(prefix){const env=createIsolatedDb(prefix),chat=env.requireLib('study-chat.ts');return {...env,chat,send:(message,revision,id,rows=events)=>chat.processStudyChatMessage({date:'2026-10-22',message,revision,requestId:id},{now,calendar:async()=>fresh(now,rows),interpret:async()=>null})};}
it('named ADSA late class does not extend a preceding Probability occurrence',async()=>{
 const {send}=setup('lifeos-review-named-');
 const s=await send('My ADSA class is running late, another 20 minutes',0,'named');
 assert.equal(s.activity.calendarEventId,'a');assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:20:00.000Z');
});
it('an ambiguous unnamed late class asks identity and preserves the chosen event through reordered followups',async()=>{
 const {send}=setup('lifeos-review-identity-');
 let s=await send('class is running late, another 20 minutes',0,'ambiguous');assert.equal(s.activity,null);assert.match(s.pendingQuestion,/which class/i);
 s=await send('ADSA',s.revision,'identify');assert.equal(s.activity,null);assert.match(s.pendingQuestion,/end|longer/i);
 s=await send('20 minutes',s.revision,'duration',[events[0],{...events[1],title:'ADSA current title'}]);
 assert.equal(s.activity.calendarEventId,'a');assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:20:00.000Z');
});
it('a class end-time followup retains exact occurrence even when refreshed calendar contains two matching subjects',async()=>{
 const {send}=setup('lifeos-review-pending-');
 let s=await send('My ADSA class is running late',0,'question');assert.equal(s.activity,null);
 s=await send('20 minutes',s.revision,'answer',[events[0],{...events[1],id:'other-a',start:'2026-10-22T05:45:00Z'},events[1]]);
 assert.equal(s.activity.calendarEventId,'a');
});
it('explicit new dinner wins over pending class or earlier meal duration clarification',async()=>{
 const {send}=setup('lifeos-review-departure-priority-');
 let s=await send('My ADSA class is running late',0,'class-question');
 s=await send('going for dinner for 30 minutes',s.revision,'new-dinner');assert.equal(s.activity.kind,'meal');assert.equal(s.activity.title,'dinner');
 s=await send('another twenty minutes',s.revision,'dinner-extension');assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:20:00.000Z');
 s=await send('lunch',s.revision,'new-lunch');assert.equal(s.activity.expectedReturnAt,null);
 s=await send('going for dinner for 30 minutes',s.revision,'next-dinner');assert.equal(s.activity.title,'dinner');assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:00:00.000Z');
});
it('calendar add/move/delete reconciles owned future work, invalidates queued prompts and versions the plan',async()=>{
 const {chat,send,db}=setup('lifeos-review-refresh-');
 let s=await send('I wake at 08:00 and sleep at 23:00',0,'window',[]);
 const at=new Date('2026-10-22T06:36:00Z');
 chat.runStudyChatAccountability(at);assert.equal(chat.getStudyChatState(at).pendingPrompt.kind,'start');
 const originalRevision=s.revision,oldId=s.plan.sessions[0].id;
 let event={id:'travel',title:'Travel',kind:'commitment',start:'2026-10-22T06:37:00Z',end:'2026-10-22T07:36:00Z'};
 await chat.refreshStudyChatCalendar(at,async()=>fresh(at,[event]));chat.runStudyChatAccountability(at);s=chat.getStudyChatState(at);
 assert.equal(s.pendingPrompt,null);assert.ok(s.revision>originalRevision);assert.equal(s.plan.revision,s.revision);
 assert.equal(db.prepare('SELECT status FROM planned_focus_sessions WHERE id=?').get(oldId).status,'cancelled');
 const overlaps=e=>s.plan.sessions.some(x=>Date.parse(x.start)<Date.parse(e.end)&&Date.parse(x.end)>Date.parse(e.start));assert.equal(overlaps(event),false);
 const addedRevision=s.revision;
 event={...event,start:'2026-10-22T08:00:00Z',end:'2026-10-22T09:00:00Z'};
 await chat.refreshStudyChatCalendar(at,async()=>fresh(at,[event]));s=chat.getStudyChatState(at);assert.ok(s.revision>addedRevision);assert.equal(overlaps(event),false);
 const movedRevision=s.revision;
 await chat.refreshStudyChatCalendar(at,async()=>fresh(at,[]));s=chat.getStudyChatState(at);assert.ok(s.revision>movedRevision);assert.equal(s.plan.calendarStatus,'fresh');
 const deletedRevision=s.revision;
 await chat.refreshStudyChatCalendar(new Date(at.getTime()+60000),async t=>fresh(t,[]));assert.equal(chat.getStudyChatState(at).revision,deletedRevision,'timestamp-only refresh does not invalidate client drafts');
});
it('a changed calendar revision rejects a message interpreted against the older plan',async()=>{
 const {chat,send}=setup('lifeos-review-calendar-concurrency-');
 const s=await send('I wake at 08:00 and sleep at 23:00',0,'window',[]);
 let release;const gate=new Promise(resolve=>{release=resolve;});let interpreting;const entered=new Promise(resolve=>{interpreting=resolve;});
 const request=chat.processStudyChatMessage({date:'2026-10-22',message:'unrecognized checkin',revision:s.revision,requestId:'inflight'},{now,calendar:async()=>fresh(now),interpret:async()=>{interpreting();await gate;return null;}});
 await entered;await chat.refreshStudyChatCalendar(now,async()=>fresh(now,[{id:'new',title:'Travel',start:'2026-10-22T07:00:00Z',end:'2026-10-22T08:00:00Z'}]));release();
 await assert.rejects(()=>request,error=>error.status===409);
});
it('a calendar change discovered by a message reconciles overdue unstarted blocks too',async()=>{
 const {chat,send}=setup('lifeos-review-message-refresh-');
 const s=await send('I wake at 08:00 and sleep at 23:00',0,'window',[]),at=new Date('2026-10-22T06:36:00Z');
 const event={id:'message-travel',title:'Travel',start:'2026-10-22T06:37:00Z',end:'2026-10-22T07:36:00Z'};
 const updated=await chat.processStudyChatMessage({date:'2026-10-22',message:'unrecognized checkin',revision:s.revision,requestId:'message-read'},{now:at,calendar:async()=>fresh(at,[event]),interpret:async()=>null});
 assert.equal(updated.plan.sessions.some(x=>Date.parse(x.start)<Date.parse(event.end)&&Date.parse(x.end)>Date.parse(event.start)),false);
});
it('an exact linked study mirror permits start prompts while a moved mirror remains protected',async()=>{
 const {chat,send,db}=setup('lifeos-review-owned-mirror-');
 let s=await send('I wake at 08:00 and sleep at 23:00',0,'window',[]);const first=s.plan.sessions[0];
 db.prepare('UPDATE planned_focus_sessions SET calendar_event_id=? WHERE id=?').run('owned-export',first.id);
 const at=new Date('2026-10-22T06:36:00Z'),mirror={id:'study_oauth:owned-export',title:first.title,kind:'commitment',subject:first.subject,start:first.start,end:first.end};
 await chat.refreshStudyChatCalendar(at,async()=>fresh(at,[mirror]));chat.runStudyChatAccountability(at);s=chat.getStudyChatState(at);
 assert.equal(db.prepare('SELECT status FROM planned_focus_sessions WHERE id=?').get(first.id).status,'cancelled');
 assert.equal(s.plan.sessions[0].start,at.toISOString(),'an elapsed unstarted owned proposal is regenerated from now');
 const due=new Date(at.getTime()+6*60_000);chat.runStudyChatAccountability(due);s=chat.getStudyChatState(due);assert.equal(s.pendingPrompt?.kind,'start');
 const moved={...mirror,start:'2026-10-22T06:35:00Z',end:'2026-10-22T07:45:00Z'};
 await chat.refreshStudyChatCalendar(at,async()=>fresh(at,[moved]));chat.runStudyChatAccountability(at);s=chat.getStudyChatState(at);assert.equal(s.pendingPrompt,null);
 assert.equal(require('../../src/lib/study-chat-store.ts').getStudyProtection(at).protected,true);
});
it('ready Guardian start and resume obey a future wake window until an explicit correction',async t=>{
 t.mock.timers.enable({apis:['Date'],now:now.getTime()});delete process.env.GOOGLE_CLOUD_PROJECT;delete process.env.TELEGRAM_BOT_TOKEN;delete process.env.TELEGRAM_CHAT_ID;process.env.LIFEOS_REQUIRE_VISION_CLIENT='true';
 const env=setup('lifeos-review-wake-'),{chat,send,db}=env;
 env.requireLib('guardian-client-status.ts').recordNativeClientHeartbeat({deviceId:'review',clientVersion:'0.3.0',screenRecordingStatus:'authorized',captureCapable:true,frontmostApp:'Preview',systemState:'active'});
 let sessionId;
 try {
  let s=await send('I wake at 14:00 and sleep at 23:00',0,'future-window',[]);
  s=await send('start Probability',s.revision,'before-wake',[]);assert.equal(db.prepare("SELECT COUNT(*) n FROM guardian_sessions WHERE state='ACTIVE'").get().n,0);assert.match(s.reply,/waking|wake|window/i);
  s=await send('I wake at 08:00 and sleep at 23:00',s.revision,'correct-window',[]);
  const first=s.plan.sessions[0];db.prepare('UPDATE planned_focus_sessions SET calendar_event_id=? WHERE id=?').run('live-owned',first.id);
  const mirror={id:'live-owned',title:first.title,kind:'commitment',start:first.start,end:first.end};
  s=await send('start Probability',s.revision,'after-correction',[mirror]);const session=db.prepare("SELECT * FROM guardian_sessions WHERE state='ACTIVE'").get();assert.ok(session,s.reply);sessionId=session.session_id;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM planned_focus_sessions WHERE status='started'").get().n,1);
  s=await send('lunch for 10 minutes',s.revision,'pause',[]);s=await send("I'm back",s.revision,'return',[]);
  s=await send('I wake at 14:00 and sleep at 23:00',s.revision,'changed-wake',[]);
  s=await send('resume Probability',s.revision,'resume-before-wake',[]);assert.equal(db.prepare('SELECT state FROM guardian_sessions WHERE session_id=?').get(sessionId).state,'BREAK');
 } finally {for(const row of db.prepare("SELECT session_id FROM guardian_sessions WHERE state IN ('ACTIVE','BREAK')").all())env.requireLib('guardian-runtime.ts').endGuardianSession(row.session_id);delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;}
});
