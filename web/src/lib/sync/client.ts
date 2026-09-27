// Keeps this browser's personal data in step with the accounts API (worker/, `/api/*`): the
// board, and whatever other collections it's given (collection.ts, collections.ts).
//
// Local-first: each collection's data in localStorage is always the source for the UI; the
// SyncClient pushes local changes and pulls remote ones in the background, merging last write
// wins per key. It runs a round on start, shortly after `notifyLocalChange()` (debounced), when
// the window regains focus or the network comes back, and every few minutes; failures back off.
// A round checks who is signed in, then pushes and pulls each collection in turn.
//
// Each collection keeps its own record (`recordKey`): the pull cursor, the items as last in step
// with the server (`base`, to find local changes and deletions by diffing), pending tombstones.
//
// Integration: call `notifyLocalChange()` after every local save, and adopt the data passed to
// `onChange` (it has already been saved) — don't write back an older in-memory copy over it.

import type { Board } from '$lib/board/board';
import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';
import {
	applyRound,
	emptyRecord,
	noteDeletions,
	outgoing,
	packRecord,
	parseRecord,
	type Collection,
	type Outgoing,
	type SyncRecord
} from './collection';
import { boardCollection, SYNC_STORAGE_KEY } from './collections';
import { sameTombstones, type Stamped } from './merge';

export { SYNC_STORAGE_KEY };

export type SyncState = 'synced' | 'syncing' | 'offline' | 'signed-out' | 'error';

export interface SyncStatus {
	state: SyncState;
	/** The signed-in email, once known. */
	user: string | null;
	/** When the last round finished cleanly (ISO 8601). */
	lastSyncedAt: string | null;
	/** Local changes not yet on the server, all collections together. */
	pending: number;
	/** Why the last round failed, for a tooltip. */
	error: string | null;
}

/** Collections of different item types, driven the same way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCollection = Collection<any, any>;

class SignedOut extends Error {}
class Offline extends Error {}
class Rejected extends Error {}

type Listener = (event?: { key?: string | null }) => void;

export interface SyncEvents {
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
}

export interface SyncClientOptions {
	/** What to sync, in this order each round (default: just the board). */
	collections?: readonly AnyCollection[];
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
	/** Called with a collection's merged data whenever a sync changed it (it's already saved). */
	onChange?: (collection: string, data: unknown) => void;
	/** Called with the merged board whenever a sync changed it (it's already saved). */
	onBoard?: (board: Board) => void;
}

