export const LIFEOS_TIME_ZONE = process.env.LIFEOS_TIME_ZONE?.trim() || 'Asia/Kolkata';

export function lifeosDateKey(value: Date | number = new Date()) {
  const date = typeof value === 'number' ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LIFEOS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function lifeosTime(value: Date | number, options?: Intl.DateTimeFormatOptions) {
  const date = typeof value === 'number' ? new Date(value) : value;
  return date.toLocaleTimeString('en-IN', {
    timeZone: LIFEOS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}

function zonedMidnightUtc(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Invalid LifeOS date: ${dateKey}`);
  const targetWallClock = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = targetWallClock;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: LIFEOS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value || 0);
    const representedWallClock = Date.UTC(
      part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'),
    );
    candidate += targetWallClock - representedWallClock;
  }
  return candidate;
}

export function lifeosDayBoundsUtc(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const nextDateKey = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return {
    startIso: new Date(zonedMidnightUtc(dateKey)).toISOString(),
    endIso: new Date(zonedMidnightUtc(nextDateKey)).toISOString(),
  };
}
