import { describe, expect, it } from 'vitest';
import type { AdminUser, DayStats, Overview } from './api';
import {
	activeWithin,
	addDays,
	daily,
	flags,
	formatBytes,
	niceMax,
	sinceDay,
	sortUsers,
	ticks,
	weekly,
	weekOf
} from './stats';

const stats = (day: string, s: Partial<DayStats> = {}): DayStats => ({
	day,
	active_users: 0,
	new_accounts: 0,
	rows_written: 0,
	quota_hits: 0,
	...s
});

const user = (id: string, u: Partial<AdminUser> = {}): AdminUser => ({
	id,
	you: false,
	created: '2026-09-01',
	last_seen: '2026-09-20',
	passkey_used: null,
	passkeys: 1,
	sessions: 1,
	rows: { board: 10, unavailable: 1, plays: 20 },
	bytes: 1000,
	written_today: 0,
	...u
});

const overview = (o: Partial<Overview> = {}): Overview => ({
	now: '2026-09-27T12:00:00.000Z',
	today: '2026-09-27',
	limits: {
		dailyRows: 10_000,
		newAccountsPerDay: 50,
		maxPasskeys: 20,
		maxSessions: 50,
		maxRows: { board: 20_000, unavailable: 2000, plays: 10_000 }
	},
	totals: { users: 0, rows: 0, bytes: 0, dbBytes: null },
	days: [],
	users: [],
	...o
});

describe('series', () => {
	it('fills missing days with zeros, oldest first, across month ends', () => {
		const days = [
			stats('2026-09-29', { new_accounts: 2 }),
			stats('2026-10-01', { new_accounts: 5 })
		];
		expect(daily(days, 'new_accounts', '2026-10-01', 4)).toEqual([
			{ day: '2026-09-28', value: 0 },
			{ day: '2026-09-29', value: 2 },
			{ day: '2026-09-30', value: 0 },
			{ day: '2026-10-01', value: 5 }
		]);
	});

	it('sums whole weeks from Monday, dropping a week it starts partway through', () => {
		expect(weekOf('2026-09-27')).toBe('2026-09-21'); // a Sunday
		expect(weekOf('2026-09-21')).toBe('2026-09-21');
		expect(weekOf('2026-01-01')).toBe('2025-12-29'); // across the year
		const points = Array.from({ length: 16 }, (_, i) => ({
			day: addDays('2026-09-10', i), // a Thursday … Friday 25th
			value: 1
		}));
		expect(weekly(points)).toEqual([
			{ day: '2026-09-14', value: 7 },
			{ day: '2026-09-21', value: 5 } // this week so far
		]);
		expect(weekly([])).toEqual([]);
	});

	it('picks round tops and gridlines', () => {
		expect([0, 1, 2, 3, 7, 10, 11, 49, 53, 999, 1001].map(niceMax)).toEqual([
			1, 1, 2, 3, 8, 10, 15, 50, 60, 1000, 1500
		]);
		expect(ticks(1)).toEqual([0, 1]);
		expect(ticks(20)).toEqual([0, 10, 20]);
		expect(ticks(5)).toEqual([0, 5]);
	});
});

describe('users', () => {
	const users = [
		user('b', { last_seen: null, bytes: 5 }),
		user('a', { last_seen: '2026-09-27', bytes: 50 }),
		user('c', { last_seen: '2026-09-21', rows: { board: 0, unavailable: 0, plays: 500 } })
	];

	it('sorts by any column, never-seen last when latest first, ties by id', () => {
		expect(sortUsers(users, 'last_seen', true).map((u) => u.id)).toEqual(['a', 'c', 'b']);
		expect(sortUsers(users, 'bytes', false).map((u) => u.id)).toEqual(['b', 'a', 'c']);
		expect(sortUsers(users, 'rows', true).map((u) => u.id)).toEqual(['c', 'a', 'b']);
		expect(sortUsers(users, 'created', true).map((u) => u.id)).toEqual(['a', 'b', 'c']);
		expect(users.map((u) => u.id)).toEqual(['b', 'a', 'c']); // not in place
	});

	it('counts who was active in the last 7 and 30 days, today included', () => {
		expect(activeWithin(users, '2026-09-27', 1)).toBe(1);
		expect(activeWithin(users, '2026-09-27', 7)).toBe(2);
		expect(activeWithin(users, '2026-09-28', 7)).toBe(1);
	});

	it('says how long ago, and sizes', () => {
		expect(sinceDay('2026-09-27', '2026-09-27')).toBe('today');
		expect(sinceDay('2026-09-26', '2026-09-27')).toBe('yesterday');
		expect(sinceDay('2026-09-01', '2026-09-27')).toBe('26 days ago');
		expect(sinceDay('2026-03-01', '2026-09-27')).toBe('1 Mar 2026');
		expect(sinceDay(null, '2026-09-27')).toBe('never');
		expect([0, 999, 1000, 12_345, 4_000_000, 2.5e9].map(formatBytes)).toEqual([
			'0 B',
			'999 B',
			'1.0 kB',
			'12 kB',
			'4.0 MB',
			'2.5 GB'
		]);
	});
});

describe('flags', () => {
	it('are quiet on an ordinary site', () => {
		const days = Array.from({ length: 98 }, (_, i) =>
			stats(addDays('2026-09-27', -i), { new_accounts: 2, active_users: 10, rows_written: 300 })
		);
		const users = Array.from({ length: 30 }, (_, i) => user(`u${i}`, { written_today: 10 }));
		expect(flags(overview({ days, users }))).toEqual([]);
	});

	it('catch sign-up bursts and the cap being reached', () => {
		const days = [
			stats('2026-08-01', { new_accounts: 50 }),
			stats('2026-09-01', { new_accounts: 12 }),
			stats('2026-09-02', { new_accounts: 3 }),
			// Older than 90 days: out of the window.
			stats('2026-06-01', { new_accounts: 50 })
		];
		const [flag, ...rest] = flags(overview({ days }));
		expect(flag).toEqual({
			title: 'The new-account cap (50 a day) was reached on 1 day',
			detail: 'Sign-ups: 2026-09-01 (12), 2026-08-01 (50).',
			ids: []
		});
		expect(rest).toEqual([]);
		expect(flags(overview({ days: days.slice(1) }))[0]!.title).toBe(
			'Unusually many sign-ups on 1 day'
		);
	});

	it('catch accounts near their limits, and one account doing most of the writing', () => {
		const users = [
			user('heavy', { written_today: 8500 }),
			user('full', { rows: { board: 16_000, unavailable: 0, plays: 0 } }),
			user('keys', { passkeys: 10 }),
			user('browsers', { sessions: 25 }),
			user('quiet', { written_today: 400 })
		];
		const days = [stats('2026-09-27', { rows_written: 9000, quota_hits: 1 })];
		expect(flags(overview({ users, days }))).toEqual([
			expect.objectContaining({ title: '1 account near the daily write budget', ids: ['heavy'] }),
			expect.objectContaining({
				title: "One account made 94% of today's writes",
				detail: '8,500 of 9,000 rows.',
				ids: ['heavy']
			}),
			expect.objectContaining({ title: '1 account near a row limit', ids: ['full'] }),
			expect.objectContaining({
				title: '2 accounts with many passkeys or sessions',
				ids: ['keys', 'browsers']
			}),
			expect.objectContaining({ title: 'Daily quotas refused requests on 1 day' })
		]);
	});

	it("don't blame one account for a quiet day's writes", () => {
		const users = [user('only', { written_today: 300 })];
		expect(flags(overview({ users }))).toEqual([]);
	});
});
