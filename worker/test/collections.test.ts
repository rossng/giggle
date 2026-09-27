import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { plays as playsCollection, PLAYS_MAX_AGE_DAYS } from '../src/collections';
import { itemsSince, putItems } from '../src/store';
import { call, callJson, newUser } from './helpers';

const DB = (env as unknown as { DB: D1Database }).DB;
const DAY = 86_400_000;

type Json = Record<string, unknown>;

async function put(path: string, user: string, items: unknown[]) {
	return callJson<{ items: Json[]; error?: string }>(path, {
		method: 'PUT',
		devUser: user,
		body: { items }
	});
}

async function pull(path: string, user: string, since?: string) {
	const query = since === undefined ? '' : `?since=${since}`;
	return callJson<{ items: Json[]; cursor: string; more: boolean }>(`${path}${query}`, {
		devUser: user
	});
}

/** An ISO time `days` ago (now-relative: plays are kept for a window ending now). */
const ago = (days: number, extraMs = 0) =>
	new Date(Date.now() - days * DAY + extraMs).toISOString();

describe('/api/unavailable', () => {
	const T0 = '2026-09-20T20:00:00.000Z';
	const T1 = '2026-09-20T21:00:00.000Z';

	it('stores days, ranges and weekdays, with labels, and pages by cursor', async () => {
		const user = newUser();
		const items = [
			{ key: '2026-10-03', at: T0 },
			{ key: '2026-10-10/2026-10-17', label: '  Lisbon ', at: T0 },
			{ key: 'weekly:mon', at: T0 }
		];
		const res = await put('/api/unavailable', user, items);
		expect(res.status).toBe(200);
		expect(res.body.items).toHaveLength(3);
		expect(res.body.items).toContainEqual({
			key: '2026-10-10/2026-10-17',
			label: 'Lisbon',
			at: T0
		});

		const all = await pull('/api/unavailable', user);
		expect(all.body.items.map((i) => i.key).sort()).toEqual([
			'2026-10-03',
			'2026-10-10/2026-10-17',
			'weekly:mon'
		]);
		const none = await pull('/api/unavailable', user, all.body.cursor);
		expect(none.body.items).toEqual([]);
	});

	it('syncs deletions as tombstones, last write wins', async () => {
		const user = newUser();
		await put('/api/unavailable', user, [{ key: 'weekly:fri', at: T0 }]);
		const { cursor } = (await pull('/api/unavailable', user)).body;
		const del = await put('/api/unavailable', user, [{ key: 'weekly:fri', deleted: true, at: T1 }]);
		expect(del.body.items).toEqual([{ key: 'weekly:fri', deleted: true, at: T1 }]);
		expect((await pull('/api/unavailable', user, cursor)).body.items).toEqual([
			{ key: 'weekly:fri', deleted: true, at: T1 }
		]);
		// A stale device re-adding it with an older time doesn't bring it back.
		const stale = await put('/api/unavailable', user, [{ key: 'weekly:fri', at: T0 }]);
		expect(stale.body.items).toEqual([{ key: 'weekly:fri', deleted: true, at: T1 }]);
	});

	it('is per user, and apart from the board', async () => {
		const alice = newUser('alice');
		const bob = newUser('bob');
		await put('/api/unavailable', alice, [{ key: '2026-12-25', at: T0 }]);
		expect((await pull('/api/unavailable', bob)).body.items).toEqual([]);
		expect((await pull('/api/board', alice)).body.items).toEqual([]);
	});

	it.each([
		['not a date', { key: 'someday', at: T0 }],
		['impossible date', { key: '2026-02-30', at: T0 }],
		['non-canonical date', { key: '2026-1-3', at: T0 }],
		['out of range', { key: '1999-01-01', at: T0 }],
		['backwards range', { key: '2026-10-07/2026-10-01', at: T0 }],
		['one-day range', { key: '2026-10-07/2026-10-07', at: T0 }],
		['range over a year', { key: '2026-01-01/2027-01-02', at: T0 }],
		['three dates', { key: '2026-01-01/2026-01-02/2026-01-03', at: T0 }],
		['bad weekday', { key: 'weekly:monday', at: T0 }],
		['label too long', { key: '2026-10-03', label: 'x'.repeat(101), at: T0 }],
		['label with control chars', { key: '2026-10-03', label: 'a\u0007', at: T0 }],
		['deleted not true', { key: '2026-10-03', deleted: false, at: T0 }],
		['deletion with a label', { key: '2026-10-03', deleted: true, label: 'x', at: T0 }],
		['unknown field', { key: '2026-10-03', note: 'x', at: T0 }],
		['bad at', { key: '2026-10-03', at: 'now' }]
	])('rejects %s with 400', async (_, item) => {
		const res = await put('/api/unavailable', 'validator@example.test', [item]);
		expect(res.status).toBe(400);
	});
});

