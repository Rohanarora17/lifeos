'use strict';
const {describe,it,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');

describe('durable conversational study actions',()=>{
 let db,chat,options;
 const now=new Date('2026-10-22T06:30:00Z');
 const fresh={status:'fresh',events:[],syncedAt:now.toISOString(),warning:null};
 beforeEach(()=>{
  const env=createIsolatedDb('lifeos-study-chat-');db=env.db;
  chat=env.requireLib('study-chat.ts');
  options={now,interpret:async()=>null,calendar:async()=>fresh};
 });
 const send=(message,revision,requestId=message.replace(/[^a-z0-9]/gi,'-'),extra={})=>chat.processStudyChatMessage({message,revision,requestId,date:'2026-10-22'},{...options,...extra});
 it('enables the first native conversation during the campaign before mode activation and disables it after expiry',async()=>{
  assert.equal(chat.getStudyChatState(now).enabled,true);
  assert.equal(db.prepare('SELECT conversational_mode FROM endsem_config').get().conversational_mode,0);
  const s=await send('lunch',0,'first-native');assert.equal(s.enabled,true);
  assert.equal(chat.getStudyChatState(new Date('2026-11-14T06:30:00Z')).enabled,false);
 });
 it('asks a durable return question, accepts duration, extends once and returns without inventing study',async()=>{
  let s=await send('Going for lunch',0,'lunch');
  assert.equal(s.activity.kind,'meal');assert.equal(s.activity.expectedReturnAt,null);assert.match(s.pendingQuestion,/how long|return/i);
  assert.equal(s.remainingSeconds,28800);
  s=await send('30 minutes',s.revision,'duration');
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:00:00.000Z');
  const original=s.activity.startedAt;
  s=await send('another 15 minutes',s.revision,'extend');
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:15:00.000Z');assert.equal(s.activity.startedAt,original);
  const retry=await send('another 15 minutes',2,'extend');assert.equal(retry.revision,s.revision);
  s=await send("I'm back",s.revision,'back');assert.equal(s.activity,null);assert.match(s.reply,/start/i);assert.equal(s.remainingSeconds,28800);
 });
 it('rejects stale and fingerprint-reused requests after asynchronous interpretation',async()=>{
  const a=send('lunch',0,'a'),b=send('break',0,'b');
  const results=await Promise.allSettled([a,b]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  await assert.rejects(()=>send('changed',0,'a'),e=>e.status===409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_turns').get().n,2);
 });
 it('retains clarification after module restart and does not protect an unknown absence indefinitely',async()=>{
  await send('lunch',0);
  const store=require('../../src/lib/study-chat-store.ts');
  assert.equal(store.getStudyProtection(new Date('2026-10-22T06:35:00Z')).protected,true);
  assert.equal(store.getStudyProtection(new Date('2026-10-22T06:41:00Z')).protected,false);
  delete require.cache[require.resolve('../../src/lib/study-chat.ts')];
  chat=require('../../src/lib/study-chat.ts');
  const s=chat.getStudyChatState(now);assert.match(s.pendingQuestion,/how long|return/i);
 });
 it('supersedes return prompts after extension and acknowledgements only mark display',async()=>{
  let s=await send('lunch for 30 minutes',0);
  db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=? WHERE date=?').run('2026-10-22T02:30:00Z','2026-10-22T17:30:00Z',s.date);
  chat.runStudyChatAccountability(new Date('2026-10-22T07:00:00Z'));
  s=chat.getStudyChatState(new Date('2026-10-22T07:00:00Z'));assert.equal(s.pendingPrompt.kind,'return');
  chat.acknowledgeStudyChatPrompt(s.pendingPrompt.id,'device',now);
  assert.ok(chat.getStudyChatState(new Date('2026-10-22T07:00:00Z')).pendingPrompt);
  s=await send('another 15 minutes',s.revision,'extend',{now:new Date('2026-10-22T07:01:00Z')});
  assert.equal(s.pendingPrompt,null);
  chat.runStudyChatAccountability(new Date('2026-10-22T07:06:00Z'));
  assert.equal(chat.getStudyChatState(now).pendingPrompt,null);
 });
 it('credits only confirmed actual relevant class attendance, snapshots it and deduplicates paper overlap',async()=>{
  const event={id:'class-1',title:'Probability lecture',subject:'probability',kind:'class',start:'2026-10-22T04:30:00Z',end:'2026-10-22T05:30:00Z'};
  const calendar=async()=>({...fresh,events:[event]});
  let s=await send('I attended Probability class',0,'attend',{calendar});
  assert.equal(s.classSeconds,0);assert.match(s.pendingQuestion,/actual|start|end/i);
  s=await send('from 10:00 to 11:00',s.revision,'actual',{calendar});
  assert.equal(s.classSeconds,3600);assert.match(s.reply,/self.reported/i);
  db.prepare("INSERT INTO endsem_paper_logs(request_id,subject,started_at,ended_at,notes,created_at) VALUES('paper','adsa','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z','Exercises',?)").run(now.toISOString());
  s=chat.getStudyChatState(now);assert.equal(s.classSeconds+s.selfReportedSeconds,5400);assert.equal(s.remainingSeconds,23400);
  assert.match(db.prepare('SELECT calendar_snapshot FROM study_class_attendance').get().calendar_snapshot,/Probability lecture/);
 });
 it('persists explicit awake constraints, leaves stale calendars uncertain, and reports readiness honestly',async()=>{
  let s=await send('I wake at 08:00 and sleep at 23:00',0,'window');
  const day=db.prepare('SELECT * FROM study_chat_days WHERE date=?').get(s.date);
  assert.equal(day.wake_at,'2026-10-22T02:30:00.000Z');assert.equal(day.day_end_at,'2026-10-22T17:30:00.000Z');
  s=await send('start Probability',s.revision,'start');assert.match(s.reply,/not ready|permission|collector|vision client/i);
  assert.equal(s.measuredSeconds,0);
 });
 it('does not interpret malformed AI output as a mutation',async()=>{
  const s=await send('something unknown',0,'unknown',{interpret:async()=>({type:'depart',kind:'meal',until:'not-a-date'})});
  assert.equal(s.activity,null);assert.match(s.reply,/could not|try|tell me|understand/i);
 });
 it('accepts a refresh stamp milliseconds after request start but rejects a distant future stamp',async()=>{
  let s=await send('I wake at 08:00 and sleep at 23:00',0,'slightfuture',{calendar:async()=>({...fresh,syncedAt:new Date(now.getTime()+50).toISOString()})});
  assert.equal(s.plan.calendarStatus,'fresh');
  s=await send('lunch for 30 minutes',s.revision,'distantfuture',{calendar:async()=>({...fresh,syncedAt:new Date(now.getTime()+60000).toISOString()})});
  assert.equal(s.plan.calendarStatus,'stale');
 });
 it('asks one immediate lunch question and does not label unknown capacity an infeasible day',async()=>{
  const s=await send('lunch',0,'one-question',{calendar:async()=>({status:'unconfigured',events:[],syncedAt:null,warning:'Calendar availability uncertain.'})});
  assert.equal((s.reply.match(/\?/g)||[]).length,1);assert.doesNotMatch(s.reply,/do not fit|short by|480 study minutes/);
 });
 it('keeps a start proposal through subject changes and accepts yes only for that proposal',async()=>{
  let s=await send('I wake at 08:00 and sleep at 23:00',0,'proposal-window');
  s=await send('lunch for forty minutes',s.revision,'word-lunch');
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:10:00.000Z');
  s=await send("I'm back",s.revision,'word-back');
  assert.match(s.pendingQuestion,/start/i);
  s=await send('make it ADSA instead',s.revision,'switch');
  assert.match(s.pendingQuestion,/ADSA/);assert.equal(s.measuredSeconds,0);
  s=await send('yes',s.revision,'confirm');
  assert.match(s.reply,/not ready|collector|vision client/i);
  const question=s.pendingQuestion;
  s=await send('unclear unrelated words',s.revision,'other');
  assert.equal(s.pendingQuestion,question);
 });
 it('relative return clarification uses reply time while another duration extends the latest agreement',async()=>{
  let s=await send('lunch',0,'relative-lunch');
  s=await send('back in forty minutes',s.revision,'relative-return',{now:new Date('2026-10-22T06:40:00Z')});
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:20:00.000Z');
  s=await send('another twenty minutes',s.revision,'relative-extend',{now:new Date('2026-10-22T06:45:00Z')});
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:40:00.000Z');
 });
 it('a late class creates its own agreement and cannot extend an unrelated meal',async()=>{
  const event={id:'late-class',title:'ADSA lecture',subject:'adsa',start:'2026-10-22T06:00:00Z',end:'2026-10-22T07:00:00Z'};
  const calendar=async()=>({...fresh,events:[event]});
  let s=await send('lunch for 30 minutes',0,'late-meal',{calendar});
  s=await send('class is running late, another twenty minutes',s.revision,'class-late',{calendar});
  assert.equal(s.activity.kind,'class');assert.equal(s.activity.calendarEventId,event.id);
  assert.equal(s.activity.expectedReturnAt,'2026-10-22T07:20:00.000Z');
 });
 it('fresh chained class protection suppresses meal returns and generic coaching, then refreshes after aging',async()=>{
  const event={id:'after-lunch',title:'ADSA lecture',subject:'adsa',start:'2026-10-22T07:00:00Z',end:'2026-10-22T08:00:00Z'};
  const calendar=async at=>({...fresh,syncedAt:at.toISOString(),events:[event]});
  const s=await send('lunch for 30 minutes',0,'chain',{calendar});
  db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=? WHERE date=?').run('2026-10-22T02:30:00Z','2026-10-22T17:30:00Z',s.date);
  const at=new Date('2026-10-22T07:05:00Z');
  await chat.refreshStudyChatCalendar(at,calendar);
  chat.runStudyChatAccountability(at);
  assert.equal(chat.getStudyChatState(at).pendingPrompt,null);
  assert.equal(require('../../src/lib/study-chat-store.ts').getStudyProtection(at).protected,true);
 });
 it('requires confirmation beyond a scheduled class bound and does not award arbitrary twelve-hour overlap',async()=>{
  const event={id:'bound-class',title:'Probability lecture',subject:'probability',start:'2026-10-22T04:30:00Z',end:'2026-10-22T05:30:00Z'};
  const calendar=async()=>({...fresh,events:[event]});
  let s=await send('I attended Probability class from 01:00 to 11:00',0,'excess',{calendar});
  assert.equal(s.classSeconds,0);assert.match(s.pendingQuestion,/scheduled|outside|actual/i);
  s=await send('from 10:00 to 11:00',s.revision,'bounded',{calendar});
  assert.equal(s.classSeconds,3600);
 });
 it('does not remind for a completed block whose old plan JSON still says planned',async()=>{
  let s=await send('I wake at 08:00 and sleep at 23:00',0,'completed-window');
  const first=s.plan.sessions[0];assert.ok(first);
  db.prepare("UPDATE planned_focus_sessions SET status='completed' WHERE id=?").run(first.id);
  const at=new Date(Date.parse(first.start)+6*60_000);
  await chat.refreshStudyChatCalendar(at,async()=>({...fresh,syncedAt:at.toISOString()}));
  chat.runStudyChatAccountability(at);
  s=chat.getStudyChatState(at);assert.equal(s.pendingPrompt,null);
 });
 it('hides an old overdue prompt during a later protected class and after explicit bedtime',async()=>{
  const event={id:'unrelated-later-class',title:'ADSA lecture',subject:'adsa',start:'2026-10-22T09:00:00Z',end:'2026-10-22T10:00:00Z'};
  const calendar=async at=>({...fresh,syncedAt:at.toISOString(),events:[event]});
  const s=await send('lunch for 30 minutes',0,'later-class-meal',{calendar});
  db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=? WHERE date=?').run('2026-10-22T02:30:00Z','2026-10-22T17:30:00Z',s.date);
  chat.runStudyChatAccountability(new Date('2026-10-22T07:00:00Z'));
  const count=db.prepare('SELECT COUNT(*) n FROM study_chat_prompts').get().n;
  const during=new Date('2026-10-22T09:30:00Z');await chat.refreshStudyChatCalendar(during,calendar);chat.runStudyChatAccountability(during);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM study_chat_prompts').get().n,count);assert.equal(chat.getStudyChatState(during).pendingPrompt,null);
  assert.equal(chat.getStudyChatState(new Date('2026-10-22T18:00:00Z')).pendingPrompt,null);
 });
 it('expires campaign accountability and keeps reminder repetitions within explicit waking bounds',async()=>{
  const s=await send('lunch for 10 minutes',0);
  db.prepare('UPDATE study_chat_days SET wake_at=?,day_end_at=? WHERE date=?').run('2026-10-22T02:30:00Z','2026-10-22T07:00:00Z',s.date);
  chat.runStudyChatAccountability(new Date('2026-10-22T06:40:00Z'));
  chat.runStudyChatAccountability(new Date('2026-10-22T06:44:00Z'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_prompts WHERE kind != \'clarification\'').get().n,1);
  chat.runStudyChatAccountability(new Date('2026-10-22T06:45:00Z'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_prompts WHERE kind != \'clarification\'').get().n,2);
  chat.runStudyChatAccountability(new Date('2026-10-22T06:54:00Z'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_prompts WHERE kind != \'clarification\'').get().n,2);
  chat.runStudyChatAccountability(new Date('2026-10-22T06:55:00Z'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_prompts WHERE kind != \'clarification\'').get().n,3);
  chat.runStudyChatAccountability(new Date('2026-10-22T07:01:00Z'));
  chat.runStudyChatAccountability(new Date('2026-11-14T06:30:00Z'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_prompts WHERE kind != \'clarification\'').get().n,3);
 });
});
