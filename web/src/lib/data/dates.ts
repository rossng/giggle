// Calendar helpers. Every venue is in the Netherlands and gig times carry Amsterdam's
// offset, so a gig's local date and time are simply the start of its ISO string. Dates are
// handled as "YYYY-MM-DD" strings, with UTC arithmetic so DST never shifts a day.

import type { IsoDate, IsoDateTime } from './types';

export const TIME_ZONE = 'Europe/Amsterdam';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const amsterdam = new Intl.DateTimeFormat('en-GB', {
	timeZone: TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** Today's date in Amsterdam at the instant `now`. */
export function amsterdamDate(now: Date): IsoDate {
	const parts = Object.fromEntries(amsterdam.formatToParts(now).map((p) => [p.type, p.value]));
	return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The local (Amsterdam) date of a gig time. */
export function localDate(iso: IsoDateTime): IsoDate {
	return iso.slice(0, 10);
}

/** The local time of a gig time, "20:30". */
export function localTime(iso: IsoDateTime): string {
	return iso.slice(11, 16);
}

function toUtc(date: IsoDate): Date {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): IsoDate {
	return d.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
	const d = toUtc(date);
	d.setUTCDate(d.getUTCDate() + days);
	return fromUtc(d);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
	return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: IsoDate): number {
	return (toUtc(date).getUTCDay() + 6) % 7;
}

/** The Monday of the week `date` falls in. */
export function weekStart(date: IsoDate): IsoDate {
	return addDays(date, -weekdayIndex(date));
}

export interface DayParts {
	weekday: string;
	day: number;
	month: string;
	year: number;
}

export function dayParts(date: IsoDate): DayParts {
	const d = toUtc(date);
	return {
		weekday: WEEKDAYS[weekdayIndex(date)],
		day: d.getUTCDate(),
		month: MONTHS[d.getUTCMonth()],
		year: d.getUTCFullYear()
	};
}

/** "Fri 3 Oct", with the year when it isn't `thisYear`. */
export function formatDay(date: IsoDate, thisYear?: number): string {
	const p = dayParts(date);
	const year = thisYear !== undefined && p.year !== thisYear ? ` ${p.year}` : '';
	return `${p.weekday} ${p.day} ${p.month}${year}`;
}

/** "29 Sep – 26 Dec 2026" for the days from `first` to `last`, inclusive. */
export function formatRange(first: IsoDate, last: IsoDate): string {
	const a = dayParts(first);
	const b = dayParts(last);
	const left = a.year === b.year ? `${a.day} ${a.month}` : `${a.day} ${a.month} ${a.year}`;
	return `${left} – ${b.day} ${b.month} ${b.year}`;
}

/** Heading for the week starting `monday`, seen from `today`. */
export function weekLabel(monday: IsoDate, today: IsoDate): string {
	const weeks = Math.round(daysBetween(weekStart(today), monday) / 7);
	if (weeks === 0) return 'This week';
	if (weeks === 1) return 'Next week';
	const p = dayParts(monday);
	const year = p.year !== dayParts(today).year ? ` ${p.year}` : '';
	return `Week of ${p.day} ${p.month}${year}`;
}

/** "today", "tomorrow", "in 5 days", "in 3 wks". */
export function relativeDays(date: IsoDate, today: IsoDate): string {
	const n = daysBetween(today, date);
	if (n < 0) return n === -1 ? 'yesterday' : `${-n} days ago`;
	if (n === 0) return 'today';
	if (n === 1) return 'tomorrow';
	if (n < 14) return `in ${n} days`;
	if (n < 60) return `in ${Math.round(n / 7)} wks`;
	return `in ${Math.round(n / 30)} months`;
}
