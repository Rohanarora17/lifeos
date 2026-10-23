'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const {createIsolatedDb}=require('../helpers/temp-db.cjs');
const event=lines=>`BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`;
const calendar=(...events)=>`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:Asia/Kolkata\r\n${events.join('\r\n')}\r\nEND:VCALENDAR`;
function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-23T06:30:00Z')});
 const env=createIsolatedDb('lifeos-ics-compat-');env.setSetting('calendar_ics_url','https://example.invalid/already-connected.ics');
 const sync=env.requireLib('calendar.ts').syncCalendarFromICS;
 return {...env,async run(text){t.mock.method(global,'fetch',async()=>new Response(text,{status:200}));return sync();},rows(){return env.db.prepare('SELECT id,title,start_time,end_time FROM calendar_events ORDER BY start_time,id').all();}};
}
it('expands local weekly IST without shifting a midnight BYDAY occurrence',async t=>{
 const f=fixture(t),r=await f.run(calendar(event(['UID:local','SUMMARY:Probability','DTSTART;TZID=Asia/Kolkata:20261020T003000','DTEND;TZID=Asia/Kolkata:20261020T013000','RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3'])));
 assert.deepEqual(r.errors,[]);assert.deepEqual(f.rows().map(x=>[x.id,x.start_time,x.end_time]),['2026-10-19','2026-10-26','2026-11-02'].map(d=>[`local_${d}T19:00:00.000Z`,`${d}T19:00:00.000Z`,`${d}T20:00:00.000Z`]));
});
it('respects New York, Belgrade and Helsinki recurrence wall clocks over DST changes',async t=>{
 const f=fixture(t),r=await f.run(calendar(
 event(['UID:ny','SUMMARY:New York','DTSTART;TZID=America/New_York:20261025T100000','DTEND;TZID=America/New_York:20261025T110000','RRULE:FREQ=WEEKLY;COUNT=2']),
 event(['UID:bg','SUMMARY:Belgrade','DTSTART;TZID=Europe/Belgrade:20261023T100000','DTEND;TZID=Europe/Belgrade:20261023T110000','RRULE:FREQ=WEEKLY;COUNT=2']),
 event(['UID:he','SUMMARY:Helsinki','DTSTART;TZID=Europe/Helsinki:20261023T100000','DTEND;TZID=Europe/Helsinki:20261023T110000','RRULE:FREQ=WEEKLY;COUNT=2'])));
 assert.deepEqual(r.errors,[]);const rows=f.rows();
 for(const [uid,first,second] of [['ny','2026-10-25T14:00:00.000Z','2026-11-01T15:00:00.000Z'],['bg','2026-10-23T08:00:00.000Z','2026-10-30T09:00:00.000Z'],['he','2026-10-23T07:00:00.000Z','2026-10-30T08:00:00.000Z']])assert.deepEqual(rows.filter(x=>x.id.startsWith(uid+'_')).map(x=>x.start_time),[first,second]);
});
it('applies EXDATE, moved overrides and cancelled occurrences with actual occurrence IDs',async t=>{
 const f=fixture(t),r=await f.run(calendar(
 event(['UID:series','SUMMARY:Probability','DTSTART;TZID=Asia/Kolkata:20261021T100000','DTEND;TZID=Asia/Kolkata:20261021T110000','RRULE:FREQ=DAILY;COUNT=6','EXDATE;TZID=Asia/Kolkata:20261022T100000']),
 event(['UID:series','RECURRENCE-ID;TZID=Asia/Kolkata:20261023T100000','SUMMARY:ADSA moved','DTSTART;TZID=Asia/Kolkata:20261023T120000','DTEND;TZID=Asia/Kolkata:20261023T133000']),
 event(['UID:series','RECURRENCE-ID;TZID=Asia/Kolkata:20261024T100000','STATUS:CANCELLED','DTSTART;TZID=Asia/Kolkata:20261024T100000','DTEND;TZID=Asia/Kolkata:20261024T110000'])));
 assert.deepEqual(r.errors,[]);assert.deepEqual(f.rows(),[
 {id:'series_2026-10-21T04:30:00.000Z',title:'Probability',start_time:'2026-10-21T04:30:00.000Z',end_time:'2026-10-21T05:30:00.000Z'},
 {id:'series_2026-10-23T06:30:00.000Z',title:'ADSA moved',start_time:'2026-10-23T06:30:00.000Z',end_time:'2026-10-23T08:00:00.000Z'},
 ...[25,26].map(d=>({id:`series_2026-10-${d}T04:30:00.000Z`,title:'Probability',start_time:`2026-10-${d}T04:30:00.000Z`,end_time:`2026-10-${d}T05:30:00.000Z`}))]);
});
it('keeps floating and all-day events in IST, imports ongoing events and deletes on same-clock resync',async t=>{
 const f=fixture(t),r=await f.run(calendar(
 event(['UID:floating','SUMMARY:Floating','DTSTART:20261023T100000','DTEND:20261023T110000']),
 event(['UID:day','SUMMARY:All day','DTSTART;VALUE=DATE:20261023']),
 event(['UID:ongoing','SUMMARY:Long absence','DTSTART;VALUE=DATE:20260901','DTEND;VALUE=DATE:20261025'])));
 assert.deepEqual(r.errors,[]);const rows=f.rows();assert.equal(rows.find(x=>x.id.startsWith('floating_')).start_time,'2026-10-23T04:30:00.000Z');
 assert.deepEqual(rows.find(x=>x.id.startsWith('day_')),{id:'day_2026-10-22T18:30:00.000Z',title:'All day',start_time:'2026-10-22T18:30:00.000Z',end_time:'2026-10-23T18:30:00.000Z'});assert.equal(rows.find(x=>x.id.startsWith('ongoing_')).end_time,'2026-10-24T18:30:00.000Z');
 assert.deepEqual((await f.run(calendar())).errors,[]);assert.equal(f.rows().length,0);
});
for(const bad of [
 ['RDATE:20261024T100000Z'],['EXRULE:FREQ=DAILY'],['RECURRENCE-ID;RANGE=THISANDFUTURE:20261023T100000Z'],['DTSTART;TZID=Mars/Olympus:20261023T100000'],['DTSTART:20261323T100000Z'],['DTEND:20261023T090000Z']
])it(`fails closed for invalid or unsupported ${bad[0].split(':')[0]} before mirror mutation`,async t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO calendar_events(id,title,start_time,end_time,synced_at) VALUES('old','Retain','2026-10-23T04:30:00Z','2026-10-23T05:30:00Z','old')").run();f.setSetting('calendar_ics_last_success_at','old');
 const lines=['UID:bad','SUMMARY:Bad','DTSTART:20261023T100000Z','DTEND:20261023T110000Z'];for(const line of bad){const name=line.split(/[;:]/)[0];const i=lines.findIndex(x=>x.startsWith(name+':'));if(i>=0)lines[i]=line;else lines.push(line);}
 const before=f.rows();const r=await f.run(calendar(event(lines)));assert.ok(r.errors.length);assert.deepEqual(f.rows(),before);assert.equal(f.requireLib('db.ts').getSetting('calendar_ics_last_success_at'),'old');
});
it('rolls back the whole batch and success markers if any database write fails',async t=>{
 const f=fixture(t);f.db.prepare("INSERT INTO calendar_events(id,title,start_time,end_time,synced_at) VALUES('old','Retain','2026-10-23T04:30:00Z','2026-10-23T05:30:00Z','old')").run();f.setSetting('calendar_ics_last_success_at','old');
 f.db.exec("CREATE TRIGGER reject_test_event BEFORE INSERT ON calendar_events WHEN NEW.title='Reject' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");const before=f.rows();
 const r=await f.run(calendar(...['Good','Reject'].map(title=>event([`UID:${title}`,`SUMMARY:${title}`,'DTSTART:20261023T100000Z','DTEND:20261023T110000Z']))));
 assert.ok(r.errors.length);assert.equal(r.synced,0);assert.deepEqual(f.rows(),before);assert.equal(f.requireLib('db.ts').getSetting('calendar_ics_last_success_at'),'old');
});
it('does not turn a valid instantaneous historical reminder into a failed calendar sync',async t=>{
 const f=fixture(t),r=await f.run(calendar(event(['UID:instant','SUMMARY:Reminder','DTSTART:20260101T100000Z','DTEND:20260101T100000Z']),event(['UID:class','SUMMARY:Probability','DTSTART:20261023T100000Z','DTEND:20261023T110000Z'])));
 assert.deepEqual(r.errors,[]);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].id,'class_2026-10-23T10:00:00.000Z');
});
