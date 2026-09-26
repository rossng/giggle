/** Calendar helpers in a named time zone (Europe/Amsterdam unless told otherwise). */

export const DEFAULT_TIME_ZONE = "Europe/Amsterdam";
export const DAY_MS = 86_400_000;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
  /** 0–23 */
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const year = parts.year ?? 1970;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour: (parts.hour ?? 0) % 24, minute: parts.minute ?? 0, weekday };
}

/** Whole calendar days from `now` to `date` in `timeZone` (0 = same day, 1 = tomorrow). */
export function calendarDaysBetween(
  now: Date,
  date: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const a = zonedParts(now, timeZone);
  const b = zonedParts(date, timeZone);
  const ua = Date.UTC(a.year, a.month - 1, a.day);
  const ub = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((ub - ua) / DAY_MS);
}

/** Milliseconds since the epoch of an ISO string, or NaN when it doesn't parse. */
export function isoMs(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}
