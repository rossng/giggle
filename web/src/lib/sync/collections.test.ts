import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordPlay, type PlayHistory } from '@giggle/radio-core';
import { loadBoard, saveBoard, setTriage } from '$lib/board/board';
import {
	addRule,
	loadUnavailable,
	removeRule,
	saveUnavailable,
	type Rule
} from '$lib/data/unavailable';
import { KEYS, loadHistory, saveHistory } from '$lib/radio/persist';
import { memoryStorage, readJson } from '$lib/storage';
import { applyRound, emptyRecord, outgoing } from './collection';
import { SyncClient } from './client';
import {
	ALL_COLLECTIONS,
	historyToPlays,
	playKey,
	playsCollection,
	playsToHistory,
	splitPlayKey,
	SYNC_STORAGE_KEY
} from './collections';

const DAY = 86_400_000;

// --- a fake accounts API with the Worker's semantics, for every collection -------------------

type Wire = { key: string; at: string } & Record<string, unknown>;

class FakeServer {
	rows = new Map<string, Map<string, Wire & { seq: number }>>();
	seqs = new Map<string, number>();
	requests: { method: string; path: string; body?: { items: Wire[] } }[] = [];

	table(user: string, name: string) {
		const id = `${user} ${name}`;
		if (!this.rows.has(id)) this.rows.set(id, new Map());
		return this.rows.get(id)!;
	}

	items(user: string, name: string): Wire[] {
		return [...this.table(user, name).values()].map(({ seq: _seq, ...w }) => w);
	}

	/** Worker rules: LWW by `at`; plays keyed by time and artist, from the future or too old dropped. */
	put(user: string, name: string, items: Wire[]): Wire[] {
		const table = this.table(user, name);
		const out: Wire[] = [];
		for (const raw of items) {
			const ms = Date.parse(raw.at);
			const item = { ...raw, at: new Date(ms).toISOString() };
			if (name === 'plays' && (ms > Date.now() + 600_000 || ms < Date.now() - 60 * DAY)) continue;
			const id = name === 'plays' ? `${item.at} ${item.key}` : item.key;
			const stored = table.get(id);
			if (!stored || Date.parse(stored.at) < ms) {
				const seq = (this.seqs.get(`${user} ${name}`) ?? 0) + 1;
				this.seqs.set(`${user} ${name}`, seq);
				table.set(id, { ...item, seq });
			}
			const { seq: _seq, ...row } = table.get(id)!;
			out.push(row);
		}
		return out;
	}

	fetchFor(user: string): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), 'http://localhost');
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			this.requests.push({ method, path: url.pathname + url.search, body });
			if (url.pathname === '/api/me') return Response.json({ user, via: 'dev', passkeys: 0 });
			const name = url.pathname.slice('/api/'.length);
			if (!['board', 'unavailable', 'plays'].includes(name)) {
				return Response.json({ error: 'not found' }, { status: 404 });
			}
			if (method === 'PUT') return Response.json({ items: this.put(user, name, body.items) });
			const since = Number(url.searchParams.get('since') ?? 0);
			const changed = [...this.table(user, name).values()]
				.filter((row) => row.seq > since)
				.sort((a, b) => a.seq - b.seq);
			return Response.json({
				items: changed.map(({ seq: _seq, ...w }) => w),
				cursor: String(changed.at(-1)?.seq ?? since),
				more: false
			});
		}) as typeof fetch;
	}
}

