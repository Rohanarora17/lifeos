export interface PlannerCalendarEvent {
  id?: string;
  title: string;
  start_time: string;
  end_time: string;
  ignoredForPlan?: boolean;
  ignoreReason?: string | null;
}

export interface TypedPlanConstraint {
  title: string;
  startIso: string;
  endIso: string;
  sourceText: string;
}

const CONSTRAINT_CUE = /\b(meeting|call|class|lecture|appointment|doctor|gym|lunch|dinner|commute|travel)\b/i;
const TIME_RANGE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|until|[-–])\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const normalized = hour % 12;
  return meridiem.toLowerCase() === 'pm' ? normalized + 12 : normalized;
}

function constraintTitle(cue: string): string {
  const normalized = cue.toLowerCase();
  if (normalized === 'doctor') return 'Doctor appointment';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function extractTypedPlanConstraints(input: {
  planDate: string;
  text: string | null | undefined;
}): TypedPlanConstraint[] {
  const text = input.text?.trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?\n]+[.!?]?/g) ?? [];
  const constraints: TypedPlanConstraint[] = [];

  for (const rawSentence of sentences) {
    const sourceText = rawSentence.trim();
    const cue = sourceText.match(CONSTRAINT_CUE)?.[1];
    const time = sourceText.match(TIME_RANGE);
    if (!cue || !time) continue;
    const startMeridiem = time[3] || time[6];
    const endMeridiem = time[6] || time[3];
    const startHour = to24Hour(Number(time[1]), startMeridiem);
    let endHour = to24Hour(Number(time[4]), endMeridiem);
    const startMinute = Number(time[2] || 0);
    const endMinute = Number(time[5] || 0);
    if (endHour * 60 + endMinute <= startHour * 60 + startMinute) endHour += 24;
    if (startHour > 23 || endHour > 23) continue;
    const hh = (value: number) => String(value).padStart(2, '0');
    constraints.push({
      title: constraintTitle(cue),
      startIso: `${input.planDate}T${hh(startHour)}:${hh(startMinute)}:00.000+05:30`,
      endIso: `${input.planDate}T${hh(endHour)}:${hh(endMinute)}:00.000+05:30`,
      sourceText,
    });
  }
  return constraints;
}

export function stripConstraintText(text: string | null | undefined, constraints: TypedPlanConstraint[]): string | null {
  if (!text) return null;
  let workText = text;
  for (const constraint of constraints) workText = workText.replace(constraint.sourceText, ' ');
  workText = workText.replace(/\s+/g, ' ').trim();
  return workText || null;
}

export function interpretPlanningContext(input: {
  intention: string | null;
  eveningNotes: string | null;
  calendarEvents: PlannerCalendarEvent[];
}): {
  signals: string[];
  ignoredCalendarEventIds: string[];
  effectiveCalendarEvents: PlannerCalendarEvent[];
  calendarEvents: PlannerCalendarEvent[];
} {
  const text = `${input.intention ?? ''}\n${input.eveningNotes ?? ''}`.toLowerCase();
  const explicitHoliday = /\bholiday\b|\bno classes?\b|classes? (?:are )?(?:cancelled|canceled)/i.test(text);
  const ignoreAllCalendar = /ignore\b[^.\n]{0,50}\b(?:calendar(?: events?)?|all events?)\b/i.test(text);
  const ignoreClasses = /ignore\b[^.\n]{0,50}\bclasses?\b/i.test(text) || explicitHoliday;
  const classLike = (event: PlannerCalendarEvent) => /\b(?:class|lecture|course|cs\d{3,4}|ee\d{3,4})\b/i.test(event.title);
  const ignored = input.calendarEvents.filter(event => ignoreAllCalendar || (ignoreClasses && classLike(event)));
  const ignoredIds = new Set(ignored.map((event, index) => event.id || `${event.start_time}:${event.title}:${index}`));
  const annotated = input.calendarEvents.map((event, index) => {
    const id = event.id || `${event.start_time}:${event.title}:${index}`;
    const isIgnored = ignoredIds.has(id);
    return {
      ...event,
      id,
      ignoredForPlan: isIgnored,
      ignoreReason: isIgnored
        ? explicitHoliday ? 'holiday or no-class context supplied by you' : 'explicitly ignored in plan context'
        : null,
    };
  });
  const signals: string[] = [];
  if (explicitHoliday) signals.push('Holiday or no-class day');
  if (ignoredIds.size > 0) signals.push(`${ignoredIds.size} calendar item${ignoredIds.size === 1 ? '' : 's'} ignored for this plan`);
  if (/\blate(?:-| )night\b|\bstay(?:ing)? up late\b|\bup late\b/i.test(text)) signals.push('Late-night schedule requested');

  return {
    signals,
    ignoredCalendarEventIds: [...ignoredIds],
    effectiveCalendarEvents: annotated.filter(event => !event.ignoredForPlan),
    calendarEvents: annotated,
  };
}
