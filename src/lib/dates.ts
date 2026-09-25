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
