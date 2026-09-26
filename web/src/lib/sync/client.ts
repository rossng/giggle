// Keeps this browser's board in step with the accounts API (worker/, `/api/board`).
//
// Local-first: the board in localStorage (board.ts) is always the source for the UI; the
// SyncClient pushes local changes and pulls remote ones in the background, merging last write
// wins per artist. It runs a round on start, shortly after `notifyLocalChange()` (debounced), when
// the window regains focus or the network comes back, and every few minutes; failures back off.
//
// Its own record lives under SYNC_STORAGE_KEY: the pull cursor, the board as last in step with the
// server (`base`, to find local changes and deletions by diffing), and pending tombstones.
//
// Integration: call `notifyLocalChange()` after every saveBoard(), and adopt the board passed to
// `onBoard` (it has already been saved) — don't write back an older in-memory copy over it.

import { BOARD_STORAGE_KEY, loadBoard, parseBoard, saveBoard, type Board } from '$lib/board/board';
import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';
import {
	boardOf,
	diffBoards,
	mergeBoards,
	recordDeletions,
	sameBoard,
	sameItem,
	toSyncMap,
	type SyncMap,
	type Tombstones
} from './merge';
import { fromWire, isSyncable, LIMITS, toWire, type SyncItem, type WireItem } from './wire';

export const SYNC_STORAGE_KEY = 'giggle:sync:v1';

export type SyncState = 'synced' | 'syncing' | 'offline' | 'signed-out' | 'error';

export interface SyncStatus {
	state: SyncState;
	/** The signed-in email, once known. */
	user: string | null;
	/** When the last round finished cleanly (ISO 8601). */
	lastSyncedAt: string | null;
	/** Local changes not yet on the server. */
	pending: number;
	/** Why the last round failed, for a tooltip. */
	error: string | null;
}

/** What the sync module keeps in storage. */
export interface SyncRecord {
	version: 1;
	user: string | null;
	/** From the last pull; null pulls everything. */
	cursor: string | null;
	/** The board as last known to match the server. */
	base: Board;
	tombstones: Tombstones;
	lastSyncedAt: string | null;
}

const EMPTY_RECORD: SyncRecord = {
	version: 1,
	user: null,
	cursor: null,
	base: {},
	tombstones: {},
	lastSyncedAt: null
};

export function parseRecord(value: unknown): SyncRecord {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<SyncRecord>;
	const tombstones: Record<string, string> = {};
	if (v.tombstones && typeof v.tombstones === 'object') {
		for (const [key, at] of Object.entries(v.tombstones)) {
			if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) tombstones[key] = at;
		}
	}
	return {
		version: 1,
		user: typeof v.user === 'string' ? v.user : null,
		cursor: typeof v.cursor === 'string' && /^\d+$/.test(v.cursor) ? v.cursor : null,
		base: parseBoard({ items: v.base }),
		tombstones,
		lastSyncedAt: typeof v.lastSyncedAt === 'string' ? v.lastSyncedAt : null
	};
}

/** Local changes waiting to be pushed: changed items plus pending deletions. */
export function outgoing(record: SyncRecord, board: Board): WireItem[] {
	const { changed } = diffBoards(record.base, board);
	const items: WireItem[] = changed.map((key) => toWire(key, board[key]!));
	for (const [key, at] of Object.entries(record.tombstones)) {
		items.push(toWire(key, { state: null, name: '', at }));
	}
	return items.filter((item) => isSyncable(item.key, item));
}

class SignedOut extends Error {}
class Offline extends Error {}
class Rejected extends Error {}

type Listener = (event?: { key?: string | null }) => void;

export interface SyncEvents {
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
}

