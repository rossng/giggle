// A synced collection: one kind of personal data (the board, unavailable dates, play history)
// kept in this browser and in step with the Worker's `/api/<name>`. Every collection syncs the
// same way; a `Collection` only says how its items look locally and on the wire.
//
// The data model is a map of items by key, each with a change time `at`: last write wins per
// key, a deletion is a tombstone (a deleted item with its time), and the server hands out a
// per-collection `since` cursor. Locally each collection keeps a record next to its data
// (`recordKey`): the pull cursor, `base` (the items as last known to match the server, so local
// changes and deletions are found by diffing) and pending tombstones.
//
// The functions here are pure: the SyncClient (client.ts) does the fetching and storing.

import type { KeyValueStorage } from '$lib/storage';
import {
	diffMaps,
	mergeMaps,
	recordDeletions,
	sameMaps,
	type Stamped,
	type Tombstones
} from './merge';

/** An item as it travels over the wire: a key and the collection's fields. */
export interface WireObject {
	key: string;
}

export interface Collection<T extends Stamped = Stamped, Data = unknown> {
	/** `/api/<name>`, and the name the app's change events use. */
	readonly name: string;
	/** Where the local data is stored: another tab saving it is a local change. */
	readonly dataKey: string;
	/** Where this collection's sync record is stored. */
	readonly recordKey: string;
	/** Items per PUT (the server allows 400, and the body must stay under 256 KB too). */
	readonly batch: number;
	/**
	 * Whether a key that disappears locally is a deletion to sync (board, unavailable dates) or
	 * just local housekeeping, like old plays being pruned (plays).
	 */
	readonly deletions: boolean;
	/**
	 * Items never change once made (plays): once a PUT succeeds each item in it is done with,
	 * even if the server chose not to keep it.
	 */
	readonly immutable: boolean;

	/** The local data as items by key (no tombstones). */
	load(storage: KeyValueStorage | null, now: Date): Record<string, T>;
	/** Stores merged items as the local data; returns the data as stored, for the app. */
	save(items: Readonly<Record<string, T>>, storage: KeyValueStorage | null, now: Date): Data;
	/** `base` in the sync record: packed for storage, and read back (dropping junk). */
	packBase(items: Readonly<Record<string, T>>): unknown;
	parseBase(value: unknown): Record<string, T>;

	tombstone(at: string): T;
	isTombstone(item: T): boolean;
	/** Same content and same change time. */
	same(a: T | undefined, b: T | undefined): boolean;
	/** Would the server accept this item? Others stay on this device only. */
	isSyncable(key: string, item: T, now: Date): boolean;
	toWire(key: string, item: T): WireObject;
	/** One item from a server response, or null if it's malformed. */
	fromWire(raw: unknown): { key: string; item: T } | null;
}

/** What the sync module keeps in storage for one collection. */
export interface SyncRecord<T> {
	version: 1;
	user: string | null;
	/** From the last pull; null pulls everything. */
	cursor: string | null;
	/** The items as last known to match the server. */
	base: Record<string, T>;
	tombstones: Tombstones;
	lastSyncedAt: string | null;
}

export function emptyRecord<T>(user: string | null = null): SyncRecord<T> {
	return { version: 1, user, cursor: null, base: {}, tombstones: {}, lastSyncedAt: null };
}

export function parseRecord<T extends Stamped>(
	collection: Collection<T>,
	value: unknown
): SyncRecord<T> {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<SyncRecord<unknown>>;
	const tombstones: Record<string, string> = {};
	if (collection.deletions && v.tombstones && typeof v.tombstones === 'object') {
		for (const [key, at] of Object.entries(v.tombstones)) {
			if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) tombstones[key] = at;
		}
	}
	return {
		version: 1,
		user: typeof v.user === 'string' ? v.user : null,
		cursor: typeof v.cursor === 'string' && /^\d+$/.test(v.cursor) ? v.cursor : null,
		base: collection.parseBase(v.base),
		tombstones,
		lastSyncedAt: typeof v.lastSyncedAt === 'string' ? v.lastSyncedAt : null
	};
}

export function packRecord<T extends Stamped>(
	collection: Collection<T>,
	record: SyncRecord<T>
): unknown {
	return { ...record, base: collection.packBase(record.base) };
}

