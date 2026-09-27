import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBoard, saveBoard, setTriage, type Board, type Triage } from '$lib/board/board';
import { memoryStorage, readJson, writeJson } from '$lib/storage';
import { SYNC_STORAGE_KEY, SyncClient, type SyncState, type SyncStatus } from './client';
import type { WireItem } from './wire';

// --- a fake accounts API with the Worker's semantics ------------------------------------------

type Mode = 'ok' | 'down' | 'unauthorized' | 'redirect' | 'html' | 'error500';

interface Row extends WireItem {
	seq: number;
}

class FakeServer {
	users = new Map<string, Map<string, Row>>();
	seq = new Map<string, number>();
	mode: Mode = 'ok';
	pageSize = 1000;
	now = () => Date.now();
	requests: { user: string; method: string; path: string; body?: unknown }[] = [];
	/** Held requests: resolve to let them through. */
	/** Holds PUTs until resolved. */
	gate: Promise<void> | null = null;

	rows(user: string): Map<string, Row> {
		let rows = this.users.get(user);
		if (!rows) this.users.set(user, (rows = new Map()));
		return rows;
	}

	board(user: string): Record<string, WireItem> {
		return Object.fromEntries(
			[...this.rows(user)].map(([key, { seq: _seq, ...item }]) => [key, item])
		);
	}

	fetchFor(user: string): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), 'http://localhost');
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			const method = init?.method ?? 'GET';
			this.requests.push({ user, method, path: url.pathname + url.search, body });
			if (this.gate && method === 'PUT') await this.gate;
			expect(init?.redirect).toBe('manual');
			switch (this.mode) {
				case 'down':
					throw new TypeError('Failed to fetch');
				case 'unauthorized':
					return Response.json({ error: 'not signed in' }, { status: 401 });
				case 'redirect':
					return {
						type: 'opaqueredirect',
						status: 0,
						ok: false,
						headers: new Headers()
					} as Response;
				case 'html':
					return new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } });
				case 'error500':
					return Response.json({ error: 'boom' }, { status: 500 });
			}
			if (url.pathname === '/api/me') return Response.json({ user, via: 'dev', passkeys: 0 });
			if (url.pathname !== '/api/board') return Response.json({ error: 'nf' }, { status: 404 });
			if (method === 'PUT') return Response.json({ items: this.put(user, body.items) });
			return Response.json(this.get(user, Number(url.searchParams.get('since') ?? 0)));
		}) as typeof fetch;
	}

	put(user: string, items: WireItem[]): WireItem[] {
		const rows = this.rows(user);
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			const ms = Math.min(Date.parse(item.at), this.now()); // clamps clocks running ahead
			const incoming = { ...item, at: new Date(ms).toISOString() };
			const stored = rows.get(item.key);
			if (stored && Date.parse(stored.at) >= ms) continue;
			const seq = (this.seq.get(user) ?? 0) + 1;
			this.seq.set(user, seq);
			rows.set(item.key, { ...incoming, seq });
		}
		return items.map((item) => {
			const { seq: _seq, ...row } = rows.get(item.key)!;
			return row;
		});
	}

	get(user: string, since: number) {
		const changed = [...this.rows(user).values()]
			.filter((row) => row.seq > since)
			.sort((a, b) => a.seq - b.seq);
		const page = changed.slice(0, this.pageSize);
		return {
			items: page.map(({ seq: _seq, ...row }) => row),
			cursor: String(page.at(-1)?.seq ?? since),
			more: changed.length > this.pageSize
		};
	}

	count(method: string, path?: string) {
		return this.requests.filter((r) => r.method === method && (!path || r.path.startsWith(path)))
			.length;
	}
}

// --- a device: its own storage and SyncClient ---------------------------------------------

