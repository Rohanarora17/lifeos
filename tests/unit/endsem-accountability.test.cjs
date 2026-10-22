'use strict';
const {describe,it,beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const {createIsolatedDb} = require('../helpers/temp-db.cjs');
describe('endsem accountability',()=>{
  let db, study, loop;
  const noon = new Date('2026-10-22T06:30:00Z');
  beforeEach(()=>{
    const env=createIsolatedDb('lifeos-endsem-loop-'); db=env.db;
    env.setSetting('telegram_bot_token','test-token'); env.setSetting('telegram_chat_id','test-chat');
    study=env.requireLib('endsem-study.ts'); loop=env.requireLib('endsem-accountability.ts');
  });
  it('persists actionable pushes, deduplicates ticks, and repeats only after ten minutes',async()=>{
    const sent=[]; const send=async(message)=>{sent.push(message);return true;};
    assert.equal((await loop.runEndsemAccountability({now:noon,send})).action,'push');
    assert.match(sent[0],/8h 00m/); assert.match(sent[0],/50 minutes of Probability/);
    assert.equal((await loop.runEndsemAccountability({now:noon,send})).action,'none');
    assert.equal((await loop.runEndsemAccountability({now:new Date(noon.getTime()+9*60_000),send})).action,'none');
    assert.equal((await loop.runEndsemAccountability({now:new Date(noon.getTime()+10*60_000),send})).action,'push');
    assert.equal(db.prepare('SELECT count(*) AS n FROM alerts WHERE type = ?').get('endsem_lock_in').n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM endsem_events WHERE telegram_sent_at IS NOT NULL').get().n,2);
  });
  it('honors delay, pause, setup, quiet hours, campaign end, and active measured study',async()=>{
    const send=async()=>true;
    study.recordEndsemAction({action:'delay'},noon);
    assert.equal((await loop.runEndsemAccountability({now:noon,send})).action,'none');
    assert.equal((await loop.runEndsemAccountability({now:new Date(noon.getTime()+10*60_000),send})).action,'push');
    study.recordEndsemAction({action:'pause'},noon);
    assert.equal((await loop.runEndsemAccountability({now:new Date(noon.getTime()+20*60_000),send})).action,'none');
    study.recordEndsemAction({action:'resume'},noon);
    for(const at of ['2026-10-21T06:30:00Z','2026-10-22T18:00:00Z','2026-11-14T06:30:00Z']) {
      assert.equal((await loop.runEndsemAccountability({now:new Date(at),send})).action,'none');
    }
    db.prepare(`INSERT INTO guardian_sessions(session_id,target_title,started_at) VALUES('active','ADSA',?)`).run(noon.getTime()-60_000);
    db.prepare(`INSERT INTO session_activity_intervals(interval_id,session_id,device_id,source,observed_start,observed_end,duration_seconds,state,category,counted,score_eligible,selection_reason) VALUES('recent','active','test','chrome',?,?,30,'active','productive',1,1,'test')`).run(new Date(noon.getTime()-30_000).toISOString(),noon.toISOString());
    assert.equal((await loop.runEndsemAccountability({now:noon,send})).action,'none');
  });
  it('retains delivery failure honestly and retries a pending Telegram message',async()=>{
    await loop.runEndsemAccountability({now:noon,send:async()=>false});
    assert.equal(db.prepare('SELECT telegram_sent_at FROM endsem_events').get().telegram_sent_at,null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM alerts').get().n,1);
    await loop.runEndsemAccountability({now:new Date(noon.getTime()+5*60_000),send:async()=>true});
    assert.notEqual(db.prepare('SELECT telegram_sent_at FROM endsem_events').get().telegram_sent_at,null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM alerts').get().n,1);
  });
  it('does not send an obsolete failed push after a delay',async()=>{
    await loop.runEndsemAccountability({now:noon,send:async()=>false});
    study.recordEndsemAction({action:'delay'},new Date(noon.getTime()+60_000));
    let sent=0;
    await loop.runEndsemAccountability({now:new Date(noon.getTime()+6*60_000),send:async()=>{sent++;return true;}});
    assert.equal(sent,0);
  });
  it('expires a failed push when study catches up, rather than delivering stale totals',async()=>{
    await loop.runEndsemAccountability({now:noon,send:async()=>false});
    const later=new Date(noon.getTime()+60_000);
    study.recordEndsemAction({action:'paper',requestId:'catch-up',subject:'probability',startedAt:'2026-10-22T03:30:00Z',endedAt:'2026-10-22T05:30:00Z',notes:'Solved exercises'},later);
    let sent=0;
    const result=await loop.runEndsemAccountability({now:new Date(noon.getTime()+5*60_000),send:async()=>{sent++;return true;}});
    assert.equal(result.action,'none');assert.equal(sent,0);
  });
  it('resolves a delayed start when study resumes and stops pushing while on track',async()=>{
    study.recordEndsemAction({action:'delay'},new Date('2026-10-22T02:30:00Z'));
    study.recordEndsemAction({action:'paper',requestId:'after-delay',subject:'adsa',startedAt:'2026-10-22T02:40:00Z',endedAt:'2026-10-22T04:40:00Z',notes:'Recurrence exercises'},new Date('2026-10-22T04:40:00Z'));
    const at=new Date('2026-10-22T04:45:00Z');
    const state=study.getEndsemState(at);
    assert.equal(state.today.delayCount,1);
    assert.equal(state.today.delayUntil,null);
    let message='';
    await loop.runEndsemAccountability({now:at,send:async value=>{message=value;return true;}});
    assert.doesNotMatch(message,/Lock in\./);
  });
  it('prompts the first start and nightly review, and keeps yesterday’s shortfall',async()=>{
    const send=async()=>true;
    assert.equal((await loop.runEndsemAccountability({now:new Date('2026-10-22T02:30:00Z'),send})).action,'morning');
    assert.equal((await loop.runEndsemAccountability({now:new Date('2026-10-22T16:30:00Z'),send})).action,'review');
    assert.match(study.getEndsemState(new Date('2026-10-22T16:30:00Z')).latestPrompt,/first start/);
    const state=study.getEndsemState(new Date('2026-10-23T02:30:00Z'));
    assert.equal(state.days[0].status,'missed');
    assert.equal(state.days[0].remainingSeconds,28800);
  });
});
