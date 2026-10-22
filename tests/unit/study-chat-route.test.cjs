'use strict';
const {describe,it,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
describe('study chat HTTP boundary',()=>{
 let GET,POST,db;
 beforeEach(t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-22T06:30:00Z')});
  ({db}=createIsolatedDb('lifeos-study-http-'));
  const path=require.resolve('../../src/app/api/study-chat/route.ts');delete require.cache[path];({GET,POST}=require(path));
 });
 const request=body=>new Request('http://lifeos.test/api/study-chat',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});
 it('works without Guardian and returns no-store, revision conflicts, honest persisted messages',async()=>{
  const initial=await GET();assert.equal(initial.headers.get('cache-control'),'no-store');
  assert.equal((await initial.json()).revision,0);
  const body={action:'message',date:'2026-10-22',message:'lunch',requestId:'http-lunch',revision:0};
  let result=await POST(request(body));assert.equal(result.status,200);const saved=await result.json();assert.equal(saved.activity.kind,'meal');
  result=await POST(request(body));assert.equal(result.status,200);assert.equal((await result.json()).revision,1);
  result=await POST(request({...body,requestId:'new'}));assert.equal(result.status,409);assert.equal((await result.json()).state.revision,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM study_chat_turns').get().n,2);
 });
 it('acknowledges display without resolving a question, rejects malformed and cross-day mutations',async()=>{
  const state=await(await GET()).json();
  let result=await POST(request({action:'ack_prompt',promptId:state.pendingPrompt.id,deviceId:'test'}));assert.equal(result.status,200);
  assert.equal(db.prepare('SELECT resolved_at FROM study_chat_prompts').get().resolved_at,null);
  for(const body of ['{',[],{action:'unknown'},{action:'message',date:'2026-10-22',message:'lunch',requestId:'bad',revision:-1}]) assert.equal((await POST(request(body))).status,400);
  result=await POST(request({action:'message',date:'2026-10-21',message:'lunch',requestId:'yesterday',revision:0}));assert.equal(result.status,409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM study_activities').get().n,0);
 });
 it('allows the existing scoped native device token only on study-chat path',()=>{
  const {authorizeApiRequest,isDevicePath}=require('../../src/lib/api-security.ts');
  assert.equal(isDevicePath('/api/study-chat'),true);assert.equal(isDevicePath('/api/study-chat-admin'),false);
  const authorization=authorizeApiRequest({method:'POST',pathname:'/api/study-chat',origin:'http://lifeos.test',requestOrigin:null,authorization:null,deviceToken:'device-secret',cookieToken:null},{LIFEOS_AUTH_MODE:'required',LIFEOS_API_TOKEN:'admin',LIFEOS_DEVICE_TOKEN:'device-secret'});
  assert.equal(authorization.allowed,true);assert.equal(authorization.kind,'device');
 });
});