describe('/api/plays', () => {
	it('merges two devices’ plays into one history', async () => {
		const user = newUser();
		const a = { key: 'name:mogwai', at: ago(1) };
		const b = { key: 'name:mogwai', at: ago(0.5) };
		const c = { key: 'name:slowdive', at: ago(0.2) };
		await put('/api/plays', user, [a, b]);
		// Another device: b again (already there) and a play of its own.
		const res = await put('/api/plays', user, [b, c]);
		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([b, c].sort((x, y) => x.at.localeCompare(y.at)));
		const all = (await pull('/api/plays', user)).body.items;
		expect(all).toHaveLength(3);
		expect(all).toEqual(expect.arrayContaining([a, b, c]));
	});

	it('does not bump the cursor for a play it already has', async () => {
		const user = newUser();
		const play = { key: 'name:a', at: ago(1) };
		await put('/api/plays', user, [play]);
		const { cursor } = (await pull('/api/plays', user)).body;
		await put('/api/plays', user, [play]);
		expect((await pull('/api/plays', user, cursor)).body.items).toEqual([]);
	});

	it('drops plays from the future or past the window without failing the batch', async () => {
		const user = newUser();
		const ok = { key: 'name:ok', at: ago(1) };
		const res = await put('/api/plays', user, [
			ok,
			{ key: 'name:future', at: ago(-1) },
			{ key: 'name:old', at: ago(PLAYS_MAX_AGE_DAYS + 1) }
		]);
		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([ok]);
		expect((await pull('/api/plays', user)).body.items).toEqual([ok]);
	});

	it('normalises the time, so the same play in another offset is the same play', async () => {
		const user = newUser();
		const utc = new Date(Math.floor((Date.now() - DAY) / 1000) * 1000);
		const local = new Date(utc.getTime() + 2 * 3600_000).toISOString().replace('Z', '+02:00');
		await put('/api/plays', user, [{ key: 'name:a', at: utc.toISOString() }]);
		await put('/api/plays', user, [{ key: 'name:a', at: local }]);
		expect((await pull('/api/plays', user)).body.items).toEqual([
			{ key: 'name:a', at: utc.toISOString() }
		]);
	});

	it.each([
		['bad key', { key: 'spotify:1', at: ago(1) }],
		['no time', { key: 'name:a' }],
		['a deletion', { key: 'name:a', at: ago(1), deleted: true }],
		['extra field', { key: 'name:a', at: ago(1), name: 'A' }]
	])('rejects %s with 400', async (_, item) => {
		expect((await put('/api/plays', 'validator@example.test', [item])).status).toBe(400);
	});

	it('rejects the same play twice in one batch', async () => {
		const play = { key: 'name:a', at: ago(1) };
		expect((await put('/api/plays', 'validator@example.test', [play, play])).status).toBe(400);
	});
});

