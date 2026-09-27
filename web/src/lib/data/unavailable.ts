// The listener's unavailable dates: days, date ranges and weekdays they can't go out. With the
// `hide=unavailable` filter the agenda and the radio leave out gigs on those dates, and the
// Board warns when an artist's next gig falls on one. Stored in this browser (localStorage) and
// synced to the account through `/api/unavailable` (web/src/lib/sync/).
//
// Each rule is stored under a key that says what it covers, the same on every device, so two
// devices adding "every Monday" end up with one rule:
//
//   "2026-10-03"              one day
//   "2026-10-10/2026-10-17"   a range, both ends included (at most MAX_RANGE_DAYS)
//   "weekly:mon"              every Monday
//
// Dates are Amsterdam local dates, like a gig's (dates.ts). Pure, apart from load/save.

import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';
import { daysBetween, dayParts, formatDay, weekdayIndex } from './dates';
import type { IsoDate } from './types';

export const UNAVAILABLE_STORAGE_KEY = 'giggle:unavailable:v1';

/** Longest range, in days, both ends included. Keep in step with worker/src/collections.ts. */
export const MAX_RANGE_DAYS = 366;
export const MAX_LABEL = 100;

/** Monday first, as `weekdayIndex` counts. */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const WEEKDAY_NAMES = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday'
] as const;

export type Rule =
	| { kind: 'day'; date: IsoDate }
	| { kind: 'range'; first: IsoDate; last: IsoDate }
	/** 0 = Monday … 6 = Sunday. */
	| { kind: 'weekly'; weekday: number };

export interface UnavailableItem {
	/** A note for the listener ("Lisbon"). */
	label?: string;
	/** When it was added or last changed, ISO 8601. */
	at: string;
}

/** Rule key → item. Removed rules are absent. */
export type Unavailable = Readonly<Record<string, UnavailableItem>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;

