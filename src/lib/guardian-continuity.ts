type ContinuityEvent = {
  type: string;
  url?: string;
  domain?: string;
  payload?: Record<string, unknown>;
};

function isContinuityEvent(event: ContinuityEvent) {
  return event.type === 'tab' || event.type === 'native_context';
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function continuityContextKey(event: ContinuityEvent): string | null {
  if (!isContinuityEvent(event)) return null;
  if (event.type === 'native_context') {
    const app = typeof event.payload?.appInFocus === 'string' ? event.payload.appInFocus.trim().toLowerCase() : '';
    // Chrome detail belongs to the extension. Native Chrome events are fallback
    // evidence, not a context change away from the current browser page.
    if (app === 'google chrome' || app === 'chrome') return null;
    return app ? `native:${app}` : null;
  }
  if (event.url) return `tab:${normalizedUrl(event.url)}`;
  if (event.domain) return `domain:${event.domain.trim().toLowerCase()}`;
  return null;
}

export function compactContinuityEvents<T extends ContinuityEvent>(events: T[]): T[] {
  const compacted: T[] = [];
  let previousKey: string | null = null;
  for (const event of events) {
    const key = continuityContextKey(event);
    if (!key) continue;
    if (key === previousKey) continue;
    compacted.push(event);
    previousKey = key;
  }
  return compacted;
}

export function countMeaningfulContextSwitches(events: ContinuityEvent[]) {
  return Math.max(0, compactContinuityEvents(events).length - 1);
}

export function countDistractionRevisits(events: ContinuityEvent[]) {
  const visits = new Map<string, number>();
  let revisits = 0;
  for (const event of compactContinuityEvents(events)) {
    if (event.payload?.classification !== 'distraction') continue;
    let key = event.domain?.trim().toLowerCase() || null;
    if (!key && event.url) {
      try { key = new URL(event.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* use context key below */ }
    }
    key ||= continuityContextKey(event);
    if (!key) continue;
    const prior = visits.get(key) || 0;
    if (prior > 0) revisits += 1;
    visits.set(key, prior + 1);
  }
  return revisits;
}

export function averageContinuousDwellSeconds(events: Array<ContinuityEvent & { dwellSeconds?: number }>) {
  const runs: Array<{ key: string; seconds: number }> = [];
  for (const event of events) {
    const key = continuityContextKey(event);
    if (!key) continue;
    const seconds = Math.max(0, Number(event.dwellSeconds || 0));
    const current = runs.at(-1);
    if (current?.key === key) current.seconds += seconds;
    else runs.push({ key, seconds });
  }
  return runs.length > 0 ? runs.reduce((sum, run) => sum + run.seconds, 0) / runs.length : 0;
}
