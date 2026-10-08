import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBoard, saveBoard, setArtist, type ArtistTriage, type Board } from '$lib/board/board';
import { memoryStorage, readJson, writeJson } from '$lib/storage';
import { boardCollection } from './collections';
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

/**
 * A device signed in as `user`. By default it has just made the account, so what it sorts before
 * its first round is the account's; `newAccount: false` signs in to an existing one instead.
 */
function device(
	server: FakeServer,
	user: string,
	options: { fetch?: typeof fetch; newAccount?: boolean; personalKeys?: string[] } = {}
) {
	const storage = memoryStorage();
	const events = new FakeEvents();
	const online = { value: true };
	const statuses: SyncStatus[] = [];
	const boards: Board[] = [];
	const client = new SyncClient({
		collections: [boardCollection],
		fetch: options.fetch ?? server.fetchFor(user),
		storage,
		events,
		isOnline: () => online.value,
		random: () => 1,
		debounceMs: 1000,
		pollMs: 60_000,
		backoffMs: { base: 1000, max: 8000 },
		onChange: (name, data) => name === 'board' && boards.push(data as Board),
		personalKeys: options.personalKeys
	});
	client.prepareSignIn(options.newAccount === false ? 'existing-account' : 'new-account');
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
		triage(key: string, state: ArtistTriage | null, name = key) {
			saveBoard(setArtist(loadBoard(storage), { key, name }, state, new Date()), storage);
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
		laptop.triage(K(1), 'listen', 'Mogwai');
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
		laptop.triage(K(1), 'listen', 'Mogwai');
		await laptop.client.syncNow();
		await phone.client.syncNow();
		expect(phone.board[K(1)]?.state).toBe('listen');

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
		laptop.triage('name:a', 'listen'); // older than phone's edit
		vi.advanceTimersByTime(1000);
		laptop.triage('name:b', null); // deleted, stamped now
		vi.advanceTimersByTime(1000);
		phone.triage('name:a', 'nope'); // newer

		await phone.client.syncNow();
		await laptop.client.syncNow();
		await phone.client.syncNow();

		for (const d of [laptop, phone]) {
			expect(d.board['name:a']?.state).toBe('nope');
			expect(d.board['name:b']).toBeUndefined();
		}
	});

	it('keeps accounts apart: another account’s data leaves the device', async () => {
		const server = new FakeServer();
		const shared = device(server, 'alice@example.test');
		shared.triage('name:a', 'listen');
		await shared.client.syncNow();
		// Bob signs in on the same browser: his board is pulled in full, not from alice's cursor,
		// and alice's board goes (her account keeps it).
		server.put('bob@example.test', [
			{ key: 'name:b', state: 'listen', name: 'B', at: '2026-09-26T19:00:00.000Z' }
		]);
		const bob = new SyncClient({
			collections: [boardCollection],
			fetch: server.fetchFor('bob@example.test'),
			storage: shared.storage,
			events: null
		});
		// Even straight after making an account: alice's data isn't "made while signed out".
		bob.prepareSignIn('new-account');
		await bob.syncNow();
		expect(server.requests.at(-1)?.path).toBe('/api/board');
		expect(Object.keys(loadBoard(shared.storage))).toEqual(['name:b']);
		expect(Object.keys(server.board('bob@example.test'))).toEqual(['name:b']);
		expect(Object.keys(server.board('alice@example.test'))).toEqual(['name:a']);
	});
});

