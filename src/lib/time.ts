/**
 * Week / time-zone math. A season is made of 7-day weeks (Mon–Sun) starting on
 * `seasonStart` (a Monday, "YYYY-MM-DD") in the league's time zone. Week N's
 * lineups lock at `lockTime` local time on week N's first day.
 *
 * Pure functions only (no DB); safe to use on client and server.
 */

const DAY_MS = 86_400_000;

/** Parse "YYYY-MM-DD" to a UTC-midnight epoch day number. */
export function dateToDayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function dayNumberToDate(day: number): string {
  const d = new Date(day * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dayNumberToDate(dateToDayNumber(date) + days);
}

/** Day of week for "YYYY-MM-DD": 0=Sunday … 6=Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(dateToDayNumber(date) * DAY_MS).getUTCDay();
}

/** The Monday on or before the given date. */
export function mondayOnOrBefore(date: string): string {
  const dow = dayOfWeek(date);
  const back = (dow + 6) % 7; // Mon=0 … Sun=6
  return addDays(date, -back);
}

/** The Monday on or after the given date. */
export function mondayOnOrAfter(date: string): string {
  const dow = dayOfWeek(date);
  const fwd = (8 - dow) % 7; // Mon->0, Tue->6, Sun->1
  return addDays(date, fwd);
}

/** Calendar date ("YYYY-MM-DD") of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Offset (ms) of the time zone from UTC at a given instant (local = utc + offset). */
function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Convert a local wall-clock time ("YYYY-MM-DD", "HH:MM") in a time zone to a UTC Date. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - tzOffsetMs(guess, timeZone);
  // Re-check at the result instant to handle DST transitions.
  const offset2 = tzOffsetMs(result, timeZone);
  result = guess - offset2;
  return new Date(result);
}

/** Week number (1-based) that a calendar date falls in. Can be <= 0 (preseason) or beyond the season. */
export function weekOfDate(date: string, seasonStart: string): number {
  const diff = dateToDayNumber(date) - dateToDayNumber(seasonStart);
  return Math.floor(diff / 7) + 1;
}

/** First day (Monday) of a week. */
export function weekStartDate(week: number, seasonStart: string): string {
  return addDays(seasonStart, (week - 1) * 7);
}

/** Last day (Sunday) of a week. */
export function weekEndDate(week: number, seasonStart: string): string {
  return addDays(seasonStart, (week - 1) * 7 + 6);
}

/** Instant at which week N's lineups lock. */
export function weekLockTime(week: number, seasonStart: string, lockTime: string, timeZone: string): Date {
  return zonedTimeToUtc(weekStartDate(week, seasonStart), lockTime, timeZone);
}

export type WeekClock = {
  seasonStart: string;
  lockTime: string;
  timeZone: string;
};

/** The week "now" falls in (by local calendar date). Can be <= 0 before the season. */
export function currentWeek(now: Date, c: WeekClock): number {
  return weekOfDate(localDate(now, c.timeZone), c.seasonStart);
}

/** True once week N's lineups are locked. */
export function isWeekLocked(week: number, now: Date, c: WeekClock): boolean {
  return now.getTime() >= weekLockTime(week, c.seasonStart, c.lockTime, c.timeZone).getTime();
}

/**
 * The earliest week whose lineup can still be edited (its lock is in the future).
 * Before the season this is week 1.
 */
export function editableWeek(now: Date, c: WeekClock): number {
  let w = Math.max(1, currentWeek(now, c));
  while (isWeekLocked(w, now, c)) w++;
  return w;
}

/** Next occurrence (strictly after `after`) of a weekly local day/time. */
export function nextWeeklyTime(after: Date, dayOfWeekTarget: number, time: string, timeZone: string): Date {
  const today = localDate(after, timeZone);
  for (let i = 0; i <= 8; i++) {
    const d = addDays(today, i);
    if (dayOfWeek(d) !== dayOfWeekTarget) continue;
    const t = zonedTimeToUtc(d, time, timeZone);
    if (t.getTime() > after.getTime()) return t;
  }
  // Unreachable in practice.
  return zonedTimeToUtc(addDays(today, 7), time, timeZone);
}

export function formatDate(date: string): string {
  const d = new Date(dateToDayNumber(date) * DAY_MS);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatShortDate(date: string): string {
  const d = new Date(dateToDayNumber(date) * DAY_MS);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatDateTime(instant: Date, timeZone: string): string {
  return instant.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function todayIn(timeZone: string, now: Date = new Date()): string {
  return localDate(now, timeZone);
}