export class SyncClient {
	readonly #collections: readonly AnyCollection[];
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
	readonly #onChange?: (collection: string, data: unknown) => void;
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
		this.#collections = options.collections ?? [boardCollection];
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
		this.#onChange = options.onChange;
		this.#onBoard = options.onBoard;
		const records = this.#collections.map((c) => this.#load(c));
		this.#status = {
			state: 'offline',
			user: records[0]?.user ?? null,
			lastSyncedAt: latest(records.map((r) => r.lastSyncedAt)),
			pending: this.#pending(),
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
		// Another tab saved some of the data.
		const dataKeys = new Set(this.#collections.map((c) => c.dataKey));
		const storage: Listener = (event) => {
			if (!event?.key || dataKeys.has(event.key)) this.notifyLocalChange();
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

	/** Some data was just saved locally: note deletions now, push after a short pause. */
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
			for (const collection of this.#collections) await this.#syncCollection(collection);
			this.#failures = 0;
			const records = this.#collections.map((c) => this.#load(c));
			const pending = this.#pending();
			this.#setStatus({
				state: 'synced',
				lastSyncedAt: latest(records.map((r) => r.lastSyncedAt)),
				pending,
				error: null
			});
			// Anything still pending changed during the round: push it after the usual pause.
			this.#schedule(pending ? this.#debounceMs : this.#pollMs);
		} catch (e) {
			this.#fail(e);
		}
	}

	async #syncCollection<T extends Stamped>(collection: Collection<T>): Promise<void> {
		const pushed = await this.#push(collection);
		const pulled = await this.#pull(collection);
		const now = this.#now();
		const result = applyRound(collection, {
			record: this.#load(collection),
			local: collection.load(this.#storage, now),
			sent: pushed.sent,
			stored: pushed.stored,
			pulled: pulled.items,
			cursor: pulled.cursor,
			now
		});
		if (result.items) {
			const data = collection.save(result.items, this.#storage, now);
			this.#onChange?.(collection.name, data);
			if (collection.name === boardCollection.name) this.#onBoard?.(data as Board);
		}
		this.#save(collection, result.record);
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
		for (const collection of this.#collections) {
			// Another account's cursor and base mean nothing here: pull everything, push it all.
			if (this.#load(collection).user !== me.email) {
				this.#save(collection, emptyRecord(me.email));
			}
		}
		this.#checkedUser = true;
		this.#setStatus({ user: me.email });
	}

	async #push<T extends Stamped>(
		collection: Collection<T>
	): Promise<{ sent: Outgoing<T>[]; stored: Outgoing<T>[] }> {
		this.#noteLocalChanges();
		const now = this.#now();
		const local = collection.load(this.#storage, now);
		const items = outgoing(collection, this.#load(collection), local, now);
		const stored: Outgoing<T>[] = [];
		for (let i = 0; i < items.length; i += collection.batch) {
			const batch = items.slice(i, i + collection.batch);
			const body = await this.#request('PUT', `/api/${collection.name}`, {
				items: batch.map(({ key, item }) => collection.toWire(key, item))
			});
			stored.push(...parseItems(collection, body));
		}
		return { sent: items, stored };
	}

	async #pull<T extends Stamped>(
		collection: Collection<T>
	): Promise<{ items: Outgoing<T>[]; cursor: string | null }> {
		let cursor = this.#load(collection).cursor;
		const items: Outgoing<T>[] = [];
		for (let page = 0; page < 1000; page++) {
			const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
			const body = (await this.#request('GET', `/api/${collection.name}${query}`)) as {
				cursor?: unknown;
				more?: unknown;
			};
			items.push(...parseItems(collection, body));
			if (typeof body.cursor !== 'string') throw new Rejected('response without a cursor');
			cursor = body.cursor;
			if (body.more !== true) break;
		}
		return { items, cursor };
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

	/** Records deletions noticed since the last look, and updates the pending count. */
	#noteLocalChanges(): void {
		const now = this.#now();
		for (const collection of this.#collections) {
			if (!collection.deletions) continue;
			const record = this.#load(collection);
			const local = collection.load(this.#storage, now);
			const tombstones = noteDeletions(collection, record, local, now);
			if (!sameTombstones(tombstones, record.tombstones)) {
				this.#save(collection, { ...record, tombstones });
			}
		}
		this.#setStatus({ pending: this.#pending() });
	}

	/** Local changes not yet on the server, over all collections. */
	#pending(): number {
		const now = this.#now();
		let n = 0;
		for (const collection of this.#collections) {
			const record = this.#load(collection);
			const local = collection.load(this.#storage, now);
			const tombstones = noteDeletions(collection, record, local, now);
			n += outgoing(collection, { ...record, tombstones }, local, now).length;
		}
		return n;
	}

	#load<T extends Stamped>(collection: Collection<T>): SyncRecord<T> {
		return parseRecord(collection, readJson(collection.recordKey, this.#storage));
	}

	#save<T extends Stamped>(collection: Collection<T>, record: SyncRecord<T>): void {
		writeJson(collection.recordKey, packRecord(collection, record), this.#storage);
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

function parseItems<T extends Stamped>(collection: Collection<T>, body: unknown): Outgoing<T>[] {
	const items = (body as { items?: unknown } | null)?.items;
	if (!Array.isArray(items)) throw new Rejected('response without items');
	return items
		.map((raw) => collection.fromWire(raw))
		.filter((item): item is Outgoing<T> => item !== null);
}

/** The latest of some ISO times. */
function latest(times: (string | null)[]): string | null {
	return times.reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
}
