'use strict';
const {describe,it,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
describe('study agreement coordinates existing accountability',()=>{
 let db,lib;
 const now=new Date('2026-10-22T06:30:00Z');
 beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:now.getTime()});
  const env=createIsolatedDb('lifeos-study-coordination-');db=env.db;lib=env.requireLib;
 });
 it('suppresses old fixed Endsem reminders once conversational agreements own the day',async()=>{
  db.prepare('UPDATE endsem_config SET conversational_mode=1').run();
  const result=await lib('endsem-accountability.ts').runEndsemAccountability({now,send:async()=>{throw new Error('must not send');}});
  assert.equal(result.action,'none');assert.equal(db.prepare('SELECT COUNT(*) n FROM endsem_events').get().n,0);
 });
 it('suppresses routine and commitment coaching during declared meals, then expires unknown-return protection',async()=>{
  const chat=lib('study-chat.ts');
  await chat.processStudyChatMessage({date:'2026-10-22',message:'lunch',requestId:'gate-lunch',revision:0},{now,calendar:async()=>({status:'unconfigured',events:[],syncedAt:null,warning:'unknown'})});
  const gate=lib('coaching-state.ts').shouldSuppressRoutineCoaching('morning_brief');assert.equal(gate.suppress,true);assert.match(gate.reason,/lunch|agreed/i);
  const result=await lib('coaching-commitments.ts').runCommitmentExecutionCheck({now,send:async()=>{throw new Error('must not send');}});assert.equal(result.action,'paused');
  const context=lib('study-chat-store.ts').getStudyConversationDirective(now);assert.match(context,/lunch/);
  assert.equal(lib('study-chat-store.ts').getStudyProtection(new Date(now.getTime()+11*60_000)).protected,false);
 });
});