function device(server: FakeServer, user = 'alice@example.test') {
	const storage = memoryStorage();
	const changes: { name: string; data: unknown }[] = [];
	const client = new SyncClient({
		collections: ALL_COLLECTIONS,
		fetch: server.fetchFor(user),
		storage,
		events: null,
		isOnline: () => true,
		onChange: (name, data) => changes.push({ name, data })
	});
	return {
		storage,
		client,
		changes,
		get unavailable() {
			return loadUnavailable(storage);
		},
		get history(): PlayHistory {
			return loadHistory(new Date(), storage);
		},
		addDates(rule: Rule, label = '') {
			saveUnavailable(addRule(loadUnavailable(storage), rule, label, new Date()), storage);
			client.notifyLocalChange();
		},
		removeDates(key: string) {
			saveUnavailable(removeRule(loadUnavailable(storage), key), storage);
			client.notifyLocalChange();
		},
		/** The radio: an artist heard now. */
		play(artistKey: string) {
			const now = new Date();
			saveHistory(recordPlay(loadHistory(now, storage), artistKey, now), storage);
			client.notifyLocalChange();
		}
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-26T20:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('unavailable dates across devices', () => {
	it('brings added dates to another device and syncs their removal', async () => {
		const server = new FakeServer();
		const laptop = device(server);
		const phone = device(server);
		laptop.addDates({ kind: 'weekly', weekday: 0 });
		laptop.addDates({ kind: 'range', first: '2026-10-10', last: '2026-10-17' }, 'Lisbon');
		await laptop.client.syncNow();
		expect(server.items('alice@example.test', 'unavailable')).toHaveLength(2);

		await phone.client.syncNow();
		expect(phone.unavailable).toEqual(laptop.unavailable);
		expect(phone.unavailable['2026-10-10/2026-10-17']?.label).toBe('Lisbon');
		expect(phone.changes.map((c) => c.name)).toEqual(['unavailable']);

		vi.advanceTimersByTime(60_000);
		phone.removeDates('weekly:mon');
		await phone.client.syncNow();
		expect(server.items('alice@example.test', 'unavailable')).toContainEqual({
			key: 'weekly:mon',
			deleted: true,
			at: '2026-09-26T20:01:00.000Z'
		});
		await laptop.client.syncNow();
		expect(Object.keys(laptop.unavailable)).toEqual(['2026-10-10/2026-10-17']);
	});

	it('resolves the same rule edited on two devices by last write wins', async () => {
		const server = new FakeServer();
		const laptop = device(server);
		const phone = device(server);
		laptop.addDates({ kind: 'day', date: '2026-12-25' }, 'Family');
		vi.advanceTimersByTime(1000);
		phone.addDates({ kind: 'day', date: '2026-12-25' }, 'Christmas');
		await laptop.client.syncNow();
		await phone.client.syncNow();
		await laptop.client.syncNow();
		for (const d of [laptop, phone]) {
			expect(d.unavailable).toEqual({
				'2026-12-25': { label: 'Christmas', at: '2026-09-26T20:00:01.000Z' }
			});
			expect(d.client.status.pending).toBe(0);
		}
	});
});

describe('play history across devices', () => {
	it('merges both devices’ plays, and each play is sent once', async () => {
		const server = new FakeServer();
		const laptop = device(server);
		const phone = device(server);
		laptop.play('name:mogwai');
		vi.advanceTimersByTime(60_000);
		phone.play('name:slowdive');
		vi.advanceTimersByTime(60_000);
		phone.play('name:mogwai');
		expect(phone.client.status.pending).toBe(2);

		await laptop.client.syncNow();
		await phone.client.syncNow();
		await laptop.client.syncNow();

		const t0 = Date.parse('2026-09-26T20:00:00Z');
		const expected = { 'name:mogwai': [t0, t0 + 120_000], 'name:slowdive': [t0 + 60_000] };
		expect(laptop.history).toEqual(expected);
		expect(phone.history).toEqual(expected);
		expect(server.items('alice@example.test', 'plays')).toHaveLength(3);
		// Nothing pulled from the server is pushed back.
		const playPuts = server.requests.filter((r) => r.method === 'PUT' && r.path === '/api/plays');
		expect(playPuts.flatMap((r) => r.body!.items)).toHaveLength(3);
		expect(laptop.client.status.pending).toBe(0);
		expect(phone.client.status.pending).toBe(0);
		// The laptop's radio hears about the phone's plays.
		expect(laptop.changes.at(-1)).toEqual({ name: 'plays', data: expected });
	});

	it("doesn't send plays too close to the 60-day cut-off, or keep re-sending ones the server drops", async () => {
		const server = new FakeServer();
		const d = device(server);
		const now = Date.now();
		saveHistory(
			{
				'name:old': [now - 59.5 * DAY], // kept here, not worth sending
				'name:future': [now + DAY], // a clock that ran ahead: the server drops it
				'name:ok': [now - DAY]
			},
			d.storage
		);
		expect(d.client.status.pending).toBe(0); // not counted until noticed
		d.client.notifyLocalChange();
		expect(d.client.status.pending).toBe(2);
		await d.client.syncNow();
		expect(server.items('alice@example.test', 'plays').map((w) => w.key)).toEqual(['name:ok']);
		expect(d.client.status.pending).toBe(0);
		await d.client.syncNow();
		const puts = server.requests.filter((r) => r.method === 'PUT' && r.path === '/api/plays');
		expect(puts).toHaveLength(1);
		expect(d.history['name:future']).toHaveLength(1); // still heard, on this device
	});

	it('keeps its record small: what it knows the server has, only for plays it still keeps', async () => {
		const server = new FakeServer();
		const d = device(server);
		d.play('name:a');
		await d.client.syncNow();
		const record = readJson('giggle:sync:plays:v1', d.storage) as { base: unknown };
		expect(record.base).toEqual({ 'name:a': [Date.now()] }); // packed like the history
		// Two months on the play has aged out here; the record forgets it too.
		vi.advanceTimersByTime(61 * DAY);
		d.play('name:b');
		await d.client.syncNow();
		const after = readJson('giggle:sync:plays:v1', d.storage) as { base: unknown };
		expect(after.base).toEqual({ 'name:b': [Date.now()] });
	});
});

describe('one client, every collection', () => {
	it('syncs the board as before, under its old record key, alongside the rest', async () => {
		const server = new FakeServer();
		const d = device(server);
		saveBoard(
			setTriage(loadBoard(d.storage), 'name:a', 'go', { name: 'A' }, new Date()),
			d.storage
		);
		d.addDates({ kind: 'weekly', weekday: 5 });
		d.play('name:a');
		expect(d.client.status.pending).toBe(3);
		await d.client.syncNow();
		expect(d.client.status).toMatchObject({ state: 'synced', pending: 0 });
		expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			'GET /api/me',
			'PUT /api/board',
			'GET /api/board',
			'PUT /api/unavailable',
			'GET /api/unavailable',
			'PUT /api/plays',
			'GET /api/plays'
		]);
		expect(readJson(SYNC_STORAGE_KEY, d.storage)).toMatchObject({ cursor: '1' });
	});

	it('keeps a gig date the board stored locally when a sync rewrites the board', async () => {
		const server = new FakeServer();
		const d = device(server);
		const when = '2026-10-03T20:30:00+02:00';
		const meta = { name: 'A', gig: 'paradiso:1', when };
		saveBoard(setTriage({}, 'name:a', 'go', meta, new Date()), d.storage);
		await d.client.syncNow();
		server.put('alice@example.test', 'board', [
			{ key: 'name:b', state: 'listen', name: 'B', at: '2026-09-26T20:00:01.000Z' }
		]);
		await d.client.syncNow();
		expect(loadBoard(d.storage)['name:a']?.when).toBe(when);
		expect(loadBoard(d.storage)['name:b']?.state).toBe('listen');
	});
});

