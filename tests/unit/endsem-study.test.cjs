'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('endsem study ledger', () => {
  let db, study;
  const now = new Date('2026-10-22T16:30:00Z'); // 22:00 IST
  beforeEach(() => {
    const env = createIsolatedDb('lifeos-endsem-');
    db = env.db;
    study = env.requireLib('endsem-study.ts');
  });
  function session(id, title = 'Probability — Endsem study', mode = 'legacy') {
    db.prepare(`INSERT INTO guardian_sessions(session_id,target_title,started_at,evidence_pipeline_mode) VALUES(?,?,?,?)`)
      .run(id, title, Date.parse('2026-10-21T18:00:00Z'), mode);
  }
  function interval(id, start, end, opts = {}) {
    db.prepare(`INSERT INTO session_activity_intervals(interval_id,session_id,device_id,source,observed_start,observed_end,duration_seconds,state,category,counted,score_eligible,selection_reason,engagement_state) VALUES(?,?,'test','chrome',?,?,?,'active',?,?,?,'test',?)`)
      .run(`i-${id}-${start}-${opts.suffix || ''}`,id,start,end,(Date.parse(end)-Date.parse(start))/1000,opts.category || 'productive',opts.counted ?? 1,opts.eligible ?? 1,opts.engagement || 'interactive');
  }
  it('clips midnight, deduplicates overlap, and excludes idle/distraction/unrelated work', () => {
    session('p'); session('a','ADSA — Endsem study'); session('work','Build LifeOS');
    interval('p','2026-10-21T18:00:00Z','2026-10-21T19:30:00Z'); // 60m today
    interval('a','2026-10-21T19:00:00Z','2026-10-21T20:00:00Z'); // overlap 30m
    interval('p','2026-10-21T20:00:00Z','2026-10-21T21:00:00Z',{category:'distraction'});
    interval('p','2026-10-21T21:00:00Z','2026-10-21T22:00:00Z',{eligible:0});
    interval('p','2026-10-21T22:00:00Z','2026-10-21T23:00:00Z',{engagement:'inactive'});
    interval('work','2026-10-22T00:00:00Z','2026-10-22T01:00:00Z');
    const state = study.getEndsemState(now);
    assert.equal(state.today.measuredSeconds, 5400);
    assert.equal(state.today.remainingSeconds, 23400);
    assert.equal(state.today.status, 'behind');
    assert.equal(state.days.find(d => d.date === '2026-10-22').totalSeconds, 5400);
  });
  it('uses finalized authoritative slices instead of legacy or shadow evidence', () => {
    session('p', 'Probability', 'authoritative');
    interval('p','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z');
    const insert = db.prepare(`INSERT INTO guardian_activity_slices(slice_id,session_id,slice_bucket,slice_start,slice_end,duration_seconds,source,state,category,engagement_state,score_eligible,counted,selection_reason,provisional,pipeline_mode) VALUES(?,'p',?,?,?,5,'chrome','active','productive','interactive',1,1,'test',?,?)`);
    insert.run('ok','one','2026-10-22T05:00:00Z','2026-10-22T05:00:05Z',0,'authoritative');
    insert.run('pending','two','2026-10-22T05:00:05Z','2026-10-22T05:00:10Z',1,'authoritative');
    insert.run('shadow','three','2026-10-22T05:00:10Z','2026-10-22T05:00:15Z',0,'shadow');
    assert.equal(study.getEndsemState(now).today.measuredSeconds,5);
  });
  it('labels paper work separately, rejects future/empty logs, and counts overlap once', () => {
    session('p');
    interval('p','2026-10-22T05:00:00Z','2026-10-22T06:00:00Z');
    const log = {action:'paper',requestId:'paper-1',subject:'adsa',startedAt:'2026-10-22T05:30:00Z',endedAt:'2026-10-22T06:30:00Z',notes:'Solved recurrence exercises'};
    study.recordEndsemAction(log, now);
    study.recordEndsemAction(log, now); // retry
    const today = study.getEndsemState(now).today;
    assert.equal(today.measuredSeconds,3600);
    assert.equal(today.selfReportedSeconds,1800);
    assert.equal(today.totalSeconds,5400);
    assert.throws(()=>study.recordEndsemAction({...log,requestId:'future',endedAt:'2026-10-23T06:30:00Z'},now));
    assert.throws(()=>study.recordEndsemAction({...log,requestId:'empty',notes:''},now));
    assert.throws(()=>study.recordEndsemAction({...log,requestId:'bad',subject:'random'},now));
  });
  it('keeps target fixed and does not carry excess time to the next day', () => {
    session('p');
    interval('p','2026-10-22T00:00:00Z','2026-10-22T09:00:00Z');
    const today = study.getEndsemState(now).today;
    assert.equal(today.totalSeconds,32400);
    assert.equal(today.remainingSeconds,0);
    assert.equal(today.status,'complete');
    const tomorrow = study.getEndsemState(new Date('2026-10-23T16:30:00Z'));
    assert.equal(tomorrow.today.totalSeconds,0);
    assert.equal(tomorrow.today.remainingSeconds,28800);
    assert.equal(tomorrow.days.find(d=>d.date==='2026-10-22').status,'complete');
  });
  it('switches priorities only after explicit Probability completion or its exam date', () => {
    assert.equal(study.getEndsemState(new Date('2026-11-10T04:00:00Z')).nextSubject,'probability');
    study.recordEndsemAction({action:'probability_finished'},new Date('2026-11-10T10:00:00Z'));
    assert.equal(study.getEndsemState(new Date('2026-11-10T10:01:00Z')).nextSubject,'adsa');
    assert.equal(study.getEndsemState(new Date('2026-11-11T04:00:00Z')).nextSubject,'adsa');
    assert.equal(study.getEndsemState(new Date('2026-11-13T16:30:00Z')).phase,'active');
    assert.equal(study.getEndsemState(new Date('2026-11-14T00:00:00Z')).phase,'finished');
    assert.equal(study.getEndsemState(new Date('2026-10-21T16:30:00Z')).phase,'setup');
  });
  it('persists delays and blockers without giving study credit; validates checkpoints', () => {
    study.recordEndsemAction({action:'delay'},now);
    study.recordEndsemAction({action:'blocker',text:'Stuck on conditional expectation'},now);
    const state = study.getEndsemState(now);
    assert.equal(state.today.delayCount,1);
    assert.equal(state.today.delayUntil,'2026-10-22T16:40:00.000Z');
    assert.equal(state.today.blocker,'Stuck on conditional expectation');
    assert.equal(state.today.totalSeconds,0);
    assert.throws(()=>study.recordEndsemAction({action:'checkpoints',hours:[16,12,20,22]},now));
    study.recordEndsemAction({action:'checkpoints',hours:[11,15,19,22]},now);
    assert.deepEqual(study.getEndsemState(now).checkpointHours,[11,15,19,22]);
  });
  it('makes the fixed exam commitment available to the shared coaching context', () => {
    assert.match(study.getEndsemDirective(now), /480 minutes/);
    assert.match(study.getEndsemDirective(now), /Probability.*10 November 2026/);
    assert.match(study.getEndsemDirective(now), /ADSA.*13 November 2026/);
    assert.match(study.getEndsemDirective(now), /highest priorities/);
    assert.equal(study.getEndsemDirective(new Date('2026-11-14T06:30:00Z')),null);
  });
});
