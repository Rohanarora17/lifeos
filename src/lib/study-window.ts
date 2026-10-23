import { getSetting } from './db';
import { ENDSEM_END } from './endsem-contract';
const DAY = 86_400_000;
export function studyCalendarDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function getStudyWindow(now = new Date()) {
  const anchor = Date.parse(getSetting('study_window_anchor_at') || '');
  const rolling = Number.isFinite(anchor);
  const campaignEnd=Date.parse(`${ENDSEM_END}T00:00:00+05:30`)+DAY;
  const index = rolling ? Math.max(0,Math.min(Math.floor((now.getTime()-anchor)/DAY),Math.floor((campaignEnd-1-anchor)/DAY))) : 0;
  const start = rolling ? anchor + index*DAY : Date.parse(`${studyCalendarDate(now)}T00:00:00+05:30`);
  const end = Math.min(start+DAY,Date.parse(`${ENDSEM_END}T00:00:00+05:30`)+DAY);
  return {mode:rolling?'consecutive24' as const:'calendarDay' as const,key:studyCalendarDate(new Date(start)),start,end,anchor:rolling?anchor:null,index};
}