describe('forgetting plays', () => {
	// The store directly, with small limits and a clock of our choosing.
	const NOW = Date.parse('2026-09-26T20:00:00.000Z');
	const at = (days: number) => new Date(NOW - days * DAY).toISOString();
	const play = (key: string, days: number) => ({
		key: `${at(days)} ${key}`,
		data: {},
		at: at(days)
	});

	it('forgets rows past the age limit when writing, and never serves them', async () => {
		const user = newUser();
		await putItems(DB, playsCollection, user, [play('name:old', 59), play('name:new', 1)], NOW);
		const later = NOW + 2 * DAY; // name:old is now 61 days old
		const page = await itemsSince(DB, playsCollection, user, 0, later);
		expect(page.items).toEqual([{ key: 'name:new', at: at(1) }]);
		await putItems(DB, playsCollection, user, [play('name:newer', 0)], later);
		const { results } = await DB.prepare(
			`SELECT key FROM sync_items WHERE user = ? AND collection = 'plays' ORDER BY at`
		)
			.bind(user)
			.all<{ key: string }>();
		expect(results.map((r) => r.key.slice(25))).toEqual(['name:new', 'name:newer']);
	});

	it('past the row limit, keeps the newest 90% of it', async () => {
		const user = newUser();
		const small = { ...playsCollection, maxRows: 3 };
		const first = await putItems(
			DB,
			small,
			user,
			[4, 3, 2, 1].map((d) => play(`name:${d}`, d)),
			NOW
		);
		// floor(3 × 0.9) = 2 kept, so the next few writes don't have to forget any.
		expect(first.map((i) => i.key).sort()).toEqual(['name:1', 'name:2']);
		const page = await itemsSince(DB, small, user, 0, NOW);
		expect(page.items.map((i) => i.key).sort()).toEqual(['name:1', 'name:2']);
		await putItems(DB, small, user, [play('name:0', 0)], NOW);
		const again = await itemsSince(DB, small, user, 0, NOW);
		expect(again.items.map((i) => i.key).sort()).toEqual(['name:0', 'name:1', 'name:2']);
	});

	it('keeps the row with the highest seq even when it is the oldest', async () => {
		const user = newUser();
		const small = { ...playsCollection, maxRows: 3 };
		await putItems(
			DB,
			small,
			user,
			[1, 2, 3, 4].map((d) => play(`name:${d}`, d)),
			NOW
		);
		// name:4 is the oldest but came last: it stays with the newest two.
		const page = await itemsSince(DB, small, user, 0, NOW);
		expect(page.items.map((i) => i.key).sort()).toEqual(['name:1', 'name:2', 'name:4']);
		await putItems(DB, small, user, [play('name:0', 0)], NOW);
		const after = await itemsSince(DB, small, user, 0, NOW);
		expect(after.items.map((i) => i.key).sort()).toEqual(['name:0', 'name:1']);
	});

	it('never lets the cursor go backwards when the newest change is forgotten', async () => {
		const user = newUser();
		await putItems(DB, playsCollection, user, [play('name:a', 1)], NOW);
		// A device catches up late with an old play: it gets the highest seq.
		await putItems(DB, playsCollection, user, [play('name:late', 59)], NOW);
		const seen = await itemsSince(DB, playsCollection, user, 0, NOW);
		const cursor = Number(seen.cursor);
		// Two days on it's past the window; a write that changes nothing prunes.
		const later = NOW + 2 * DAY;
		await putItems(DB, playsCollection, user, [play('name:a', 1)], later);
		// The next new play still gets a seq after everything a device has seen.
		await putItems(
			DB,
			playsCollection,
			user,
			[
				{
					key: `${new Date(later).toISOString()} name:b`,
					data: {},
					at: new Date(later).toISOString()
				}
			],
			later
		);
		const next = await itemsSince(DB, playsCollection, user, cursor, later);
		expect(next.items).toEqual([{ key: 'name:b', at: new Date(later).toISOString() }]);
	});
});

describe('routing', () => {
	it('answers unknown collections with 404 and wrong methods with 405', async () => {
		const user = newUser();
		expect((await call('/api/settings', { devUser: user })).status).toBe(404);
		expect((await call('/api/__proto__', { devUser: user })).status).toBe(404);
		expect((await call('/api/plays', { method: 'POST', devUser: user })).status).toBe(405);
		expect((await call('/api/unavailable')).status).toBe(401);
	});
});
