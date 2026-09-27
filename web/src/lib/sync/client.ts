// Keeps this browser's personal data in step with the accounts API (worker/, `/api/*`): the
// collections it's given (collection.ts, collections.ts).
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
//
// Whose data is on this device: each record remembers the account it last synced with. Signing
// out (`forget()`) empties this device's personal data. Data belonging to another account than
// the one signed in is dropped, and so is data made while signed out, unless this device has
// just created the account (`prepareSignIn('new-account')`): then the new account adopts it.
// Signing in to an existing account shows that account's data, not whatever was here.

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
import { SYNC_STORAGE_KEY } from './collections';
import { sameTombstones, type Stamped } from './merge';

export { SYNC_STORAGE_KEY };

export type SyncState = 'synced' | 'syncing' | 'offline' | 'signed-out' | 'error';

export interface SyncStatus {
	state: SyncState;
	/** The signed-in account (an id, or the dev identity's email), once known. */
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
/** The device signed out (or changed account) while a round was running. */
class Abandoned extends Error {}

/** Set just before creating an account: data made while signed out becomes its own. */
export const ADOPT_STORAGE_KEY = 'giggle:sync:adopt:v1';
/** How long that lasts: a passkey dialog, not a day. */
const ADOPT_MS = 10 * 60_000;

type Listener = (event?: { key?: string | null }) => void;

export interface SyncEvents {
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
}

export interface SyncClientOptions {
	/** What to sync, in this order each round. */
	collections: readonly AnyCollection[];
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
	/** Other storage keys holding personal data (not synced), removed with it on sign-out. */
	personalKeys?: readonly string[];
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
	readonly #personalKeys: readonly string[];

	#status: SyncStatus;
	/** Bumped when the device signs out: a round from before must not save anything. */
	#generation = 0;
	#listeners = new Set<(status: SyncStatus) => void>();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	#inFlight: Promise<void> | null = null;
	#again = false;
	#failures = 0;
	#checkedUser = false;
	#detach: (() => void) | null = null;

	constructor(options: SyncClientOptions) {
		this.#collections = options.collections;
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
		this.#personalKeys = options.personalKeys ?? [];
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

	/**
	 * Call just before a passkey sign-in: a new account adopts the data made on this device while
	 * signed out; signing in to an existing account replaces it with that account's.
	 */
	prepareSignIn(kind: 'new-account' | 'existing-account'): void {
		if (kind === 'new-account')
			writeJson(ADOPT_STORAGE_KEY, this.#now().toISOString(), this.#storage);
		else this.#removeKey(ADOPT_STORAGE_KEY);
	}

	/** Someone signed in (or the account changed): find out who, and sync with them now. */
	signedIn(): Promise<void> {
		this.#checkedUser = false;
		return this.syncNow();
	}

	/**
	 * Signed out: this device's personal data goes (the account keeps its copy), and so does the
	 * sync state. Tells the app (`onChange`) that each collection is empty now.
	 */
	forget(): void {
		this.#generation += 1;
		this.#checkedUser = false;
		this.#clearTimer();
		for (const collection of this.#collections) {
			this.#clearLocal(collection);
			this.#save(collection, emptyRecord(null));
		}
		for (const key of [...this.#personalKeys, ADOPT_STORAGE_KEY]) this.#removeKey(key);
		this.#setStatus({
			state: 'signed-out',
			user: null,
			lastSyncedAt: null,
			pending: 0,
			error: null
		});
	}

	// --- one round -------------------------------------------------------------------------

	async #round(): Promise<void> {
		if (!this.#isOnline()) {
			this.#setStatus({ state: 'offline', error: null });
			return; // the 'online' event starts the next round
		}
		const generation = this.#generation;
		this.#setStatus({ state: 'syncing' });
		try {
			await this.#checkUser(generation);
			for (const collection of this.#collections) {
				await this.#syncCollection(collection, generation);
			}
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

	async #syncCollection<T extends Stamped>(
		collection: Collection<T>,
		generation: number
	): Promise<void> {
		const pushed = await this.#push(collection);
		const pulled = await this.#pull(collection);
		if (generation !== this.#generation) throw new Abandoned();
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
		}
		this.#save(collection, result.record);
	}

	#fail(e: unknown): void {
		if (e instanceof Abandoned) return; // forget() has set the status
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

	/**
	 * Once per start (and after signing in again): who is this? Data that isn't theirs goes, and
	 * their own is pulled in full; data made while signed out stays only for a brand-new account.
	 */
	async #checkUser(generation: number): Promise<void> {
		if (this.#checkedUser) return;
		const me = (await this.#request('GET', '/api/me')) as { user?: unknown };
		if (typeof me.user !== 'string') throw new Rejected('unexpected /api/me response');
		if (generation !== this.#generation) throw new Abandoned();
		const adopt = this.#adopting();
		let dropped = false;
		for (const collection of this.#collections) {
			const { user } = this.#load(collection);
			if (user === me.user) continue;
			// Another account's cursor and base mean nothing here: pull everything.
			if (user !== null || !adopt) {
				this.#clearLocal(collection);
				dropped = true;
			}
			this.#save(collection, emptyRecord(me.user));
		}
		if (dropped) for (const key of this.#personalKeys) this.#removeKey(key);
		this.#removeKey(ADOPT_STORAGE_KEY);
		this.#checkedUser = true;
		this.#setStatus({ user: me.user, pending: this.#pending() });
	}

	/** Whether this device has just created the account (prepareSignIn('new-account')). */
	#adopting(): boolean {
		const at = readJson(ADOPT_STORAGE_KEY, this.#storage);
		const ms = typeof at === 'string' ? Date.parse(at) : NaN;
		const now = this.#now().getTime();
		return ms <= now && now - ms < ADOPT_MS;
	}

	/** Empties a collection's local data and tells the app. */
	#clearLocal<T extends Stamped>(collection: Collection<T>): void {
		const data = collection.save({}, this.#storage, this.#now());
		this.#onChange?.(collection.name, data);
	}

	#removeKey(key: string): void {
		try {
			this.#storage?.removeItem(key);
		} catch {
			// Blocked storage: nothing was kept anyway.
		}
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
		// Not signed in (or the session expired): a redirect would be a login page.
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