class FakeEvents {
	listeners = new Map<string, Set<(event?: { key?: string | null }) => void>>();
	addEventListener(type: string, listener: () => void) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}
	removeEventListener(type: string, listener: () => void) {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string, event?: { key?: string | null }) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function device(server: FakeServer, user: string, options: { fetch?: typeof fetch } = {}) {
	const storage = memoryStorage();
	const events = new FakeEvents();
	const online = { value: true };
	const statuses: SyncStatus[] = [];
	const boards: Board[] = [];
	const client = new SyncClient({
		fetch: options.fetch ?? server.fetchFor(user),
		storage,
		events,
		isOnline: () => online.value,
		random: () => 1,
		debounceMs: 1000,
		pollMs: 60_000,
		backoffMs: { base: 1000, max: 8000 },
		onBoard: (board) => boards.push(board)
	});
	client.subscribe((status) => statuses.push(status));
	return {
		storage,
		events,
		online,
		client,
		statuses,
		boards,
		get board() {
			return loadBoard(storage);
		},
		states(): SyncState[] {
			return statuses.map((s) => s.state);
		},
		/** Sort an artist the way the radio does: save, then tell the client. */
		triage(key: string, state: Triage | null, name = key) {
			saveBoard(setTriage(loadBoard(storage), key, state, { name }, new Date()), storage);
			client.notifyLocalChange();
		}
	};
}

