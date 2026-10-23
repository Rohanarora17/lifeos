import type { StudySubject } from './endsem-contract';
import type { StudyActivityKind, StudyCalendarSnapshot, StudyChatState } from './study-chat-contract';
import type { PendingStudyQuestion } from './study-chat-store';

export type StudyIntent =
 | {type:'depart';kind:StudyActivityKind;title:string;minutes?:number;until?:string;eventId?:string}
 | {type:'extend';minutes?:number;until?:string;fromNow?:boolean}
 | {type:'skip_class';subject?:StudySubject;eventId?:string}
 | {type:'return'} | {type:'start';subject?:StudySubject}
 | {type:'propose_start';subject?:StudySubject}
 | {type:'attendance';subject?:StudySubject;eventId?:string;start?:string;end?:string}
 | {type:'window';wakeAt:string;endAt:string}
 | {type:'class_late';minutes?:number;until?:string;subject?:StudySubject;eventId?:string}
 | {type:'clarify';question:string};
export interface IntentContext {now:Date;state:StudyChatState;pending:PendingStudyQuestion|null;calendar:StudyCalendarSnapshot}
const iso = (value:unknown): value is string => typeof value==='string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
export function validateStudyIntent(value: unknown): StudyIntent | null {
 if (!value || typeof value!=='object' || Array.isArray(value)) return null;
 const v=value as Record<string,unknown>;
 const minutes=v.minutes===undefined || (typeof v.minutes==='number' && Number.isInteger(v.minutes) && v.minutes>0 && v.minutes<=480);
 const until=v.until===undefined || iso(v.until);
 const subject=v.subject===undefined || v.subject==='probability' || v.subject==='adsa';
 if (v.type==='skip_class' && subject && (v.eventId===undefined || typeof v.eventId==='string'))return v as unknown as StudyIntent;
 if (v.type==='return') return {type:'return'};
 if ((v.type==='start' || v.type==='propose_start') && subject) return {type:v.type,subject:v.subject as StudySubject|undefined};
 if (v.type==='depart' && ['meal','break','class','commitment'].includes(String(v.kind)) && typeof v.title==='string' && v.title.trim().length>0 && v.title.length<=200 && minutes && until) return v as unknown as StudyIntent;
 if (['extend','class_late'].includes(String(v.type)) && minutes && until && subject && (v.eventId===undefined || (typeof v.eventId==='string' && v.eventId.length>0 && v.eventId.length<=200)) && (v.fromNow===undefined || typeof v.fromNow==='boolean')) return v as unknown as StudyIntent;
 if (v.type==='window' && iso(v.wakeAt) && iso(v.endAt)) return v as unknown as StudyIntent;
 if (v.type==='attendance' && subject && (v.start===undefined || iso(v.start)) && (v.end===undefined || iso(v.end)) && (v.eventId===undefined || (typeof v.eventId==='string' && v.eventId.length<=200))) return v as unknown as StudyIntent;
 if (v.type==='clarify' && typeof v.question==='string' && v.question.length>0 && v.question.length<=500) return {type:'clarify',question:v.question};
 return null;
}
function clock(value:string,date:string):string|null {
 const m=/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
 if (!m) return null;
 let h=Number(m[1]);const minute=Number(m[2]||0);
 if (minute>59 || h>23 || (m[3] && (h<1 || h>12))) return null;
 if (m[3]) h=h%12+(m[3].toLowerCase()==='pm'?12:0);
 return new Date(`${date}T${String(h).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+05:30`).toISOString();
}
export function fallbackStudyIntent(message:string, c:IntentContext):StudyIntent|null {
 const words:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,ninety:90};
 const text=message.toLowerCase().trim().replace(/\b(twenty|thirty|forty|fifty|sixty)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g,(_,a:string,b:string)=>String(words[a]+words[b])).replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)\b/g,w=>String(words[w])), date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(c.now);
 const subject:StudySubject|undefined=/\bprobability\b/.test(text)?'probability':/\badsa\b/.test(text)?'adsa':undefined;
 if ((c.pending?.type==='skip_class' && subject) || /\b(?:skip|skipping|miss|not attend|won.t attend)\b/.test(text) && /\b(?:class|lecture|probability|adsa)\b/.test(text)){const candidates=c.calendar.events.filter(e=>(e.kind==='class'||!!e.subject)&&Date.parse(e.end)>c.now.getTime()&&(!subject||e.subject===subject));const time=/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/.exec(text);const at=time?clock(time[1],date):null;const selected=at?candidates.filter(e=>Date.parse(e.start)===Date.parse(at)||Date.parse(e.start)===Date.parse(at)+86400000):candidates;return {type:'skip_class',subject,eventId:selected.length===1?selected[0].id:undefined};}
 const duration=/(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/.exec(text);
 const inferred=/\banother\s+(\d+)\s*$/.exec(text);
 const minutes=duration?Number(duration[1])*(/^h/.test(duration[2])?60:1):c.state.activity&&inferred?Number(inferred[1]):undefined;
 const untilMatch=/(?:until|back (?:at|by)|return (?:at|by))\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(text);
 let until=untilMatch?clock(untilMatch[1],date)||undefined:undefined;
 if(until && c.state.window && Date.parse(until)<=c.now.getTime())until=new Date(Date.parse(until)+86400000).toISOString();
 const sleepMatch=/(?:wake(?: up)?|awake) (?:at|by)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(text);
 if(/\b(?:sleep|sleeping|going to bed)\b/.test(text) && !/\band\s+sleep/.test(text)){
  let wake=sleepMatch?clock(sleepMatch[1],date):until;
  if(wake && c.state.window && Date.parse(wake)<=c.now.getTime())wake=new Date(Date.parse(wake)+86400000).toISOString();
  return {type:'depart',kind:'commitment',title:'Sleep',until:wake||undefined,minutes};
 }
 if(/\b(?:busy|appointment|errand|travel)\b/.test(text))return {type:'depart',kind:'commitment',title:'Unplanned commitment',until,minutes};
 if(c.pending?.type==='start' && /^(?:yes|yeah|ok|okay|do it|start it)[.!]?$/.test(text))return {type:'start',subject:c.pending.subject};
 if(c.pending?.type==='start' && subject && /\b(?:instead|make it|switch|rather)\b/.test(text))return {type:'propose_start',subject};
 if(/\bready to\s*study\b/.test(text))return {type:'propose_start',subject};
 const window=/wake(?:\s+up)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+and\s+(?:sleep|end(?:\s+(?:my|the))?\s+day)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(text);
 if (window) {const wakeAt=clock(window[1],date);let endAt=clock(window[2],date);if(wakeAt&&endAt&&c.state.window&&Date.parse(endAt)<=Date.parse(wakeAt))endAt=new Date(Date.parse(endAt)+86400000).toISOString();return wakeAt&&endAt?{type:'window',wakeAt,endAt}:null;}
 const times=/from\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(text);
 if (/\battended\b|\bwas in (?:the )?class\b/.test(text) || (c.pending?.type==='attendance' && times)) {
  const start=times?clock(times[1],date)||undefined:undefined,end=times?clock(times[2],date)||undefined:undefined;
  const pending=c.pending?.type==='attendance'?c.pending:undefined;
  const event=!subject || subject===pending?.event?.subject?pending?.event:undefined;
  return {type:'attendance',subject:subject||pending?.subject||event?.subject||undefined,eventId:event?.id,start,end};
 }
 const pendingClass=c.pending?.type==='class_end'?c.pending:null;
 const classSubject=subject||pendingClass?.subject||pendingClass?.event?.subject||undefined;
 const classEventId=!subject || subject===pendingClass?.event?.subject?pendingClass?.event?.id:undefined;
 if (/\b(?:class|lecture)\b.*\b(?:late|longer|overrun|running)\b/.test(text)) return {type:'class_late',minutes,until,subject:classSubject,eventId:classEventId};
 // Explicit activity identity wins over a duration-only pending follow-up.
 const meal=/\b(lunch|dinner|breakfast|meal)\b/.exec(text);
 const returnStatement=/^(?:i(?:'m| am)?\s+)?(?:back|returned)(?:\b|$)|^i(?:'m| am) back/.test(text);
 if(meal && !returnStatement) {
  const same=c.state.activity?.kind==='meal' && c.state.activity.title.toLowerCase()===meal[1];
  if(same && /\b(?:another|extend|more)\b/.test(text))return {type:'extend',minutes,until};
  if(!same || c.pending?.type!=='return_time')return {type:'depart',kind:'meal',title:meal[1],minutes,until};
 }
 if (/\b(?:taking (?:a )?break|break for|^break$)\b/.test(text)) return {type:'depart',kind:'break',title:'break',minutes,until};
 if (/\b(?:going|leaving|have|in)\b.*\b(?:class|lecture)\b/.test(text)) {
  const candidates=c.calendar.events.filter(e=>e.kind==='class' && (!subject || e.subject===subject) && Date.parse(e.end)>c.now.getTime());
  const event=candidates.length===1?candidates[0]:undefined;
  return {type:'depart',kind:'class',title:event?.title||`${subject||''} class`.trim(),eventId:event?.id,until:until||event?.end,minutes};
 }
 if(pendingClass && (minutes||until||subject))return {type:'class_late',minutes,until,subject:classSubject,eventId:classEventId};
 if(c.state.activity && /\bback in\b/.test(text) && minutes)return {type:'extend',minutes,fromNow:true};
 if (/^(?:i(?:'m| am)?\s+)?(?:back|returned)(?:\b|$)|^i(?:'m| am) back/.test(text)) return {type:'return'};
 if (/^(?:let(?:'s| us) |i want to )?(?:start|resume)(?:\b|$)/.test(text)) return {type:'start',subject};
 if (c.state.activity && (/\b(?:another|extend|more)\b/.test(text))) return {type:'extend',minutes,until};
 if (c.pending?.type==='return_time' && (minutes || until)) return {type:'extend',minutes,until,fromNow:true};
 if (meal) return {type:'depart',kind:'meal',title:meal[1],minutes,until};
 return null;
}
export async function interpretStudyIntent(message:string,c:IntentContext):Promise<StudyIntent|null> {
 const deterministic=fallbackStudyIntent(message,c);
 if (deterministic) return validateStudyIntent(deterministic);
 // Existing Vertex adapter owns credentials, bounded execution and usage logs.
 // Only text/state goes to interpretation; no capture or microphone path is used.
 try {
  const {tryGetGenAI,generateWithFallback}=await import('./ai');
  const ai=tryGetGenAI();if(!ai)return null;
  const {MODEL_PRO}=await import('./models');
  const response=await generateWithFallback(ai,{model:MODEL_PRO,contents:JSON.stringify({instruction:'Interpret the user text into ONE JSON action or null. Never claim an action executed. Never invent times, durations, attendance, wake or sleep constraints. Types: skip_class(subject?,eventId?) for explicitly skipping a calendar class; depart(kind meal|break|class|commitment,title,minutes? or until? ISO), extend(minutes? or until?), return, start(subject? probability|adsa), attendance(subject?,eventId?,start?,end? ISO actual past attendance), window(wakeAt,endAt ISO), class_late(minutes? or until?), clarify(question). Only use dates and times explicitly supplied by user, resolving clock times in Asia/Kolkata. Pending followups use provided pending context.',message,now:c.now.toISOString(),date:c.state.date,activity:c.state.activity,pending:c.pending,events:c.calendar.events}),config:{responseMimeType:'application/json',maxOutputTokens:768}},{feature:'lockin_intent',trigger:'study-chat'});
  return validateStudyIntent(JSON.parse((response.text||'null').replace(/^```(?:json)?\s*|\s*```$/g,'')));
 } catch {return null;}
}