describe('SyncClient: signing in and out', () => {
	const bobsBoard = (server: FakeServer) =>
		server.put('bob@example.test', [
			{ key: 'name:b', state: 'listen', name: 'B', at: '2026-09-26T19:00:00.000Z' }
		]);

	it('signing in to an existing account shows its data, not what was sorted signed out', async () => {
		const server = new FakeServer();
		bobsBoard(server);
		const d = device(server, 'bob@example.test', { newAccount: false });
		d.triage('name:local', 'listen');
		await d.client.syncNow();
		expect(Object.keys(d.board)).toEqual(['name:b']);
		expect(Object.keys(server.board('bob@example.test'))).toEqual(['name:b']);
		expect(d.boards.at(-1)).toEqual(d.board); // the app was told
		expect(d.client.status).toMatchObject({ state: 'synced', pending: 0 });
	});

	it('a new account adopts what was sorted here while signed out', async () => {
		const server = new FakeServer();
		const d = device(server, 'carol@example.test');
		d.triage('name:local', 'listen');
		await d.client.syncNow();
		expect(Object.keys(server.board('carol@example.test'))).toEqual(['name:local']);
		expect(Object.keys(d.board)).toEqual(['name:local']);
		expect(readJson('giggle:sync:adopt:v1', d.storage)).toBeUndefined(); // used up
	});

	it('only just after making the account', async () => {
		const server = new FakeServer();
		bobsBoard(server);
		const d = device(server, 'bob@example.test');
		d.triage('name:local', 'listen');
		vi.advanceTimersByTime(11 * 60_000); // the passkey dialog was long ago
		await d.client.syncNow();
		expect(Object.keys(d.board)).toEqual(['name:b']);
		expect(server.board('bob@example.test')['name:local']).toBeUndefined();
	});

	it('signing out clears this device, and the account keeps its data', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test', { personalKeys: ['giggle:radio:said:v1'] });
		writeJson('giggle:radio:said:v1', { x: 1 }, d.storage);
		writeJson('giggle:radio:settings:v1', { voice: 'kokoro' }, d.storage);
		d.triage('name:a', 'listen');
		await d.client.syncNow();

		d.client.forget();
		expect(d.board).toEqual({});
		expect(d.boards.at(-1)).toEqual({});
		expect(readJson(SYNC_STORAGE_KEY, d.storage)).toMatchObject({ user: null, cursor: null });
		expect(readJson('giggle:radio:said:v1', d.storage)).toBeUndefined();
		expect(readJson('giggle:radio:settings:v1', d.storage)).toEqual({ voice: 'kokoro' });
		expect(d.client.status).toMatchObject({ state: 'signed-out', user: null, pending: 0 });
		expect(Object.keys(server.board('alice@example.test'))).toEqual(['name:a']);

		// Signing back in brings it back.
		d.client.prepareSignIn('existing-account');
		await d.client.signedIn();
		expect(Object.keys(d.board)).toEqual(['name:a']);
	});

	it('a round running while signing out saves nothing', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.triage('name:a', 'listen');
		let release!: () => void;
		server.gate = new Promise((resolve) => (release = resolve));
		const round = d.client.syncNow();
		await tick();
		d.client.forget();
		release();
		await round;
		expect(d.board).toEqual({});
		expect(readJson(SYNC_STORAGE_KEY, d.storage)).toMatchObject({ user: null, base: {} });
		expect(d.client.status.state).toBe('signed-out');
	});
});

describe('SyncClient: scheduling', () => {
	it('debounces local changes into one push', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.client.start();
		await tick();
		const puts = server.count('PUT');
		d.triage('name:a', 'listen');
		await tick(500);
		d.triage('name:b', 'listen');
		await tick(500);
		d.triage('name:c', 'listen');
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
		saveBoard(setArtist(d.board, { key: 'name:x', name: 'X' }, 'listen', new Date()), d.storage);
		d.events.emit('storage', { key: 'giggle:radio:said:v1' });
		await tick(5000);
		expect(server.board('alice@example.test')['name:x']).toBeUndefined();
		d.events.emit('storage', { key: 'giggle:board:v1' });
		await tick(1000);
		expect(server.board('alice@example.test')['name:x']).toMatchObject({ state: 'listen' });
		d.client.stop();
	});

	it("doesn't lose a change made while a round is in flight", async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		d.triage('name:a', 'listen');
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
		d.triage('name:a', 'listen');
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
			d.triage('name:a', 'listen');
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
				state: 'listen',
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
		saveBoard(setArtist({}, { key: 'name:a', name: 'A' }, 'listen', future), d.storage);
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
		d.triage('weird-key', 'listen');
		d.triage('name:ok', 'listen');
		await d.client.syncNow();
		expect(Object.keys(server.board('alice@example.test'))).toEqual(['name:ok']);
		expect(d.board['weird-key']?.state).toBe('listen');
		expect(d.client.status.pending).toBe(0);
	});

	it('survives a corrupt sync record', async () => {
		const server = new FakeServer();
		const d = device(server, 'alice@example.test');
		writeJson(SYNC_STORAGE_KEY, { cursor: 'drop tables', base: 'x', tombstones: [1] }, d.storage);
		d.triage('name:a', 'listen');
		await d.client.syncNow();
		expect(d.client.status.state).toBe('synced');
		expect(server.board('alice@example.test')['name:a']).toMatchObject({ state: 'listen' });
	});
});
