// What the admin panel works out from the overview: day-by-day and week-by-week series with the
// gaps filled, chart scales, the users table's order, and flags for possible abuse.

import { COLLECTIONS, type AdminUser, type DayStats, type Overview } from './api';

const DAY_MS = 86_400_000;

export interface Point {
	/** The day, or the Monday a week starts on. */
	day: string;
	value: number;
}

const parse = (day: string) => Date.parse(`${day}T00:00:00Z`);
const format = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The UTC day `n` days after `day` (before, if negative). */
export function addDays(day: string, n: number): string {
	return format(parse(day) + n * DAY_MS);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
	return Math.round((parse(to) - parse(from)) / DAY_MS);
}

/** One of daily_stats' counters for the `n` days up to `end`, oldest first, 0 where missing. */
export function daily(
	days: DayStats[],
	key: Exclude<keyof DayStats, 'day'>,
	end: string,
	n: number
): Point[] {
	const byDay = new Map(days.map((d) => [d.day, d[key]]));
	return Array.from({ length: n }, (_, i) => {
		const day = addDays(end, i - n + 1);
		return { day, value: byDay.get(day) ?? 0 };
	});
}

/** The Monday of `day`'s week (ISO weeks, UTC). */
export function weekOf(day: string): string {
	const weekday = (new Date(parse(day)).getUTCDay() + 6) % 7;
	return addDays(day, -weekday);
}

/**
 * Sums a daily series by week (Monday first). A week the series starts partway through is left
 * out, so every bar but the current week's counts seven days.
 */
export function weekly(points: Point[]): Point[] {
	const weeks: Point[] = [];
	for (const p of points) {
		const monday = weekOf(p.day);
		const last = weeks.at(-1);
		if (last?.day === monday) last.value += p.value;
		else if (monday === p.day || weeks.length) weeks.push({ day: monday, value: p.value });
	}
	return weeks;
}

/** A round number at least `max` for a chart's top: 1, 1.5, 2, 3 … 8 × a power of ten, 1 at least. */
export function niceMax(max: number): number {
	if (!(max > 1)) return 1;
	const power = 10 ** Math.floor(Math.log10(max));
	for (const step of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) if (step * power >= max) return step * power;
	return 10 * power;
}

/** Gridlines for a chart topped at `top` (from niceMax): 0, the middle when whole, and the top. */
export function ticks(top: number): number[] {
	return top % 2 === 0 && top >= 2 ? [0, top / 2, top] : [0, top];
}

export const totalRows = (u: AdminUser) => COLLECTIONS.reduce((n, c) => n + u.rows[c], 0);

/** Accounts active in the `days` days up to and including `today`. */
export function activeWithin(users: AdminUser[], today: string, days: number): number {
	const since = addDays(today, 1 - days);
	return users.filter((u) => u.last_seen !== null && u.last_seen >= since).length;
}

export type SortKey =
	'id' | 'last_seen' | 'created' | 'passkeys' | 'sessions' | 'rows' | 'bytes' | 'written_today';

function sortValue(u: AdminUser, key: SortKey): string | number {
	if (key === 'rows') return totalRows(u);
	if (key === 'last_seen') return u.last_seen ?? '';
	return u[key];
}

/** The users in `key` order (`desc`: largest or latest first); ties by id, so it's stable. */
export function sortUsers(users: AdminUser[], key: SortKey, desc: boolean): AdminUser[] {
	return [...users].sort((a, b) => {
		const x = sortValue(a, key);
		const y = sortValue(b, key);
		const order = x < y ? -1 : x > y ? 1 : 0;
		return (desc ? -order : order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	});
}

export interface Flag {
	title: string;
	detail: string;
	/** Accounts it's about (short ids), marked in the table. */
	ids: string[];
}

/** Share of a limit that counts as near it. */
export const NEAR = 0.8;
/** Sign-ups a day that count as a burst however quiet the rest is. */
const BURST_MIN = 10;
/** Today's writes below this are too few to worry who made them. */
const BUSY_DAY_ROWS = 1000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n: number) => n.toLocaleString('en-GB');

