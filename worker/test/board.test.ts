import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/validate';
import { call, callJson, item, MBID, newUser, pull, put, type Item } from './helpers';

const T0 = '2026-09-20T20:00:00.000Z';
const T1 = '2026-09-20T21:00:00.000Z';
const T2 = '2026-09-20T22:00:00.000Z';

describe('PUT and GET /api/board', () => {
	it('stores items and returns them, with a cursor for the next pull', async () => {
		const user = newUser();
		const mogwai = {
			key: MBID(1),
			state: 'go',
			name: 'Mogwai',
			gig: 'paradiso:123',
			at: T0
		} as const;
		const res = await put(user, [mogwai, item('name:slowdive', 'listen', T0, 'Slowdive')]);
		expect(res.status).toBe(200);
		expect(res.body.items).toHaveLength(2);
		expect(res.body.items).toContainEqual(mogwai);

		const all = await pull(user);
		expect(all.status).toBe(200);
		expect(all.body.items.map((i) => i.key).sort()).toEqual([MBID(1), 'name:slowdive'].sort());
		expect(all.body.more).toBe(false);

		// Nothing changed since: empty, same cursor.
		const none = await pull(user, all.body.cursor);
		expect(none.body).toEqual({ items: [], cursor: all.body.cursor, more: false });

		// Only what changed comes back.
		await put(user, [item('name:slowdive', 'tickets', T1, 'Slowdive')]);
		const changed = await pull(user, all.body.cursor);
		expect(changed.body.items).toEqual([item('name:slowdive', 'tickets', T1, 'Slowdive')]);
		expect(Number(changed.body.cursor)).toBeGreaterThan(Number(all.body.cursor));
	});

	it('normalises timestamps and responds no-store JSON', async () => {
		const user = newUser();
		const res = await call('/api/board', {
			method: 'PUT',
			devUser: user,
			body: { items: [item('name:a', 'go', '2026-09-20T22:00:00+02:00')] }
		});
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
		expect(((await res.json()) as { items: Item[] }).items[0]?.at).toBe(T0);
	});
});

describe('artists and gigs', () => {
	const gig = {
		key: 'gig:paradiso:123',
		state: 'go',
		name: 'Mogwai',
		artist: MBID(1),
		when: '2026-10-10T20:00:00+02:00',
		at: T0
	} as const;

	it("stores a gig's plan with the artist and start it was sorted for", async () => {
		const user = newUser();
		const res = await put(user, [gig, item('gig:melkweg:9', 'tickets', T0), item(MBID(2), 'nope', T0)]);
		expect(res.status).toBe(200);
		expect((await pull(user)).body.items).toEqual(
			expect.arrayContaining([gig, item('gig:melkweg:9', 'tickets', T0), item(MBID(2), 'nope', T0)])
		);
		const gone = await put(user, [{ key: gig.key, state: null, name: '', at: T1 }]);
		expect(gone.body.items).toEqual([{ key: gig.key, state: null, name: '', at: T1 }]);
	});

	// LEGACY-BOARD
	it('still takes plans on an artist from older clients', async () => {
		const user = newUser();
		const old = {
			key: MBID(1),
			state: 'tickets',
			name: 'Mogwai',
			gig: 'paradiso:123',
			at: T0
		} as const;
		expect((await put(user, [old])).body.items).toEqual([old]);
	});
});

describe('last write wins', () => {
	it('keeps the newer change whichever order they arrive in', async () => {
		const user = newUser();
		await put(user, [item('name:a', 'go', T1)]);
		const older = await put(user, [item('name:a', 'nope', T0)]);
		expect(older.body.items).toEqual([item('name:a', 'go', T1)]);
		const newer = await put(user, [item('name:a', 'tickets', T2)]);
		expect(newer.body.items).toEqual([item('name:a', 'tickets', T2)]);
	});

	it('keeps the stored row on a tie', async () => {
		const user = newUser();
		await put(user, [item('name:a', 'go', T1)]);
		const tie = await put(user, [item('name:a', 'listen', T1)]);
		expect(tie.body.items).toEqual([item('name:a', 'go', T1)]);
	});

	it('does not bump the cursor for a losing write', async () => {
		const user = newUser();
		await put(user, [item('name:a', 'go', T1)]);
		const { cursor } = (await pull(user)).body;
		await put(user, [item('name:a', 'nope', T0)]);
		expect((await pull(user, cursor)).body.items).toEqual([]);
	});

	it('merges a mixed batch row by row', async () => {
		const user = newUser();
		await put(user, [item('name:a', 'go', T1), item('name:b', 'go', T1)]);
		const res = await put(user, [
			item('name:a', 'nope', T0), // older: loses
			item('name:b', 'nope', T2), // newer: wins
			item('name:c', 'listen', T0) // new
		]);
		const byKey = Object.fromEntries(res.body.items.map((i) => [i.key, i.state]));
		expect(byKey).toEqual({ 'name:a': 'go', 'name:b': 'nope', 'name:c': 'listen' });
	});
});

