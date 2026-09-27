import { describe, expect, it } from 'vitest';
import { memoryStorage } from '$lib/storage';
import {
	addRule,
	cleanLabel,
	describeRule,
	isUnavailable,
	loadUnavailable,
	parseRuleKey,
	parseUnavailable,
	rangeRule,
	removeRule,
	ruleKey,
	saveUnavailable,
	unavailableTest,
	upcomingRules,
	type Unavailable
} from './unavailable';

const NOW = new Date('2026-09-26T20:00:00Z');
const AT = NOW.toISOString();

describe('rule keys', () => {
	it('parses the three kinds and writes them back the same', () => {
		for (const key of ['2026-10-03', '2026-10-10/2026-10-17', 'weekly:mon', 'weekly:sun']) {
			const rule = parseRuleKey(key);
			expect(rule).not.toBeNull();
			expect(ruleKey(rule!)).toBe(key);
		}
		expect(parseRuleKey('weekly:mon')).toEqual({ kind: 'weekly', weekday: 0 });
		expect(parseRuleKey('2026-10-10/2026-10-17')).toEqual({
			kind: 'range',
			first: '2026-10-10',
			last: '2026-10-17'
		});
	});

	it.each([
		'someday',
		'2026-02-30',
		'2026-1-3',
		'1999-01-01',
		'2026-10-07/2026-10-01',
		'2026-10-07/2026-10-07',
		'2026-01-01/2027-01-02',
		'2026-01-01/2026-01-02/2026-01-03',
		'weekly:monday',
		'weekly:'
	])('refuses %s, as the server does', (key) => {
		expect(parseRuleKey(key)).toBeNull();
	});

	it('makes ranges from two dates in any order, and one day from the same date twice', () => {
		expect(rangeRule('2026-10-17', '2026-10-10')).toEqual({
			kind: 'range',
			first: '2026-10-10',
			last: '2026-10-17'
		});
		expect(rangeRule('2026-10-10', '2026-10-10')).toEqual({ kind: 'day', date: '2026-10-10' });
		expect(rangeRule('2026-10-10')).toEqual({ kind: 'day', date: '2026-10-10' });
		expect(rangeRule('2026-01-01', '2026-12-31')?.kind).toBe('range'); // 365 days
		expect(rangeRule('2026-01-01', '2027-01-02')).toBeNull(); // 367 days
		expect(rangeRule('', '2026-10-10')).toBeNull();
	});
});

describe('which dates are unavailable', () => {
	const u: Unavailable = {
		'2026-10-03': { at: AT },
		'2026-10-10/2026-10-17': { at: AT },
		'weekly:mon': { at: AT }
	};

	it('covers single days, both ends of ranges and every such weekday', () => {
		const test = unavailableTest(u);
		expect(test('2026-10-03')).toBe(true);
		expect(test('2026-10-04')).toBe(false);
		expect(test('2026-10-09')).toBe(false);
		expect(test('2026-10-10')).toBe(true);
		expect(test('2026-10-14')).toBe(true);
		expect(test('2026-10-17')).toBe(true);
		expect(test('2026-10-18')).toBe(false);
		expect(test('2026-09-28')).toBe(true); // a Monday
		expect(test('2027-03-01')).toBe(true); // a Monday next year
		expect(test('2026-09-29')).toBe(false);
	});

	it('is nothing without rules, and ignores keys it cannot read', () => {
		expect(isUnavailable({}, '2026-10-03')).toBe(false);
		expect(isUnavailable({ nonsense: { at: AT } }, '2026-10-03')).toBe(false);
	});
});

describe('editing', () => {
	it('adds, relabels and removes rules without mutating', () => {
		const empty: Unavailable = Object.freeze({});
		const one = addRule(empty, { kind: 'weekly', weekday: 4 }, '  Band practice ', NOW);
		expect(one).toEqual({ 'weekly:fri': { label: 'Band practice', at: AT } });
		const later = new Date('2026-09-27T10:00:00Z');
		const relabelled = addRule(one, { kind: 'weekly', weekday: 4 }, '', later);
		expect(relabelled).toEqual({ 'weekly:fri': { at: later.toISOString() } });
		expect(removeRule(relabelled, 'weekly:fri')).toEqual({});
		expect(empty).toEqual({});
	});

	it('cleans labels', () => {
		expect(cleanLabel(' a\u0007b \n c ')).toBe('a b c');
		expect(cleanLabel('x'.repeat(150))).toHaveLength(100);
	});
});

describe('listing', () => {
	it('lists weekdays first, then dates soonest first, leaving out past ones', () => {
		const u: Unavailable = {
			'2026-12-25': { label: 'Christmas', at: AT },
			'weekly:sun': { at: AT },
			'2026-09-20/2026-09-30': { at: AT }, // still running
			'2026-09-01': { at: AT }, // past
			'weekly:tue': { at: AT }
		};
		const views = upcomingRules(u, '2026-09-26');
		expect(views.map((v) => v.key)).toEqual([
			'weekly:tue',
			'weekly:sun',
			'2026-09-20/2026-09-30',
			'2026-12-25'
		]);
		expect(views.map((v) => v.days)).toEqual([null, null, 11, 1]);
		expect(views[3].label).toBe('Christmas');
	});

	it('describes rules for people', () => {
		const d = (key: string, year = 2026) => describeRule(parseRuleKey(key)!, year);
		expect(d('weekly:wed')).toBe('Every Wednesday');
		expect(d('2026-10-03')).toBe('Sat 3 Oct');
		expect(d('2027-01-02')).toBe('Sat 2 Jan 2027');
		expect(d('2026-10-10/2026-10-17')).toBe('10 – 17 Oct');
		expect(d('2026-10-28/2026-11-02')).toBe('28 Oct – 2 Nov');
		expect(d('2026-12-28/2027-01-03')).toBe('28 Dec 2026 – 3 Jan 2027');
	});
});

describe('storage', () => {
	it('round-trips, dropping anything malformed', () => {
		const storage = memoryStorage();
		const u: Unavailable = { '2026-10-03': { label: 'Away', at: AT }, 'weekly:mon': { at: AT } };
		saveUnavailable(u, storage);
		expect(loadUnavailable(storage)).toEqual(u);
		expect(
			parseUnavailable({
				items: {
					'2026-10-03': { at: AT },
					'bad-key': { at: AT },
					'weekly:tue': { at: 'never' },
					'weekly:wed': null
				}
			})
		).toEqual({ '2026-10-03': { at: AT } });
		expect(parseUnavailable('junk')).toEqual({});
		expect(loadUnavailable(null)).toEqual({});
	});
});