export interface SyncClientOptions {
	/** Prefix for /api (default: same origin). */
	baseUrl?: string;
	fetch?: typeof fetch;
	storage?: KeyValueStorage | null;
	now?: () => Date;
	random?: () => number;
	/** Where focus/online/offline/storage events come from (default: window, if any). */
	events?: SyncEvents | null;
	isOnline?: () => boolean;
	debounceMs?: number;
	pollMs?: number;
	backoffMs?: { base: number; max: number };
	/** Called with the merged board whenever a sync changed it (it's already saved). */
	onBoard?: (board: Board) => void;
}

export class SyncClient {
	readonly #fetch: typeof fetch;
	readonly #storage: KeyValueStorage | null;
	readonly #now: () => Date;
	readonly #random: () => number;
	readonly #events: SyncEvents | null;
	readonly #isOnline: () => boolean;
	readonly #baseUrl: string;
	readonly #debounceMs: number;
	readonly #pollMs: number;
	readonly #backoff: { base: number; max: number };
	readonly #onBoard?: (board: Board) => void;

	#status: SyncStatus;
	#listeners = new Set<(status: SyncStatus) => void>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	#inFlight: Promise<void> | null = null;
	#again = false;
	#failures = 0;
	#checkedUser = false;
	#detach: (() => void) | null = null;

	constructor(options: SyncClientOptions = {}) {
		this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
		this.#storage = options.storage === undefined ? browserStorage() : options.storage;
		this.#now = options.now ?? (() => new Date());
		this.#random = options.random ?? Math.random;
		this.#events =
			options.events === undefined
				? typeof window === 'undefined'
					? null
					: window
				: options.events;
		this.#isOnline =
			options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
		this.#baseUrl = options.baseUrl ?? '';
		this.#debounceMs = options.debounceMs ?? 2000;
		this.#pollMs = options.pollMs ?? 5 * 60_000;
		this.#backoff = options.backoffMs ?? { base: 2000, max: 5 * 60_000 };
		this.#onBoard = options.onBoard;
		const record = this.#load();
		this.#status = {
			state: 'offline',
			user: record.user,
			lastSyncedAt: record.lastSyncedAt,
			pending: outgoing(record, this.#board()).length,
			error: null
		};
	}

	get status(): SyncStatus {
		return this.#status;
	}

	/** Calls `listener` now and on every status change; returns an unsubscribe function. */
	subscribe(listener: (status: SyncStatus) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#status);
		return () => void this.#listeners.delete(listener);
	}