/** A real calendar date between 2024 and 2100, written canonically. */
export function isIsoDate(value: string): boolean {
	if (!DATE.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return (
		!Number.isNaN(d.getTime()) &&
		d.toISOString().slice(0, 10) === value &&
		value >= '2024-01-01' &&
		value <= '2100-12-31'
	);
}

/** The rule a key stands for, or null if it isn't a canonical key. */
export function parseRuleKey(key: string): Rule | null {
	if (key.startsWith('weekly:')) {
		const weekday = (WEEKDAY_KEYS as readonly string[]).indexOf(key.slice(7));
		return weekday >= 0 ? { kind: 'weekly', weekday } : null;
	}
	const parts = key.split('/');
	if (parts.length === 1) return isIsoDate(key) ? { kind: 'day', date: key } : null;
	const [first, last] = parts;
	if (parts.length !== 2 || !isIsoDate(first) || !isIsoDate(last) || last <= first) return null;
	return daysBetween(first, last) < MAX_RANGE_DAYS ? { kind: 'range', first, last } : null;
}

export function ruleKey(rule: Rule): string {
	switch (rule.kind) {
		case 'weekly':
			return `weekly:${WEEKDAY_KEYS[rule.weekday]}`;
		case 'day':
			return rule.date;
		case 'range':
			return `${rule.first}/${rule.last}`;
	}
}

/**
 * The rule for the days from `a` to `b` (either order), or null if either isn't a date or the
 * range is too long. One day is a day, not a range, so that it has one key.
 */
export function rangeRule(a: IsoDate, b: IsoDate = a): Rule | null {
	if (!isIsoDate(a) || !isIsoDate(b)) return null;
	const [first, last] = a <= b ? [a, b] : [b, a];
	if (first === last) return { kind: 'day', date: first };
	return daysBetween(first, last) < MAX_RANGE_DAYS ? { kind: 'range', first, last } : null;
}

/** A label as stored: trimmed, at most MAX_LABEL characters, no control characters. */
export function cleanLabel(label: string): string {
	return label
		.replace(/[\p{Cc}\p{Cs}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_LABEL)
		.trim();
}

/** Adds (or relabels) `rule`, stamped `now`. */
export function addRule(
	unavailable: Unavailable,
	rule: Rule,
	label: string,
	now: Date
): Unavailable {
	const clean = cleanLabel(label);
	return {
		...unavailable,
		[ruleKey(rule)]: { ...(clean ? { label: clean } : {}), at: now.toISOString() }
	};
}

export function removeRule(unavailable: Unavailable, key: string): Unavailable {
	const { [key]: _gone, ...rest } = unavailable;
	return rest;
}

/** A test for "is the listener unavailable on this date?", built once for many gigs. */
export function unavailableTest(unavailable: Unavailable): (date: IsoDate) => boolean {
	const weekdays = new Set<number>();
	const days = new Set<IsoDate>();
	const ranges: [IsoDate, IsoDate][] = [];
	for (const key of Object.keys(unavailable)) {
		const rule = parseRuleKey(key);
		if (rule?.kind === 'weekly') weekdays.add(rule.weekday);
		else if (rule?.kind === 'day') days.add(rule.date);
		else if (rule?.kind === 'range') ranges.push([rule.first, rule.last]);
	}
	if (!weekdays.size && !days.size && !ranges.length) return () => false;
	return (date) =>
		days.has(date) ||
		(weekdays.size > 0 && weekdays.has(weekdayIndex(date))) ||
		ranges.some(([first, last]) => first <= date && date <= last);
}

export function isUnavailable(unavailable: Unavailable, date: IsoDate): boolean {
	return unavailableTest(unavailable)(date);
}

/** The last day a rule covers (weekly rules never end). */
function lastDay(rule: Rule): IsoDate | null {
	return rule.kind === 'weekly' ? null : rule.kind === 'day' ? rule.date : rule.last;
}

/** "Every Monday", "Sat 3 Oct", "10 – 17 Oct", with the year when it isn't `thisYear`. */
export function describeRule(rule: Rule, thisYear: number): string {
	switch (rule.kind) {
		case 'weekly':
			return `Every ${WEEKDAY_NAMES[rule.weekday]}`;
		case 'day':
			return formatDay(rule.date, thisYear);
		case 'range': {
			const a = dayParts(rule.first);
			const b = dayParts(rule.last);
			const bYear = b.year !== thisYear ? ` ${b.year}` : '';
			if (a.year === b.year && a.month === b.month) return `${a.day} – ${b.day} ${b.month}${bYear}`;
			const aYear = a.year !== b.year ? ` ${a.year}` : '';
			return `${a.day} ${a.month}${aYear} – ${b.day} ${b.month}${bYear}`;
		}
	}
}

export interface RuleView {
	key: string;
	rule: Rule;
	label: string | null;
	/** How many days it covers (null: every week). */
	days: number | null;
}

/**
 * Rules still to come (or running) on `today`, for listing: weekdays first (Monday first), then
 * dates, soonest first. Past ones are left out: they no longer hide anything.
 */
export function upcomingRules(unavailable: Unavailable, today: IsoDate): RuleView[] {
	const views: RuleView[] = [];
	for (const [key, item] of Object.entries(unavailable)) {
		const rule = parseRuleKey(key);
		if (!rule) continue;
		const last = lastDay(rule);
		if (last !== null && last < today) continue;
		views.push({
			key,
			rule,
			label: item.label ?? null,
			days:
				rule.kind === 'weekly'
					? null
					: rule.kind === 'day'
						? 1
						: daysBetween(rule.first, rule.last) + 1
		});
	}
	const order = (v: RuleView) =>
		v.rule.kind === 'weekly'
			? `0${v.rule.weekday}`
			: `1${v.rule.kind === 'day' ? v.rule.date : v.rule.first}`;
	return views.sort((a, b) => order(a).localeCompare(order(b)));
}

/** Reads the rules back from storage, dropping anything malformed. */
export function parseUnavailable(value: unknown): Unavailable {
	const items = (value as { items?: unknown } | null)?.items;
	if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
	const out: Record<string, UnavailableItem> = {};
	for (const [key, raw] of Object.entries(items as Record<string, unknown>)) {
		const item = raw as Partial<UnavailableItem> | null;
		if (!parseRuleKey(key) || !item || typeof item !== 'object') continue;
		if (typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) continue;
		const label =
			typeof item.label === 'string' && NO_CONTROL.test(item.label) ? cleanLabel(item.label) : '';
		out[key] = { ...(label ? { label } : {}), at: item.at };
	}
	return out;
}

export function serialiseUnavailable(unavailable: Unavailable): {
	version: 1;
	items: Unavailable;
} {
	return { version: 1, items: unavailable };
}

export function loadUnavailable(storage: KeyValueStorage | null = browserStorage()): Unavailable {
	return parseUnavailable(readJson(UNAVAILABLE_STORAGE_KEY, storage));
}

export function saveUnavailable(
	unavailable: Unavailable,
	storage: KeyValueStorage | null = browserStorage()
): boolean {
	return writeJson(UNAVAILABLE_STORAGE_KEY, serialiseUnavailable(unavailable), storage);
}