/** Things that may be abuse, most pressing first. Days are the last 90 of the overview. */
export function flags(o: Overview): Flag[] {
	const out: Flag[] = [];
	const window = o.days.filter((d) => d.day > addDays(o.today, -90));
	const { limits } = o;

	const mean = window.reduce((n, d) => n + d.new_accounts, 0) / 90;
	const capped = window.filter((d) => d.new_accounts >= limits.newAccountsPerDay);
	const bursts = window.filter(
		(d) =>
			d.new_accounts < limits.newAccountsPerDay && d.new_accounts >= Math.max(BURST_MIN, 4 * mean)
	);
	if (capped.length || bursts.length) {
		const list = [...capped, ...bursts]
			.sort((a, b) => (a.day < b.day ? 1 : -1))
			.map((d) => `${d.day} (${d.new_accounts})`)
			.join(', ');
		out.push({
			title: capped.length
				? `The new-account cap (${limits.newAccountsPerDay} a day) was reached on ${plural(capped.length, 'day')}`
				: `Unusually many sign-ups on ${plural(bursts.length, 'day')}`,
			detail: `Sign-ups: ${list}.`,
			ids: []
		});
	}

	const budget = o.users.filter((u) => u.written_today >= NEAR * limits.dailyRows);
	if (budget.length) {
		out.push({
			title: `${plural(budget.length, 'account')} near the daily write budget`,
			detail: `${NEAR * 100}% or more of ${num(limits.dailyRows)} rows written today.`,
			ids: budget.map((u) => u.id)
		});
	}

	const writtenToday = Math.max(
		o.users.reduce((n, u) => n + u.written_today, 0),
		o.days.find((d) => d.day === o.today)?.rows_written ?? 0
	);
	const top = o.users.reduce<AdminUser | null>(
		(best, u) => (u.written_today > (best?.written_today ?? 0) ? u : best),
		null
	);
	if (top && writtenToday >= BUSY_DAY_ROWS && top.written_today > writtenToday / 2) {
		const share = Math.round((100 * top.written_today) / writtenToday);
		out.push({
			title: `One account made ${share}% of today's writes`,
			detail: `${num(top.written_today)} of ${num(writtenToday)} rows.`,
			ids: [top.id]
		});
	}

	const full = o.users.filter((u) =>
		COLLECTIONS.some((c) => u.rows[c] >= NEAR * limits.maxRows[c])
	);
	if (full.length) {
		out.push({
			title: `${plural(full.length, 'account')} near a row limit`,
			detail: `${NEAR * 100}% or more of the board's ${num(limits.maxRows.board)}, the dates' ${num(limits.maxRows.unavailable)} or the plays' ${num(limits.maxRows.plays)}.`,
			ids: full.map((u) => u.id)
		});
	}

	const crowded = o.users.filter(
		(u) => u.passkeys >= limits.maxPasskeys / 2 || u.sessions >= limits.maxSessions / 2
	);
	if (crowded.length) {
		out.push({
			title: `${plural(crowded.length, 'account')} with many passkeys or sessions`,
			detail: `At least ${limits.maxPasskeys / 2} passkeys (of ${limits.maxPasskeys}) or ${limits.maxSessions / 2} signed-in browsers (of ${limits.maxSessions}).`,
			ids: crowded.map((u) => u.id)
		});
	}

	const refused = window.filter((d) => d.quota_hits > 0);
	if (refused.length) {
		out.push({
			title: `Daily quotas refused requests on ${plural(refused.length, 'day')}`,
			detail: `Most recently ${refused.at(-1)!.day}: the write budget or the new-account cap said no.`,
			ids: []
		});
	}
	return out;
}

/** "12.3 kB", "4 MB": decimal units, like Cloudflare's dashboard. */
export function formatBytes(n: number): string {
	if (n < 1000) return `${n} B`;
	const units = ['kB', 'MB', 'GB', 'TB'];
	let value = n;
	let unit = -1;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "today", "yesterday", "5 days ago", or the date past a month. */
export function sinceDay(day: string | null, today: string): string {
	if (!day) return 'never';
	const n = daysBetween(day, today);
	if (n <= 0) return 'today';
	if (n === 1) return 'yesterday';
	if (n < 31) return `${n} days ago`;
	return shortDate(day, true);
}

/** "3 Oct", or "3 Oct 2026" with `year`. */
export function shortDate(day: string, year = false): string {
	return new Date(parse(day)).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		year: year ? 'numeric' : undefined,
		timeZone: 'UTC'
	});
}