	/** Starts syncing: a round now, then on changes, focus, reconnect and every few minutes. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		const soon = () => this.#schedule(0);
		const visible = () => {
			if (typeof document === 'undefined' || document.visibilityState === 'visible') soon();
		};
		const offline = () => this.#setStatus({ state: 'offline', error: null });
		// Another tab saved the board.
		const storage: Listener = (event) => {
			if (!event?.key || event.key === BOARD_STORAGE_KEY) this.notifyLocalChange();
		};
		const events = this.#events;
		events?.addEventListener('focus', soon);
		events?.addEventListener('online', soon);
		events?.addEventListener('offline', offline);
		events?.addEventListener('visibilitychange', visible);
		events?.addEventListener('storage', storage);
		this.#detach = () => {
			events?.removeEventListener('focus', soon);
			events?.removeEventListener('online', soon);
			events?.removeEventListener('offline', offline);
			events?.removeEventListener('visibilitychange', visible);
			events?.removeEventListener('storage', storage);
		};
		this.#schedule(0);
	}

	stop(): void {
		this.#running = false;
		this.#detach?.();
		this.#detach = null;
		this.#clearTimer();
	}

	/** The board was just saved locally: note deletions now, push after a short pause. */
	notifyLocalChange(): void {
		this.#noteLocalChanges();
		if (this.#status.state !== 'signed-out') this.#schedule(this.#debounceMs);
	}

	/** Runs a round now (or right after the one in flight), e.g. after signing in again. */
	syncNow(): Promise<void> {
		this.#clearTimer();
		if (this.#inFlight) {
			this.#again = true;
			return this.#inFlight;
		}
		this.#inFlight = this.#round().finally(() => {
			this.#inFlight = null;
			if (this.#again) {
				this.#again = false;
				this.#schedule(0);
			}
		});
		return this.#inFlight;
	}

	// --- one round -------------------------------------------------------------------------

	async #round(): Promise<void> {
		if (!this.#isOnline()) {
			this.#setStatus({ state: 'offline', error: null });
			return; // the 'online' event starts the next round
		}
		this.#setStatus({ state: 'syncing' });
		try {
			await this.#checkUser();
			const pushed = await this.#push();
			const pulled = await this.#pull();
			this.#apply(pushed, pulled.items, pulled.cursor);
			this.#failures = 0;
			const record = this.#load();
			const pending = outgoing(record, this.#board()).length;
			this.#setStatus({ state: 'synced', lastSyncedAt: record.lastSyncedAt, pending, error: null });
			this.#schedule(pending ? 0 : this.#pollMs);
		} catch (e) {
			this.#fail(e);
		}
	}

	#fail(e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		if (e instanceof SignedOut) {
			this.#checkedUser = false;
			// No retries: focus, reconnect or syncNow() try again.
			this.#setStatus({ state: 'signed-out', error: message });
			return;
		}
		this.#failures += 1;
		const delay = Math.min(this.#backoff.max, this.#backoff.base * 2 ** (this.#failures - 1));
		this.#setStatus({ state: e instanceof Rejected ? 'error' : 'offline', error: message });
		this.#schedule(Math.round(delay * (0.5 + this.#random() / 2)));
	}

	/** Once per start (and after signing in again): who is this? A different user starts over. */
	async #checkUser(): Promise<void> {
		if (this.#checkedUser) return;
		const me = (await this.#request('GET', '/api/me')) as { email?: unknown };
		if (typeof me.email !== 'string') throw new Rejected('unexpected /api/me response');
		const record = this.#load();
		if (record.user !== me.email) {
			// Another account's cursor and base mean nothing here: pull everything, push the board.
			this.#save({ ...EMPTY_RECORD, user: me.email });
		}
		this.#checkedUser = true;
		this.#setStatus({ user: me.email });
	}

	async #push(): Promise<Pushed> {
		this.#noteLocalChanges();
		const items = outgoing(this.#load(), this.#board());
		const stored: WireItem[] = [];
		for (let i = 0; i < items.length; i += LIMITS.batch) {
			const body = await this.#request('PUT', '/api/board', {
				items: items.slice(i, i + LIMITS.batch)
			});
			stored.push(...parseItems(body));
		}
		return { sent: items, stored };
	}

	async #pull(): Promise<{ items: WireItem[]; cursor: string | null }> {
		let cursor = this.#load().cursor;
		const items: WireItem[] = [];
		for (let page = 0; page < 1000; page++) {
			const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
			const body = (await this.#request('GET', `/api/board${query}`)) as {
				cursor?: unknown;
				more?: unknown;
			};
			items.push(...parseItems(body));
			if (typeof body.cursor !== 'string') throw new Rejected('response without a cursor');
			cursor = body.cursor;
			if (body.more !== true) break;
		}
		return { items, cursor };
	}

	/** Merges server rows into the board as it is *now* (it may have changed during the round). */
	#apply(pushed: Pushed, pulled: WireItem[], cursor: string | null): void {
		const record = this.#load();
		const board = this.#board();
		const tombstones = recordDeletions(
			record.tombstones,
			diffBoards(record.base, board),
			board,
			this.#now()
		);

		// Server rows, the pull (later) over the push responses.
		const remote: Record<string, SyncItem> = {};
		for (const { key, ...item } of [...pushed.stored, ...pulled]) remote[key] = item;

		// For what we pushed and haven't changed since, the server's answer is final even if it
		// looks older (it clamps timestamps from clocks running ahead).
		const local: Record<string, SyncItem> = { ...toSyncMap(board, tombstones) };
		for (const { key, ...sent } of pushed.sent) {
			if (remote[key] && sameItem(local[key], sent)) delete local[key];
		}

		const merged: SyncMap = mergeBoards(local, remote);
		const nextBoard = boardOf(merged);

		// A deletion stays pending until the server holds it (or something newer).
		const pending: Record<string, string> = {};
		for (const [key, at] of Object.entries(tombstones)) {
			const server = remote[key];
			const acked = server && Date.parse(server.at) >= Date.parse(at);
			if (!acked && merged[key]?.state === null) pending[key] = at;
		}

		// The base now matches the server for every row it sent.
		const base: Record<string, Board[string]> = { ...record.base };
		for (const [key, item] of Object.entries(remote)) {
			if (item.state === null) delete base[key];
			else base[key] = boardOf({ [key]: item })[key]!;
		}

		if (!sameBoard(board, nextBoard)) {
			saveBoard(nextBoard, this.#storage);
			this.#onBoard?.(nextBoard);
		}
		this.#save({
			...record,
			cursor,
			base,
			tombstones: pending,
			lastSyncedAt: this.#now().toISOString()
		});
	}

	// --- plumbing ----------------------------------------------------------------------------

	async #request(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<unknown> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers: {
					Accept: 'application/json',
					// Makes Cloudflare Access answer 401 instead of redirecting to its login page.
					'X-Requested-With': 'XMLHttpRequest',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' })
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				credentials: 'same-origin',
				redirect: 'manual',
				cache: 'no-store'
			});
		} catch (e) {
			throw new Offline(e instanceof Error ? e.message : 'network error');
		}
		// A redirect is Access sending us to its login page.
		if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
			throw new SignedOut('sign in again');
		}
		if (response.status >= 500 || response.status === 429) {
			throw new Offline(`server error ${response.status}`);
		}
		if (!response.ok) throw new Rejected(`${method} ${path}: ${response.status}`);
		if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) {
			// An HTML page where JSON should be: a login page in the way.
			throw new SignedOut('sign in again');
		}
		try {
			return await response.json();
		} catch {
			throw new Rejected('invalid JSON from server');
		}
	}

	#noteLocalChanges(): void {
		const record = this.#load();
		const board = this.#board();
		const tombstones = recordDeletions(
			record.tombstones,
			diffBoards(record.base, board),
			board,
			this.#now()
		);
		const changed =
			Object.keys(tombstones).length !== Object.keys(record.tombstones).length ||
			Object.entries(tombstones).some(([key, at]) => record.tombstones[key] !== at);
		if (changed) this.#save({ ...record, tombstones });
		this.#setStatus({ pending: outgoing({ ...record, tombstones }, board).length });
	}

	#board(): Board {
		return loadBoard(this.#storage);
	}

	#load(): SyncRecord {
		return parseRecord(readJson(SYNC_STORAGE_KEY, this.#storage));
	}

	#save(record: SyncRecord): void {
		writeJson(SYNC_STORAGE_KEY, record, this.#storage);
	}

	#schedule(ms: number): void {
		if (!this.#running) return;
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.syncNow();
		}, ms);
	}

	#clearTimer(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	#setStatus(patch: Partial<SyncStatus>): void {
		const next = { ...this.#status, ...patch };
		if (Object.entries(next).every(([k, v]) => this.#status[k as keyof SyncStatus] === v)) return;
		this.#status = next;
		for (const listener of this.#listeners) listener(next);
	}
}

interface Pushed {
	sent: WireItem[];
	stored: WireItem[];
}

function parseItems(body: unknown): WireItem[] {
	const items = (body as { items?: unknown } | null)?.items;
	if (!Array.isArray(items)) throw new Rejected('response without items');
	return items.map(fromWire).filter((item): item is WireItem => item !== null);
}
