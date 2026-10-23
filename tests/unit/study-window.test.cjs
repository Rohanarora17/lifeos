'use strict';
const {it}=require('node:test');const assert=require('node:assert/strict');const {createIsolatedDb}=require('../helpers/temp-db.cjs');
const anchor=new Date('2026-10-23T07:30:00Z'),wake='2026-10-23T14:30:00Z';
it('anchors consecutive 24-hour targets, protects sleep, and keeps credited study across midnight',t=>{
 const e=createIsolatedDb('lifeos-rolling-'),s=e.requireLib('endsem-study.ts');s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 let a=s.getEndsemState(anchor);assert.equal(a.window.mode,'consecutive24');assert.equal(a.window.startsAt,anchor.toISOString());assert.equal(a.window.endsAt,'2026-10-24T07:30:00.000Z');assert.equal(e.requireLib('study-chat-store.ts').getStudyProtection(anchor).protected,true);
 s.recordEndsemAction({action:'paper',requestId:'night',subject:'adsa',startedAt:'2026-10-23T17:30:00Z',endedAt:'2026-10-23T19:30:00Z',notes:'Night exercises'},new Date('2026-10-23T19:31:00Z'));
 a=s.getEndsemState(new Date('2026-10-23T19:31:00Z'));assert.equal(a.today.totalSeconds,7200);assert.equal(a.today.remainingSeconds,21600);assert.equal(a.date,'2026-10-23');
 a=s.getEndsemState(new Date('2026-10-24T07:30:00Z'));assert.equal(a.date,'2026-10-24');assert.equal(a.today.totalSeconds,0);assert.equal(a.today.remainingSeconds,28800);assert.equal(a.days.find(d=>d.date==='2026-10-23').totalSeconds,7200);
});
it('plans through midnight to the actual 24-hour deadline and honors declared sleep',async t=>{
 const e=createIsolatedDb('lifeos-rolling-plan-');e.requireLib('endsem-study.ts').recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const p=e.requireLib('study-day-planning.ts').rebalanceStudyDay({now:anchor,calendar:{status:'fresh',events:[],syncedAt:anchor.toISOString(),warning:null},protectedIntervals:e.requireLib('study-chat-store.ts').studyProtectedIntervals(anchor),subject:'probability',revision:1});
 assert.equal(p.endAt,'2026-10-24T07:30:00.000Z');assert.equal(p.remainingSeconds,28800);assert.equal(p.scheduledMinutes,480);assert.ok(p.sessions.every(x=>Date.parse(x.start)>=Date.parse(wake)));assert.ok(p.sessions.some(x=>Date.parse(x.end)>Date.parse('2026-10-23T18:30:00Z')));
});
it('skipping a calendar class rebalances without attendance credit or external event changes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:anchor.getTime()});const e=createIsolatedDb('lifeos-flex-calendar-');e.requireLib('endsem-study.ts').recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const chat=e.requireLib('study-chat.ts'),event={id:'p',title:'Probability class',subject:'probability',kind:'class',start:'2026-10-23T15:00:00Z',end:'2026-10-23T16:00:00Z'};
 const state=chat.getStudyChatState(anchor);const s=await chat.processStudyChatMessage({message:'I am skipping Probability class',requestId:'skip-p',revision:state.revision,date:state.date},{now:anchor,calendar:async()=>({status:'fresh',events:[event],syncedAt:anchor.toISOString(),warning:null}),interpret:async()=>null});
 assert.match(s.reply,/skip|removed|adjust/i);assert.equal(e.requireLib('study-chat-store.ts').studyExternalCalendarEvents({events:[event]}).length,0);assert.equal(s.classSeconds,0);assert.equal(s.remainingSeconds,28800);assert.equal(s.plan.anticipatedClassMinutes,0);
});
it('carries an unresolved absence and its conversation into the next window',async t=>{
 const e=createIsolatedDb('lifeos-rolling-carry-'),s=e.requireLib('endsem-study.ts'),chat=e.requireLib('study-chat.ts');s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const before=new Date('2026-10-24T07:00:00Z'),after=new Date('2026-10-24T08:00:00Z');
 const calendar=async()=>({status:'fresh',events:[],syncedAt:before.toISOString(),warning:null});
 let state=chat.getStudyChatState(before);await chat.processStudyChatMessage({message:'Going for lunch, back in 20 minutes',requestId:'lunch',revision:state.revision,date:state.date},{now:before,calendar,interpret:async()=>null});
 state=chat.getStudyChatState(after);assert.equal(state.activity.title,'lunch');assert.ok(state.messages.some(m=>m.text.includes('Going for lunch')));assert.equal(e.requireLib('study-chat-store.ts').getStudyProtection(after).protected,false);
 chat.runStudyChatAccountability(after);assert.match(chat.getStudyChatState(after).pendingPrompt.text,/40 minutes past/);
});
it('accepts actual attended class time after midnight within the same window',async t=>{
 const e=createIsolatedDb('lifeos-rolling-class-'),s=e.requireLib('endsem-study.ts'),chat=e.requireLib('study-chat.ts');s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const now=new Date('2026-10-23T20:45:00Z'),event={id:'late-class',title:'ADSA class',subject:'adsa',kind:'class',start:'2026-10-23T19:30:00Z',end:'2026-10-23T20:30:00Z'};
 const state=chat.getStudyChatState(now),next=await chat.processStudyChatMessage({message:'I attended ADSA from 1am to 2am',requestId:'late-attendance',revision:state.revision,date:state.date},{now,calendar:async()=>({status:'fresh',events:[event],syncedAt:now.toISOString(),warning:null}),interpret:async()=>null});
 assert.equal(next.classSeconds,3600);assert.equal(next.remainingSeconds,25200);
});
it('sleep across a window boundary stays protected and an early return opens the plan',async t=>{
 const e=createIsolatedDb('lifeos-rolling-sleep-'),s=e.requireLib('endsem-study.ts'),chat=e.requireLib('study-chat.ts');s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const now=new Date('2026-10-24T06:30:00Z'),later=new Date('2026-10-24T08:30:00Z');let state=chat.getStudyChatState(now);
 const deps=at=>({now:at,calendar:async()=>({status:'fresh',events:[],syncedAt:at.toISOString(),warning:null}),interpret:async()=>null});
 await chat.processStudyChatMessage({message:'Going to sleep, wake by 8pm',requestId:'sleep-again',revision:state.revision,date:state.date},deps(now));
 state=chat.getStudyChatState(later);assert.equal(e.requireLib('study-chat-store.ts').getStudyProtection(later).protected,true);assert.equal(state.activity.expectedReturnAt,'2026-10-24T14:30:00.000Z');
 state=await chat.processStudyChatMessage({message:"I'm back",requestId:'awake-early',revision:state.revision,date:state.date},deps(later));assert.equal(state.activity,null);assert.equal(e.requireLib('study-chat-store.ts').getStudyProtection(later).protected,false);assert.equal(state.remainingSeconds,28800);
});
it('resolves tomorrow morning return clocks and does not allow changing the earned window anchor',t=>{
 const e=createIsolatedDb('lifeos-rolling-clock-'),s=e.requireLib('endsem-study.ts');s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const chat=e.requireLib('study-chat.ts'),now=new Date('2026-10-23T18:00:00Z');
 const intent=e.requireLib('study-chat-intent.ts').fallbackStudyIntent('Going to sleep, wake by 8am',{now,state:chat.getStudyChatState(now),pending:null,calendar:{status:'fresh',events:[],syncedAt:now.toISOString(),warning:null}});assert.equal(intent.until,'2026-10-24T02:30:00.000Z');
 assert.throws(()=>s.recordEndsemAction({action:'rolling_window',anchorAt:new Date(anchor.getTime()+60000).toISOString(),wakeAt:wake},anchor),/anchor/);
 const expired=s.getEndsemState(new Date('2026-11-14T02:00:00Z'));assert.equal(expired.phase,'finished');assert.equal(expired.window.endsAt,'2026-11-13T18:30:00.000Z');
});
it('retains pre-transition history and stores after-midnight blockers against the current target',t=>{
 const e=createIsolatedDb('lifeos-rolling-history-'),s=e.requireLib('endsem-study.ts');
 s.recordEndsemAction({action:'paper',requestId:'old-paper',subject:'probability',startedAt:'2026-10-22T01:30:00Z',endedAt:'2026-10-22T02:30:00Z',notes:'Actual previous study'},anchor);
 s.recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const now=new Date('2026-10-23T20:00:00Z');s.recordEndsemAction({action:'blocker',text:'Stuck on recurrence proof'},now);
 const state=s.getEndsemState(now);assert.equal(state.days.find(d=>d.date==='2026-10-22').totalSeconds,3600);assert.equal(state.today.totalSeconds,0);assert.equal(state.today.blocker,'Stuck on recurrence proof');
});
it('does not count fragments that are too short for Guardian to start',t=>{
 const e=createIsolatedDb('lifeos-rolling-fragment-');e.requireLib('endsem-study.ts').recordEndsemAction({action:'rolling_window',wakeAt:wake},anchor);
 const now=new Date(wake),end='2026-10-23T15:00:00Z';
 const planner=e.requireLib('study-day-planning.ts'),input={now,calendar:{status:'fresh',events:[{id:'busy',title:'Commitment',kind:'commitment',start:end,end:'2026-10-23T16:00:00Z'}],syncedAt:now.toISOString(),warning:null},protectedIntervals:[],subject:'probability',revision:1};
 planner.rebalanceStudyDay(input);e.db.prepare("UPDATE planned_focus_sessions SET rule_json=json_set(rule_json,'$.preferredMinutes',20)").run();
 const plan=planner.rebalanceStudyDay(input);
 assert.ok(plan.sessions.every(s=>s.durationMinutes>=5));assert.ok(plan.scheduledMinutes>=480);assert.equal(plan.shortfallMinutes,0);
});
