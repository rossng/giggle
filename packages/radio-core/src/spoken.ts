/**
 * Dates, times and prices the way a British radio presenter would say them:
 * "on Thursday the sixteenth of October", "at 2:30pm", "about 24 euros".
 * Nothing here ever produces digits after a decimal point in a price, a currency
 * symbol, or a date in figures.
 */

import { calendarDaysBetween, DEFAULT_TIME_ZONE, zonedParts } from "./time.ts";

export const ORDINALS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "twenty-first",
  "twenty-second",
  "twenty-third",
  "twenty-fourth",
  "twenty-fifth",
  "twenty-sixth",
  "twenty-seventh",
  "twenty-eighth",
  "twenty-ninth",
  "thirtieth",
  "thirty-first",
] as const;

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type DayKind = "today" | "this_afternoon" | "tonight" | "tomorrow" | "tomorrow_night" | "weekday" | "date";

export interface SpokenDay {
  kind: DayKind;
  /** Fits after a place: "tonight", "on Thursday", "on Thursday the sixteenth of October". */
  phrase: string;
  /** Stands on its own: "tonight", "Thursday", "Thursday the sixteenth of October". */
  bare: string;
}

/** Evening starts here, for "tonight" and "tomorrow night". */
export const EVENING_HOUR = 17;
/** Gigs starting before this hour after midnight still count as the night before. */
const LATE_NIGHT_HOUR = 5;

/**
 * When a gig is, relative to `now`: "tonight" (or "this afternoon" / "today"),
 * "tomorrow" (or "tomorrow night"), "on Thursday" within the coming week, and
 * "on Thursday the sixteenth of October" further out.
 */
export function spokenDay(
  startIso: string,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): SpokenDay {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return { kind: "today", phrase: "soon", bare: "soon" };
  const p = zonedParts(start, timeZone);
  let days = calendarDaysBetween(now, start, timeZone);
  let hour = p.hour;
  // Just after midnight is still tonight (or tomorrow night). Further out the
  // listing's own date is said, as the venue lists it.
  if ((days === 1 || days === 2) && hour < LATE_NIGHT_HOUR) {
    days -= 1;
    hour += 24;
  }
  if (days < 0) return same("today"); // started on an earlier day and still going
  if (days === 0) {
    if (hour >= EVENING_HOUR) return same("tonight");
    if (hour >= 12) return { kind: "this_afternoon", phrase: "this afternoon", bare: "this afternoon" };
    return same("today");
  }
  if (days === 1) {
    if (hour >= EVENING_HOUR) return { kind: "tomorrow_night", phrase: "tomorrow night", bare: "tomorrow night" };
    return same("tomorrow");
  }
  const weekday = WEEKDAYS[p.weekday] ?? "";
  if (days <= 6) return { kind: "weekday", phrase: `on ${weekday}`, bare: weekday };
  const bare = `${weekday} the ${ORDINALS[p.day] ?? ""} of ${MONTHS[p.month - 1] ?? ""}`;
  return { kind: "date", phrase: `on ${bare}`, bare };
}

function same(kind: "today" | "tonight" | "tomorrow"): SpokenDay {
  return { kind, phrase: kind, bare: kind };
}

/**
 * Start time: "8pm", "8:30pm", "11am", "midday". Null for exactly midnight, which
 * listings use when they don't know the time. A colon, not a dot: Kokoro's text
 * normalisation reads "8.30" as "eight point three zero" but "8:30" as "eight thirty".
 */
export function spokenTime(startIso: string, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  const { hour, minute } = zonedParts(start, timeZone);
  if (hour === 0 && minute === 0) return null;
  if (hour === 12 && minute === 0) return "midday";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "am" : "pm";
  return minute ? `${h12}:${String(minute).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** Whether an amount is a whole number of euros (allowing for float noise). */
export function isWholeEuros(eur: number): boolean {
  return Math.abs(eur - Math.round(eur)) < 0.005;
}

/**
 * A price in whole euros: 17 → "17 euros", 23.5 → "about 24 euros", 1 → "1 euro".
 * Null for anything that isn't a positive, finite amount.
 */
export function spokenPrice(eur: number | null | undefined): string | null {
  if (typeof eur !== "number" || !Number.isFinite(eur) || eur <= 0) return null;
  const rounded = Math.max(1, Math.round(eur));
  const amount = `${rounded} ${rounded === 1 ? "euro" : "euros"}`;
  return isWholeEuros(eur) ? amount : `about ${amount}`;
}

/** 2 → "second", 3 → "third"…; undefined outside 1–31. */
export function ordinalWord(n: number): string | undefined {
  return Number.isInteger(n) && n > 0 ? ORDINALS[n] : undefined;
}