describe('tombstones', () => {
	it('syncs deletions and lets a newer re-add win over them', async () => {
		const user = newUser();
		await put(user, [item('name:a', 'go', T0, 'A')]);
		const { cursor } = (await pull(user)).body;

		const deleted = await put(user, [{ key: 'name:a', state: null, name: '', at: T1 }]);
		expect(deleted.body.items).toEqual([{ key: 'name:a', state: null, name: '', at: T1 }]);
		// Another device pulling sees the tombstone.
		expect((await pull(user, cursor)).body.items).toEqual([
			{ key: 'name:a', state: null, name: '', at: T1 }
		]);

		// A stale device re-sending its older copy doesn't resurrect it.
		const stale = await put(user, [item('name:a', 'go', T0, 'A')]);
		expect(stale.body.items[0]?.state).toBeNull();

		// A genuinely newer re-add does.
		const readd = await put(user, [item('name:a', 'listen', T2, 'A')]);
		expect(readd.body.items).toEqual([item('name:a', 'listen', T2, 'A')]);
	});

	it('accepts a tombstone without a name', async () => {
		const user = newUser();
		const res = await put(user, [{ key: 'name:x', state: null, at: T0 } as unknown as Item]);
		expect(res.status).toBe(200);
		expect(res.body.items).toEqual([{ key: 'name:x', state: null, name: '', at: T0 }]);
	});
});

describe('per-user isolation', () => {
	it("alice can't see or overwrite bob's board", async () => {
		const alice = newUser('alice');
		const bob = newUser('bob');
		await put(alice, [item('name:shared', 'go', T0, 'Shared'), item('name:alice-only', 'go', T0)]);
		await put(bob, [item('name:shared', 'nope', T2, 'Shared')]);

		const a = (await pull(alice)).body.items;
		const b = (await pull(bob)).body.items;
		expect(a.map((i) => [i.key, i.state]).sort()).toEqual([
			['name:alice-only', 'go'],
			['name:shared', 'go']
		]);
		expect(b).toEqual([item('name:shared', 'nope', T2, 'Shared')]);

		// Bob's cursor means nothing for alice's rows either.
		const bobCursor = (await pull(bob)).body.cursor;
		expect((await pull(alice, bobCursor)).body.items.every((i) => i.key !== 'name:bob')).toBe(true);
	});
});

describe('paging', () => {
	it('pages through more than one page of changes', async () => {
		const user = newUser();
		const total = LIMITS.page + 20;
		for (let start = 0; start < total; start += LIMITS.batch) {
			const batch = Array.from({ length: Math.min(LIMITS.batch, total - start) }, (_, i) =>
				item(`name:artist-${start + i}`, 'listen', T0)
			);
			expect((await put(user, batch)).status).toBe(200);
		}
		const first = await pull(user);
		expect(first.body.items).toHaveLength(LIMITS.page);
		expect(first.body.more).toBe(true);
		const second = await pull(user, first.body.cursor);
		expect(second.body.items).toHaveLength(20);
		expect(second.body.more).toBe(false);
		const keys = new Set([...first.body.items, ...second.body.items].map((i) => i.key));
		expect(keys.size).toBe(total);
	});
});

