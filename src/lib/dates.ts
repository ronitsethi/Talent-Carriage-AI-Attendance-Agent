/** Small date helpers shared by the server actions and the pages. */

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A month at a time is plenty, and it stops a typo sweeping five years. */
export const MAX_RANGE_DAYS = 62;

/** Every date from `from` to `to`, inclusive. Empty when the range makes no sense. */
export function datesInRange(from: string, to: string): string[] {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];

  const dates: string[] = [];
  for (let day = start; day <= end && dates.length < MAX_RANGE_DAYS; day = new Date(day.getTime() + 86_400_000)) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Today as the customer's own calendar has it.
 *
 * In Asia/Kolkata the UTC date is yesterday's until half past five in the
 * morning, which is exactly when a night shift's absences are being chased.
 * 'en-CA' formats as YYYY-MM-DD, which is what a date input wants.
 */
export function today(timezone?: string, at = new Date()): string {
  if (!timezone) return at.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The dashboard's opening range: today and the week behind it.
 *
 * Absences are chased within days, so this is the window that matters. It used
 * to open on the newest date that had cases, which drifted further into the
 * past the longer a customer went without importing.
 */
export function defaultRange(timezone?: string, at = new Date()): { from: string; to: string } {
  return { from: today(timezone, new Date(at.getTime() - 7 * 86_400_000)), to: today(timezone, at) };
}

/**
 * Working days: Monday to Friday, and Saturday when the customer works it.
 * Nothing is sent, and no step counted, on any other day.
 */
export function isWorkingDay(isoDate: string, settings: { saturdayWorking: boolean }): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (day === 0) return false;
  if (day === 6) return settings.saturdayWorking;
  return true;
}

/** The working day `n` working days after `isoDate` (0 = that day, or the next working one if it is not). */
export function addWorkingDays(isoDate: string, n: number, settings: { saturdayWorking: boolean }): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  let left = n;
  while (!isWorkingDay(d.toISOString().slice(0, 10), settings)) d.setUTCDate(d.getUTCDate() + 1);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(d.toISOString().slice(0, 10), settings)) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** 10 in the morning of a date, in the customer's timezone: when a working-day step falls due. */
export function morningOf(isoDate: string, timezone: string): Date {
  // The offset of the timezone on that day, worked out from how it shows noon UTC.
  const noon = new Date(`${isoDate}T12:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(noon).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const offsetMinutes = (Number(parts.hour) - 12) * 60 + Number(parts.minute);
  return new Date(Date.parse(`${isoDate}T10:00:00Z`) - offsetMinutes * 60_000);
}
