function calendarDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return date;
}

function midnightInZone(value: string, timezone: string): string {
  const target = calendarDate(value).getTime();
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = target;
  // Resolve the offset at the requested date, including changes between the two range bounds.
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(format.formatToParts(instant).map(({ type, value: part }) => [type, part]));
    const wallClock = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const difference = target - wallClock;
    if (difference === 0) return new Date(instant).toISOString();
    instant += difference;
  }
  throw new RangeError('This calendar midnight does not exist in the reporting timezone');
}

export function reportingDateRange(from: string, until: string, timezone: string | undefined): { from?: string; to?: string } {
  if (!from && !until) return {};
  if (!timezone) throw new RangeError('Reporting timezone is unavailable');
  if (from) calendarDate(from);
  if (until) calendarDate(until);
  if (from && until && from > until) throw new RangeError('Inverted calendar range');
  const range: { from?: string; to?: string } = {};
  if (from) range.from = midnightInZone(from, timezone);
  if (until) {
    const nextDay = calendarDate(until);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    range.to = midnightInZone(nextDay.toISOString().slice(0, 10), timezone);
  }
  return range;
}

export function reportingDateInput(value: string | null | undefined, timezone: string | undefined, exclusiveEnd = false): string {
  if (!value) return '';
  if (!timezone) return value.slice(0, 10);
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant - (exclusiveEnd ? 1 : 0)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
