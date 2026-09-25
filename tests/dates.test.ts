import { describe, expect, it } from 'vitest';
import { datesInRange, MAX_RANGE_DAYS } from '@/lib/dates';

describe('date ranges', () => {
  it('includes both ends', () => {
    expect(datesInRange('2026-08-17', '2026-08-20')).toEqual([
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
    ]);
  });

  it('treats one day as a range of one', () => {
    expect(datesInRange('2026-08-18', '2026-08-18')).toEqual(['2026-08-18']);
  });

  it('crosses month and year boundaries', () => {
    expect(datesInRange('2026-08-30', '2026-09-01')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
    expect(datesInRange('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('refuses a backwards or malformed range rather than guessing', () => {
    expect(datesInRange('2026-08-20', '2026-08-17')).toEqual([]);
    expect(datesInRange('20-08-2026', '2026-08-20')).toEqual([]);
    expect(datesInRange('', '')).toEqual([]);
  });

  it('caps a huge range instead of sweeping years of data', () => {
    expect(datesInRange('2020-01-01', '2030-01-01')).toHaveLength(MAX_RANGE_DAYS);
  });
});
