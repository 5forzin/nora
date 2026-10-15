import { describe, expect, it } from 'vitest';
import { reportingDateInput, reportingDateRange } from './date-range';

describe('reporting calendar ranges', () => {
  it('includes the whole Brazilian day with an exclusive next-day boundary', () => {
    expect(reportingDateRange('2026-10-14', '2026-10-14', 'America/Sao_Paulo')).toEqual({
      from: '2026-10-14T03:00:00.000Z', to: '2026-10-15T03:00:00.000Z',
    });
    expect(reportingDateInput('2026-10-15T03:00:00.000Z', 'America/Sao_Paulo', true)).toBe('2026-10-14');
  });

  it.each([
    ['2026-10-31', '2026-11-01T03:00:00.000Z'],
    ['2026-12-31', '2027-01-01T03:00:00.000Z'],
    ['2024-02-29', '2024-03-01T03:00:00.000Z'],
  ])('advances %s across calendar boundaries', (until, to) => {
    expect(reportingDateRange('', until, 'America/Sao_Paulo')).toEqual({ to });
  });

  it('uses the supplied reporting zone and its offset on each bound', () => {
    expect(reportingDateRange('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({
      from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z',
    });
    expect(reportingDateRange('2026-10-14', '', 'Asia/Kathmandu')).toEqual({ from: '2026-10-13T18:15:00.000Z' });
    expect(reportingDateInput('2026-10-13T18:15:00.000Z', 'Asia/Kathmandu')).toBe('2026-10-14');
  });

  it.each([
    ['2026-02-30', '2026-03-01', 'America/Sao_Paulo'],
    ['2026-10-15', '2026-10-14', 'America/Sao_Paulo'],
    ['2026-10-14', '', undefined],
    ['2026-10-14', '', 'Invalid/Timezone'],
  ])('rejects invalid dates, ranges or missing timezone: %s %s %s', (from, to, timezone) => {
    expect(() => reportingDateRange(from, to, timezone)).toThrow(RangeError);
  });

  it('allows clearing the range without choosing an invented timezone', () => {
    expect(reportingDateRange('', '', undefined)).toEqual({});
    expect(reportingDateInput(undefined, undefined)).toBe('');
  });
});
