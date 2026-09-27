import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { board, plays } from '../src/collections';
import type { Env } from '../src/config';
import worker from '../src/index';
import { DAILY_ROWS, dayOf, putItems } from '../src/store';
import { LIMITS } from '../src/validate';
import { call, DEV_ENV, MBID, newUser, randomIp } from './helpers';

const DB = (env as unknown as { DB: D1Database }).DB;

const boardItem = (n: number, at = new Date().toISOString()) => ({
	key: MBID(n),
	data: { state: 'go', name: `Artist ${n}` },
	at
});

async function counted(user: string, collection: string) {
	return DB.prepare(
		`SELECT
		   (SELECT rows FROM sync_counts WHERE user = ?1 AND collection = ?2) AS kept,
		   (SELECT count(*) FROM sync_items WHERE user = ?1 AND collection = ?2) AS real`
	)
		.bind(user, collection)
		.first<{ kept: number | null; real: number }>();
}

describe('row counts', () => {
	it('stay exact through new rows, updates, tombstones and parallel writes', async () => {
		const user = newUser();
		const now = Date.now();
		await putItems(
			DB,
			board,
			user,
			[1, 2, 3].map((n) => boardItem(n)),
			now
		);
		expect(await counted(user, 'board')).toEqual({ kept: 3, real: 3 });
		// An update, an older write that loses, a tombstone and a new key.
		const later = new Date(now + 1000).toISOString();
		await putItems(
			DB,
			board,
			user,
			[
				boardItem(1, later),
				boardItem(2, '2025-01-01T00:00:00.000Z'),
				{ key: MBID(3), data: null, at: later },
				boardItem(4, later)
			],
			now
		);
		expect(await counted(user, 'board')).toEqual({ kept: 4, real: 4 });
		// Several writes at once, overlapping keys.
		await Promise.all(
			[0, 1, 2, 3].map((i) =>
				putItems(
					DB,
					board,
					user,
					[10 + i, 11 + i, 12 + i].map((n) => boardItem(n, new Date(now + 2000 + i).toISOString())),
					now
				)
			)
		);
		expect(await counted(user, 'board')).toEqual({ kept: 10, real: 10 });
	});

	it('are counted again when rows are forgotten', async () => {
		const user = newUser();
		const now = Date.now();
		const small = { ...plays, maxRows: 10 };
		const play = (n: number) => {
			const at = new Date(now - n * 60_000).toISOString();
			return { key: `${at} ${MBID(n)}`, data: {}, at };
		};
		await putItems(DB, small, user, [1, 2, 3, 4, 5, 6, 7, 8].map(play), now);
		expect(await counted(user, 'plays')).toEqual({ kept: 8, real: 8 });
		await putItems(DB, small, user, [9, 10, 11, 12].map(play), now);
		// 12 is past 10: down to the newest 9, plus the oldest, which came last (the highest seq
		// always stays).
		expect(await counted(user, 'plays')).toEqual({ kept: 10, real: 10 });
	});

	it('make a full board refuse more, without counting it', async () => {
		const user = newUser();
		const now = Date.now();
		const small = { ...board, maxRows: 3 };
		await putItems(
			DB,
			small,
			user,
			[1, 2, 3].map((n) => boardItem(n)),
			now
		);
		await expect(putItems(DB, small, user, [boardItem(4)], now)).rejects.toThrow();
		// Changing rows it has is fine.
		const later = new Date(now + 1000).toISOString();
		await putItems(DB, small, user, [boardItem(1, later), boardItem(2, later)], now);
		expect(await counted(user, 'board')).toEqual({ kept: 3, real: 3 });
	});
});