const K = (n: number) => `mb:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-26T20:00:00Z'));
});
afterEach(() => vi.useRealTimers());

async function tick(ms = 0) {
	await vi.advanceTimersByTimeAsync(ms);
}

describe('SyncClient: two devices, one account', () => {
	it('pushes a local board and brings it to another device', async () => {
		const server = new FakeServer();
		const laptop = device(server, 'alice@example.test');
		laptop.triage(K(1), 'go', 'Mogwai');
		laptop.triage('name:slowdive', 'listen', 'Slowdive');
		await laptop.client.syncNow();
		expect(laptop.client.status).toMatchObject({
			state: 'synced',
			pending: 0,
			user: 'alice@example.test'
		});
		expect(Object.keys(server.board('alice@example.test')).sort()).toEqual(
			[K(1), 'name:slowdive'].sort()
		);

		const phone = device(server, 'alice@example.test');
		await phone.client.syncNow();
		expect(phone.board).toEqual(laptop.board);
		expect(phone.boards).toHaveLength(1); // told the app once
	});

	it('propagates a deletion as a tombstone', async () => {
		const server = new FakeServer();
		const laptop = device(server, 'alice@example.test');
		const phone = device(server, 'alice@example.test');
		laptop.triage(K(1), 'go', 'Mogwai');
		await laptop.client.syncNow();
		await phone.client.syncNow();
		expect(phone.board[K(1)]?.state).toBe('go');

		vi.advanceTimersByTime(60_000);
		laptop.triage(K(1), null); // board.ts just forgets the key
		expect(readJson(SYNC_STORAGE_KEY, laptop.storage)).toMatchObject({
			tombstones: { [K(1)]: '2026-09-26T20:01:00.000Z' }
		});
		await laptop.client.syncNow();
		expect(server.board('alice@example.test')[K(1)]).toMatchObject({ state: null });
		expect(readJson(SYNC_STORAGE_KEY, laptop.storage)).toMatchObject({ tombstones: {} });

		await phone.client.syncNow();
		expect(phone.board).toEqual({});
	});

	it('resolves conflicting edits by last write wins, deletions included', async () => {
		const server = new FakeServer();
		const laptop = device(server, 'alice@example.test');
		const phone = device(server, 'alice@example.test');
		laptop.triage('name:a', 'listen');
		laptop.triage('name:b', 'listen');
		await laptop.client.syncNow();
		await phone.client.syncNow();

		// Both offline for a while, editing the same artists.
		vi.advanceTimersByTime(1000);
		phone.triage('name:b', 'nope'); // older than laptop's deletion
		laptop.triage('name:a', 'go'); // older than phone's edit
		vi.advanceTimersByTime(1000);
		laptop.triage('name:b', null); // deleted, stamped now
		vi.advanceTimersByTime(1000);
		phone.triage('name:a', 'tickets'); // newer

		await phone.client.syncNow();
		await laptop.client.syncNow();
		await phone.client.syncNow();

		for (const d of [laptop, phone]) {
			expect(d.board['name:a']?.state).toBe('tickets');
			expect(d.board['name:b']).toBeUndefined();
		}
	});

	it('keeps accounts apart and starts over when the user changes', async () => {
		const server = new FakeServer();
		const shared = device(server, 'alice@example.test');
		shared.triage('name:a', 'go');
		await shared.client.syncNow();
		// Bob signs in on the same browser: his board is pulled in full, not from alice's cursor.
		server.put('bob@example.test', [
			{ key: 'name:b', state: 'go', name: 'B', at: '2026-09-26T19:00:00.000Z' }
		]);
		const bob = new SyncClient({
			fetch: server.fetchFor('bob@example.test'),
			storage: shared.storage,
			events: null
		});
		await bob.syncNow();
		expect(server.requests.at(-1)?.path).toBe('/api/board');
		expect(Object.keys(loadBoard(shared.storage)).sort()).toEqual(['name:a', 'name:b']);
		expect(server.board('alice@example.test')['name:b']).toBeUndefined();
	});
});

describe('SyncClient: scheduling', () => {
	it('debounces local changes into one push', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.client.start();
		await tick();
		const puts = server.count('PUT');
		d.triage('name:a', 'go');
		await tick(500);
		d.triage('name:b', 'go');
		await tick(500);
		d.triage('name:c', 'go');
		expect(server.count('PUT')).toBe(puts);
		await tick(1000);
		expect(server.count('PUT')).toBe(puts + 1);
		expect(server.requests.findLast((r) => r.method === 'PUT')?.body).toMatchObject({
			items: [{ key: 'name:a' }, { key: 'name:b' }, { key: 'name:c' }]
		});
		d.client.stop();
	});

	it('syncs on focus and polls while running', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.client.start();
		await tick();
		const gets = server.count('GET', '/api/board');
		d.events.emit('focus');
		await tick();
		expect(server.count('GET', '/api/board')).toBe(gets + 1);
		await tick(60_000);
		expect(server.count('GET', '/api/board')).toBe(gets + 2);
		d.client.stop();
		await tick(600_000);
		expect(server.count('GET', '/api/board')).toBe(gets + 2);
	});

	it('picks up another tab saving the board', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.client.start();
		await tick();
		saveBoard(setTriage(d.board, 'name:x', 'go', { name: 'X' }, new Date()), d.storage);
		d.events.emit('storage', { key: 'giggle:radio:said:v1' });
		await tick(5000);
		expect(server.board('alice@example.test')['name:x']).toBeUndefined();
		d.events.emit('storage', { key: 'giggle:board:v1' });
		await tick(1000);
		expect(server.board('alice@example.test')['name:x']).toMatchObject({ state: 'go' });
		d.client.stop();
	});

	it("doesn't lose a change made while a round is in flight", async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.triage('name:a', 'go');
		let release!: () => void;
		server.gate = new Promise((resolve) => (release = resolve));
		const round = d.client.syncNow();
		while (!server.count('PUT')) await Promise.resolve();
		d.triage('name:b', 'listen'); // while the push is in flight
		server.gate = null;
		release();
		await round;
		expect(d.board['name:b']?.state).toBe('listen');
		expect(d.client.status.pending).toBe(1);
		await d.client.syncNow();
		expect(server.board('alice@example.test')['name:b']).toMatchObject({ state: 'listen' });
		expect(d.client.status.pending).toBe(0);
	});
});

describe('SyncClient: failures', () => {
	it('goes offline and retries with backoff, then recovers', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.triage('name:a', 'go');
		server.mode = 'down';
		d.client.start();
		await tick();
		expect(d.client.status).toMatchObject({ state: 'offline', pending: 1 });
		const attempts = () => server.count('GET', '/api/me');
		expect(attempts()).toBe(1);
		await tick(1000); // 1 s
		expect(attempts()).toBe(2);
		await tick(2000); // 2 s
		expect(attempts()).toBe(3);
		await tick(3999); // 4 s, not yet
		expect(attempts()).toBe(3);
		await tick(1);
		expect(attempts()).toBe(4);
		server.mode = 'error500';
		await tick(8000);
		expect(d.client.status).toMatchObject({ state: 'offline', error: 'server error 500' });
		server.mode = 'ok';
		await tick(8000); // capped at max
		expect(d.client.status).toMatchObject({ state: 'synced', pending: 0 });
		expect(d.states()).toContain('syncing');
		d.client.stop();
	});

	it("doesn't try while the browser is offline, and syncs when it's back", async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.online.value = false;
		d.client.start();
		await tick(60_000);
		expect(server.requests).toHaveLength(0);
		expect(d.client.status.state).toBe('offline');
		d.online.value = true;
		d.events.emit('online');
		await tick();
		expect(d.client.status.state).toBe('synced');
		d.client.stop();
	});

	it.each(['unauthorized', 'redirect', 'html'] as const)(
		'reports signed-out on %s and waits for focus or syncNow',
		async (mode) => {
			const server = new FakeServer();
			const d = device(server, 'alice@example.test');
			server.mode = mode;
			d.client.start();
			await tick();
			expect(d.client.status).toMatchObject({ state: 'signed-out', error: 'sign in again' });
			const before = server.requests.length;
			d.triage('name:a', 'go');
			await tick(600_000);
			expect(server.requests).toHaveLength(before); // no retry loop
			expect(d.client.status.pending).toBe(1);
			server.mode = 'ok';
			d.events.emit('focus');
			await tick();
			expect(d.client.status).toMatchObject({ state: 'synced', pending: 0 });
			d.client.stop();
		}
	);
});

describe('SyncClient: server rules', () => {
	it('pages through a long pull', async () => {
		const server = new FakeServer();
		server.pageSize = 2;
		server.put(
			'alice@example.test',
			[1, 2, 3, 4, 5].map((n) => ({
				key: K(n),
				state: 'go',
				name: `A${n}`,
				at: '2026-09-26T19:00:00.000Z'
			}))
		);
		const d = device(server, 'alice@example.test');
		await d.client.syncNow();
		expect(Object.keys(d.board)).toHaveLength(5);
		expect(server.count('GET', '/api/board')).toBe(3);
	});

	it('accepts the server clamping a clock that runs ahead, without looping', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		const future = new Date('2026-09-27T20:00:00Z');
		saveBoard(setTriage({}, 'name:a', 'go', { name: 'A' }, future), d.storage);
		d.client.start();
		await tick(10_000);
		expect(server.count('PUT')).toBe(1);
		expect(d.board['name:a']?.at).toBe('2026-09-26T20:00:00.000Z');
		expect(d.client.status).toMatchObject({ state: 'synced', pending: 0 });
		d.client.stop();
	});

	it('keeps items the server would refuse on this device only', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.triage('weird-key', 'go');
		d.triage('name:ok', 'go');
		await d.client.syncNow();
		expect(Object.keys(server.board('alice@example.test'))).toEqual(['name:ok']);
		expect(d.board['weird-key']?.state).toBe('go');
		expect(d.client.status.pending).toBe(0);
	});

	it('survives a corrupt sync record', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		writeJson(SYNC_STORAGE_KEY, { cursor: 'drop tables', base: 'x', tombstones: [1] }, d.storage);
		d.triage('name:a', 'go');
		await d.client.syncNow();
		expect(d.client.status.state).toBe('synced');
		expect(server.board('alice@example.test')['name:a']).toMatchObject({ state: 'go' });
	});
});