describe('validation', () => {
	const user = 'validator@example.test';
	const ok = item('name:a', 'go', T0);

	it.each([
		['not an object', []],
		['no items', {}],
		['empty items', { items: [] }],
		['extra top-level field', { items: [ok], x: 1 }],
		['bad state', { items: [{ ...ok, state: 'maybe' }] }],
		['missing state', { items: [{ key: 'name:a', name: 'A', at: T0 }] }],
		['bad key prefix', { items: [{ ...ok, key: 'spotify:123' }] }],
		['bad mbid', { items: [{ ...ok, key: 'mb:not-a-uuid' }] }],
		['control chars in key', { items: [{ ...ok, key: 'name:a\u0000b' }] }],
		['key too long', { items: [{ ...ok, key: `name:${'a'.repeat(LIMITS.keyLength)}` }] }],
		['name missing', { items: [{ key: 'name:a', state: 'go', at: T0 }] }],
		['name blank', { items: [{ ...ok, name: '  ' }] }],
		['name too long', { items: [{ ...ok, name: 'n'.repeat(LIMITS.nameLength + 1) }] }],
		['name not a string', { items: [{ ...ok, name: 42 }] }],
		['gig too long', { items: [{ ...ok, gig: 'g'.repeat(LIMITS.gigLength + 1) }] }],
		['at not ISO', { items: [{ ...ok, at: 'yesterday' }] }],
		['at a number', { items: [{ ...ok, at: 1727380800000 }] }],
		['at ancient', { items: [{ ...ok, at: '1999-01-01T00:00:00Z' }] }],
		['at impossible date', { items: [{ ...ok, at: '2026-02-31T25:00:00Z' }] }],
		['unknown item field', { items: [{ ...ok, extra: true }] }],
		['duplicate keys', { items: [ok, { ...ok, state: 'nope' }] }],
		[
			'too many items',
			{ items: Array.from({ length: LIMITS.batch + 1 }, (_, i) => item(`name:${i}`, 'go', T0)) }
		]
	])('rejects %s with 400', async (_, body) => {
		const res = await callJson('/api/board', { method: 'PUT', devUser: user, body });
		expect(res.status).toBe(400);
		expect(res.body).toHaveProperty('error');
	});

	// Its own account: each account gets 30 writes a minute.
	it.each([
		["a gig's listen more", { items: [item('gig:paradiso:1', 'listen', T0)] }],
		["a gig's not for me", { items: [item('gig:paradiso:1', 'nope', T0)] }],
		['a gig key without an id', { items: [item('gig:paradiso', 'go', T0)] }],
		['a gig key with a capital venue', { items: [item('gig:Paradiso:1', 'go', T0)] }],
		['a gig with a gig field', { items: [{ ...item('gig:x:1', 'go', T0), gig: 'x:1' }] }],
		["a gig's bad artist", { items: [{ ...item('gig:x:1', 'go', T0), artist: 'spotify:1' }] }],
		["a gig's bad start", { items: [{ ...item('gig:x:1', 'go', T0), when: 'soon' }] }],
		["an artist's artist", { items: [{ ...item('name:a', 'listen', T0), artist: 'name:b' }] }],
		["an artist's start", { items: [{ ...item('name:a', 'listen', T0), when: T0 }] }],
	])('rejects %s with 400', async (_, body) => {
		const res = await callJson('/api/board', {
			method: 'PUT',
			devUser: 'gig-validator@example.test',
			body
		});
		expect(res.status).toBe(400);
		expect(res.body).toHaveProperty('error');
	});

	it('rejects a non-JSON body and a non-JSON content type', async () => {
		expect((await call('/api/board', { method: 'PUT', devUser: user, body: '{nope' })).status).toBe(
			400
		);
		const res = await call('/api/board', {
			method: 'PUT',
			devUser: user,
			headers: { 'Content-Type': 'text/plain' },
			body: JSON.stringify({ items: [ok] })
		});
		expect(res.status).toBe(415);
	});

	it('rejects an oversized body', async () => {
		const body = JSON.stringify({ items: [{ ...ok, name: 'x'.repeat(LIMITS.body) }] });
		expect((await call('/api/board', { method: 'PUT', devUser: user, body })).status).toBe(413);
	});

	it('rejects a bad cursor', async () => {
		for (const since of ['yesterday', '-1', '1.5', '2026-09-26T20:00:00Z', '9'.repeat(20)]) {
			expect((await pull(user, since)).status).toBe(400);
		}
	});

	it('clamps a change stamped in the future to the server clock', async () => {
		const u = newUser();
		const res = await put(u, [item('name:future', 'go', '2099-01-01T00:00:00.000Z')]);
		expect(res.status).toBe(200);
		expect(Date.parse(res.body.items[0]!.at)).toBeLessThanOrEqual(Date.now());
	});

	it('answers unknown routes and methods', async () => {
		expect((await call('/api/nope', { devUser: user })).status).toBe(404);
		expect((await call('/api/board', { method: 'DELETE', devUser: user })).status).toBe(405);
		expect((await call('/api/me', { method: 'POST', devUser: user })).status).toBe(405);
		// Auth comes before routing: nothing leaks to anonymous callers.
		expect((await call('/api/nope')).status).toBe(401);
	});
});
