import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveCalendarPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  headline: string;
  subhead: string;
  emptyTitle: string;
  emptyMessage: string;
  emptyAction: string;
  emphasis: 'protect_focus' | 'plan_focus' | 'recover' | 'sync_calendar' | 'review';
  plannedFocus: PersonalizationSnapshot['today']['plannedFocus'];
  nextBestFocusWindow: string;
}

export function buildAdaptiveCalendarPolicy(
  snapshot: PersonalizationSnapshot,
  view: 'today' | 'upcoming',
  eventCount: number,
): AdaptiveCalendarPolicy {
  const planned = snapshot.today.plannedFocus;
  const hasEvents = eventCount > 0;
  const viewLabel = view === 'today' ? 'today' : 'the next 7 days';

  if (snapshot.moment.mode === 'protect_focus' || planned.nextTitle) {
    const title = planned.nextTitle ?? snapshot.activeSession?.targetTitle ?? 'the current focus block';
    const minutes = planned.nextMinutes ? ` for ${planned.nextMinutes}m` : '';
    return {
      mode: snapshot.moment.mode,
      headline: `Protect ${title}`,
      subhead: hasEvents
        ? `Calendar has ${eventCount} event${eventCount === 1 ? '' : 's'} for ${viewLabel}; keep the focus block insulated.`
        : `No calendar event is blocking ${title}${minutes}.`,
      emptyTitle: 'No calendar conflict',
      emptyMessage: `Keep the space clear for ${title}${minutes}. If real-world plans changed, sync before starting.`,
      emptyAction: 'Start or adjust the planned block',
      emphasis: 'protect_focus',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Find room for deadline relief',
      subhead: hasEvents
        ? `${eventCount} calendar event${eventCount === 1 ? '' : 's'} must leave a real work slot.`
        : 'No events are blocking the calendar; schedule the highest-pressure task into a real slot.',
      emptyTitle: 'No calendar blockers',
      emptyMessage: 'Use the open space for the nearest deadline before adding optional work.',
      emptyAction: 'Schedule the pressure block',
      emphasis: 'plan_focus',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'recovery') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Keep the day lighter',
      subhead: hasEvents
        ? `${eventCount} event${eventCount === 1 ? '' : 's'} already tax capacity; leave buffer around them.`
        : 'No events are scheduled, so use the room for a smaller recovery-safe block.',
      emptyTitle: 'Open calendar',
      emptyMessage: 'Do not fill every gap. Pick one low-friction block and preserve recovery buffer.',
      emptyAction: 'Add one light block',
      emphasis: 'recover',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'planning' || view === 'upcoming') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Use calendar as planning context',
      subhead: hasEvents
        ? `${eventCount} event${eventCount === 1 ? '' : 's'} should shape the next-day plan.`
        : `No events found for ${viewLabel}; sync or add constraints before trusting open space.`,
      emptyTitle: 'No planning constraints',
      emptyMessage: 'Add fixed commitments or sync calendar so tomorrow planning can place focus blocks realistically.',
      emptyAction: 'Sync calendar or plan tomorrow',
      emphasis: 'sync_calendar',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  return {
    mode: snapshot.moment.mode,
    headline: 'Calendar and focus should agree',
    subhead: hasEvents
      ? `${eventCount} event${eventCount === 1 ? '' : 's'} loaded for ${viewLabel}; compare them against the next useful focus window.`
      : `No events found for ${viewLabel}; use ${snapshot.userState.nextBestFocusWindow || 'your learned focus window'} for intentional work.`,
    emptyTitle: 'No events here',
    emptyMessage: snapshot.userState.nextBestFocusWindow
      ? `Calendar is open. The learned focus window is ${snapshot.userState.nextBestFocusWindow}.`
      : 'Calendar is open. Add a planned focus block so this page can compare commitments against real work.',
    emptyAction: 'Create a focus block',
    emphasis: 'review',
    plannedFocus: planned,
    nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
  };
}