describe('plays: keys and conversions', () => {
	it('round-trips a history through play items', () => {
		const history = { 'name:a b': [1_000, 2_000], 'mb:x': [3_000] };
		const plays = historyToPlays(history);
		expect(Object.keys(plays).sort()).toEqual(['1000 name:a b', '2000 name:a b', '3000 mb:x']);
		expect(playsToHistory(plays)).toEqual(history);
		expect(splitPlayKey(playKey('name:a b', 5))).toEqual({ artistKey: 'name:a b', ms: 5 });
		expect(splitPlayKey('nonsense')).toBeNull();
	});

	it('goes over the wire as {key: artist, at}', () => {
		const ms = Date.parse('2026-09-26T19:00:00Z');
		expect(
			playsCollection.toWire(playKey('name:a', ms), { at: new Date(ms).toISOString() })
		).toEqual({ key: 'name:a', at: '2026-09-26T19:00:00.000Z' });
		expect(playsCollection.fromWire({ key: 'name:a', at: '2026-09-26T21:00:00+02:00' })).toEqual({
			key: playKey('name:a', ms),
			item: { at: '2026-09-26T19:00:00.000Z' }
		});
		expect(playsCollection.fromWire({ key: 'name:a', at: 'soon' })).toBeNull();
	});

	it('treats pruned plays as housekeeping, not deletions', () => {
		const now = new Date();
		const record = { ...emptyRecord<{ at: string }>(), base: historyToPlays({ 'name:a': [1] }) };
		expect(outgoing(playsCollection, record, {}, now)).toEqual([]);
		const result = applyRound(playsCollection, {
			record,
			local: {},
			sent: [],
			stored: [],
			pulled: [],
			cursor: '4',
			now
		});
		expect(result.record.tombstones).toEqual({});
		expect(result.record.base).toEqual({});
		expect(result.items).toBeNull();
	});
});

it('stores plays under the radio’s own history key', () => {
	expect(playsCollection.dataKey).toBe(KEYS.history);
});
