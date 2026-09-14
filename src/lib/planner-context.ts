export interface PlannerCalendarEvent {
  id?: string;
  title: string;
  start_time: string;
  end_time: string;
  ignoredForPlan?: boolean;
  ignoreReason?: string | null;
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
