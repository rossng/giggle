// Last-write-wins merging with tombstones. Pure functions over plain data: the generic ones work
// on any map of items that carry an `at`, and the board's are those, specialised.
//
// Local stores (board.ts, the unavailable dates) forget a key when it's removed, so a deletion
// leaves no trace there. The sync module keeps its own record instead: `diffMaps(base, current)`
// compares the data as last synced (`base`) with the data now, and each key that disappeared
// becomes a tombstone (key → when the deletion was noticed) until the server has acknowledged it.

import type { Board } from '$lib/board/board';
import { toBoardItem, type SyncItem } from './wire';

/** Anything with a change time (ISO 8601); last write wins by it. */
export interface Stamped {
	at: string;
}

/** key → when it was removed here (ISO 8601), for deletions not yet on the server. */
export type Tombstones = Readonly<Record<string, string>>;

function time(item: Stamped): number {
	return Date.parse(item.at);
}

/**
 * Whichever of two versions of one item wins: the later `at`; on a tie the remote copy,
 * because the server keeps its stored row on a tie and every device must agree.
 */
export function pick<L extends Stamped, R extends Stamped>(
	local: L | undefined,
	remote: R | undefined
): L | R | undefined {
	if (!local) return remote;
	if (!remote) return local;
	return time(local) > time(remote) ? local : remote;
}

/** LWW merge of two maps, key by key. Neither input is changed. */
export function mergeMaps<T extends Stamped>(
	local: Readonly<Record<string, T>>,
	remote: Readonly<Record<string, T>>
): Record<string, T> {
	const out: Record<string, T> = { ...local };
	for (const [key, item] of Object.entries(remote)) {
		out[key] = pick(local[key], item)!;
	}
	return out;
}

export interface MapDiff {
	/** Keys added or changed since `base`. */
	changed: string[];
	/** Keys in `base` that are gone now. */
	deleted: string[];
}

/** What changed locally since the data was last in step with the server. */
export function diffMaps<T>(
	base: Readonly<Record<string, T>>,
	current: Readonly<Record<string, T>>,
	same: (a: T | undefined, b: T | undefined) => boolean
): MapDiff {
	const changed = Object.keys(current).filter((key) => !same(base[key], current[key]));
	const deleted = Object.keys(base).filter((key) => !(key in current));
	return { changed, deleted };
}

/**
 * Tombstones after noticing the local deletions in `diff`: each newly deleted key is stamped
 * `now`; an existing tombstone keeps its original time; a key that's back loses its tombstone
 * (the re-add is the newer change and is pushed as such).
 */
export function recordDeletions(
	tombstones: Tombstones,
	diff: MapDiff,
	current: Readonly<Record<string, unknown>>,
	now: Date
): Tombstones {
	const out: Record<string, string> = {};
	for (const [key, at] of Object.entries(tombstones)) {
		if (!(key in current)) out[key] = at;
	}
	for (const key of diff.deleted) out[key] ??= now.toISOString();
	return out;
}

export function sameTombstones(a: Tombstones, b: Tombstones): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Same keys, and `same` items under each. */
export function sameMaps<T>(
	a: Readonly<Record<string, T>>,
	b: Readonly<Record<string, T>>,
	same: (a: T | undefined, b: T | undefined) => boolean
): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
}

// --- the board -------------------------------------------------------------------------------

/** artistKey → its latest known change, deletions included. */
export type SyncMap = Readonly<Record<string, SyncItem>>;

/** LWW merge of two boards (with tombstones), key by key. */
export function mergeBoards(local: SyncMap, remote: SyncMap): SyncMap {
	return mergeMaps(local, remote);
}

/** The board and its pending deletions as one map. A key on the board is not deleted. */
export function toSyncMap(board: Board, tombstones: Tombstones = {}): SyncMap {
	const out: Record<string, SyncItem> = {};
	for (const [key, at] of Object.entries(tombstones)) out[key] = { state: null, name: '', at };
	for (const [key, item] of Object.entries(board)) out[key] = { ...item };
	return out;
}

/** The board part of a map: every item that isn't a tombstone. */
export function boardOf(map: SyncMap): Board {
	const out: Record<string, ReturnType<typeof toBoardItem>> = {};
	for (const [key, item] of Object.entries(map)) {
		if (item.state !== null) out[key] = toBoardItem({ ...item, state: item.state });
	}
	return out;
}

export function sameItem(a: SyncItem | undefined, b: SyncItem | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.state === b.state &&
		(a.state === null || (a.name === b.name && (a.gig ?? '') === (b.gig ?? ''))) &&
		Date.parse(a.at) === Date.parse(b.at)
	);
}

export function sameBoard(a: Board, b: Board): boolean {
	return sameMaps(a, b, sameItem);
}

export type BoardDiff = MapDiff;

/** What changed on the board since it was last in step with the server. */
export function diffBoards(base: Board, current: Board): BoardDiff {
	return diffMaps<SyncItem>(base, current, sameItem);
}
