'use strict';
const {describe,it,beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const {createIsolatedDb} = require('../helpers/temp-db.cjs');
describe('endsem API',()=>{
  let GET,POST;
  beforeEach(t=>{
    t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-22T16:30:00Z')});
    createIsolatedDb('lifeos-endsem-api-');
    const route=require.resolve('../../src/app/api/endsem/route.ts');
    delete require.cache[route];
    ({GET,POST}=require(route));
  });
  const request=body=>new Request('http://lifeos.test/api/endsem',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});
  it('returns state without caching and persists paper work, blockers, delays and review',async()=>{
    let response=await GET();
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).today.remainingSeconds,28800);
    response=await POST(request({action:'paper',requestId:'api-paper',subject:'probability',startedAt:'2026-10-22T10:00:00+05:30',endedAt:'2026-10-22T11:00:00+05:30',notes:'Worked conditional probability problems'}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).today.selfReportedSeconds,3600);
    await POST(request({action:'delay'}));
    await POST(request({action:'blocker',text:'Need to review Bayes theorem'}));
    response=await POST(request({action:'review',text:'Finished problem set; revisit mistakes',nextStartAt:'2026-10-23T08:00:00+05:30'}));
    const state=await response.json();
    assert.equal(response.status,200);
    assert.equal(state.today.delayCount,1);
    assert.equal(state.today.totalSeconds,3600);
    assert.equal(state.today.blocker,'Need to review Bayes theorem');
    assert.equal(state.today.nextStartAt,'2026-10-23T02:30:00.000Z');
  });
  it('rejects malformed inputs without adding time or accepting an invalid next start',async()=>{
    for(const body of ['{',[],{action:'unknown'},{action:'checkpoints',hours:[12,12,20,22]},{action:'paper',requestId:'bad',subject:'adsa',startedAt:'2026-10-22T22:00:00+05:30',endedAt:'2026-10-22T23:00:00+05:30',notes:'Future work'},{action:'review',text:'Done',nextStartAt:'2026-10-24T08:00:00+05:30'}]) {
      assert.equal((await POST(request(body))).status,400);
    }
    assert.equal((await (await GET()).json()).today.totalSeconds,0);
  });
});