/** Tombstones after noticing local deletions (none for collections without deletions). */
export function noteDeletions<T extends Stamped>(
	collection: Collection<T>,
	record: SyncRecord<T>,
	local: Readonly<Record<string, T>>,
	now: Date
): Tombstones {
	if (!collection.deletions) return {};
	const diff = diffMaps(record.base, local, (a, b) => collection.same(a, b));
	return recordDeletions(record.tombstones, diff, local, now);
}

export interface Outgoing<T> {
	key: string;
	item: T;
}

/** Local changes waiting to be pushed: changed items plus pending deletions. */
export function outgoing<T extends Stamped>(
	collection: Collection<T>,
	record: SyncRecord<T>,
	local: Readonly<Record<string, T>>,
	now: Date
): Outgoing<T>[] {
	const { changed } = diffMaps(record.base, local, (a, b) => collection.same(a, b));
	const items: Outgoing<T>[] = changed.map((key) => ({ key, item: local[key]! }));
	for (const [key, at] of Object.entries(record.tombstones)) {
		items.push({ key, item: collection.tombstone(at) });
	}
	return items.filter(({ key, item }) => collection.isSyncable(key, item, now));
}

export interface RoundResult<T> {
	record: SyncRecord<T>;
	/** The merged local items, or null if they're unchanged (nothing to save). */
	items: Record<string, T> | null;
}

/**
 * Merges a round's server rows into the local items as they are *now* (they may have changed
 * during the round). `sent` is what was pushed, `stored` the server's answers to the pushes,
 * `pulled` the changes pulled after them.
 */
export function applyRound<T extends Stamped>(
	collection: Collection<T>,
	input: {
		record: SyncRecord<T>;
		local: Readonly<Record<string, T>>;
		sent: readonly Outgoing<T>[];
		stored: readonly Outgoing<T>[];
		pulled: readonly Outgoing<T>[];
		cursor: string | null;
		now: Date;
	}
): RoundResult<T> {
	const { record, local, now } = input;
	const tombstones = noteDeletions(collection, record, local, now);

	// Server rows, the pull (later) over the push responses.
	const remote: Record<string, T> = {};
	for (const { key, item } of [...input.stored, ...input.pulled]) remote[key] = item;

	// Local items and pending deletions as one map (a key that's back isn't deleted).
	const mine: Record<string, T> = {};
	for (const [key, at] of Object.entries(tombstones)) mine[key] = collection.tombstone(at);
	Object.assign(mine, local);

	// For what we pushed and haven't changed since, the server's answer is final even if it
	// looks older (it clamps timestamps from clocks running ahead).
	for (const { key, item } of input.sent) {
		if (remote[key] && collection.same(mine[key], item)) delete mine[key];
	}

	const merged = mergeMaps(mine, remote);
	const items: Record<string, T> = {};
	for (const [key, item] of Object.entries(merged)) {
		if (!collection.isTombstone(item)) items[key] = item;
	}

	// A deletion stays pending until the server holds it (or something newer).
	const pending: Record<string, string> = {};
	for (const [key, at] of Object.entries(tombstones)) {
		const server = remote[key];
		const acked = server && Date.parse(server.at) >= Date.parse(at);
		if (!acked && merged[key] && collection.isTombstone(merged[key])) pending[key] = at;
	}

	// The base now matches the server for every row it sent.
	const base: Record<string, T> = { ...record.base };
	for (const [key, item] of Object.entries(remote)) {
		if (collection.isTombstone(item)) delete base[key];
		else base[key] = item;
	}
	if (collection.immutable) {
		for (const { key, item } of input.sent) {
			if (!remote[key] && collection.same(local[key], item)) base[key] = item;
		}
	}
	if (!collection.deletions) {
		// Keys only the server has (pruned here) will never be pushed: forget them.
		for (const key of Object.keys(base)) if (!(key in items)) delete base[key];
	}

	const same = sameMaps(local, items, (a, b) => collection.same(a, b));
	return {
		record: {
			...record,
			cursor: input.cursor,
			base,
			tombstones: pending,
			lastSyncedAt: now.toISOString()
		},
		items: same ? null : items
	};
}