describe('daily row budget', () => {
	const put = (user: string, n: number, first = 0) =>
		call('/api/board', {
			method: 'PUT',
			devUser: user,
			body: {
				items: Array.from({ length: n }, (_, i) => ({
					key: MBID(first + i),
					state: 'go',
					name: 'Artist',
					at: new Date().toISOString()
				}))
			}
		});

	it('refuses writes past the day’s budget, until tomorrow', async () => {
		const user = newUser();
		await DB.prepare('INSERT INTO usage (user, day, rows) VALUES (?, ?, ?)')
			.bind(user, dayOf(Date.now()), DAILY_ROWS - 2)
			.run();
		const over = await put(user, 3);
		expect(over.status).toBe(429);
		expect(await over.json()).toEqual({ error: expect.stringMatching(/synced a lot today/) });
		const retry = Number(over.headers.get('Retry-After'));
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(86_400);
		// Nothing was written, and what's left can still be used.
		expect((await counted(user, 'board'))?.real).toBe(0);
		expect((await put(user, 2)).status).toBe(200);
		expect((await put(user, 1, 10)).status).toBe(429);
		// Reads still work.
		expect((await call('/api/board', { devUser: user })).status).toBe(200);
	});

	it('starts again the next day', async () => {
		const user = newUser();
		await DB.prepare('INSERT INTO usage (user, day, rows) VALUES (?, ?, ?)')
			.bind(user, '2026-01-01', DAILY_ROWS)
			.run();
		expect((await put(user, 5)).status).toBe(200);
		const row = await DB.prepare('SELECT day, rows FROM usage WHERE user = ?').bind(user).first();
		expect(row).toEqual({ day: dayOf(Date.now()), rows: 5 });
	});

	it('counts every collection', async () => {
		const user = newUser();
		const now = Date.now();
		await putItems(DB, board, user, [boardItem(1)], now);
		const at = new Date(now).toISOString();
		await putItems(DB, plays, user, [{ key: `${at} ${MBID(1)}`, data: {}, at }], now);
		const row = await DB.prepare('SELECT rows FROM usage WHERE user = ?')
			.bind(user)
			.first<{ rows: number }>();
		expect(row?.rows).toBe(2);
	});
});

describe('request bodies', () => {
	/** A request whose body is streamed without a Content-Length (chunked). */
	function chunked(bytes: number) {
		const chunk = new TextEncoder().encode(' '.repeat(16 * 1024));
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= bytes) return controller.close();
				controller.enqueue(chunk);
				sent += chunk.byteLength;
			}
		});
		return new Request('http://localhost:8787/api/logout', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomIp() },
			body,
			// @ts-expect-error: needed for a streamed body in some runtimes
			duplex: 'half'
		});
	}

	const send = (request: Request) =>
		worker.fetch(
			request as Parameters<typeof worker.fetch>[0],
			DEV_ENV as Env,
			createExecutionContext()
		);

	it('stops reading one past the limit, with or without Content-Length', async () => {
		const request = chunked(LIMITS.body * 4);
		expect(request.headers.get('Content-Length')).toBeNull();
		const res = await send(request);
		expect(res.status).toBe(413);
		const small = chunked(1);
		expect((await send(small)).status).toBe(400); // spaces aren't JSON
	});
});

describe('rate limits on reads', () => {
	it('allow 120 reads a minute per account', async () => {
		const user = newUser();
		const get = () => call('/api/board', { devUser: user });
		for (let i = 0; i < 120; i++) expect((await get()).status).toBe(200);
		const over = await get();
		expect(over.status).toBe(429);
		expect(over.headers.get('Retry-After')).toBe('60');
		expect((await call('/api/board', { devUser: newUser() })).status).toBe(200);
	});

	it('allow 300 requests a minute per address, signed in or not', async () => {
		const ip = randomIp();
		const headers = { 'CF-Connecting-IP': ip, Cookie: 'giggle_session_dev=nonsense' };
		for (let i = 0; i < 300; i++) {
			expect((await call('/api/me', { headers })).status).toBe(401);
		}
		expect((await call('/api/me', { headers })).status).toBe(429);
		expect((await call('/api/board', { headers, devUser: newUser() })).status).toBe(429);
	});
});
