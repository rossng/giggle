// Last-write-wins merging of boards, with tombstones. Pure functions over plain data.
//
// board.ts forgets an artist when it's unsorted, so a deletion leaves no trace there. The sync
// module keeps its own record instead: `diffBoards(base, current)` compares the board as last
// synced (`base`) with the board now, and each key that disappeared becomes a tombstone
// (key → when the deletion was noticed) until the server has acknowledged it.

import type { Board } from '$lib/board/board';
import { toBoardItem, type SyncItem } from './wire';

/** artistKey → its latest known change, deletions included. */
export type SyncMap = Readonly<Record<string, SyncItem>>;

/** artistKey → when it was unsorted here (ISO 8601), for deletions not yet on the server. */
export type Tombstones = Readonly<Record<string, string>>;

function time(item: SyncItem): number {
	return Date.parse(item.at);
}

/**
 * Whichever of two versions of one item wins: the later `at`; on a tie the remote copy,
 * because the server keeps its stored row on a tie and every device must agree.
 */
export function pick(
	local: SyncItem | undefined,
	remote: SyncItem | undefined
): SyncItem | undefined {
	if (!local) return remote;
	if (!remote) return local;
	return time(local) > time(remote) ? local : remote;
}

/** LWW merge of two maps, key by key. Neither input is changed. */
export function mergeBoards(local: SyncMap, remote: SyncMap): SyncMap {
	const out: Record<string, SyncItem> = { ...local };
	for (const [key, item] of Object.entries(remote)) {
		out[key] = pick(local[key], item)!;
	}
	return out;
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
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => sameItem(a[key], b[key]));
}

export interface BoardDiff {
	/** Keys added or changed since `base`. */
	changed: string[];
	/** Keys in `base` that are gone now (unsorted). */
	deleted: string[];
}

/** What changed locally since the board was last in step with the server. */
export function diffBoards(base: Board, current: Board): BoardDiff {
	const changed = Object.keys(current).filter((key) => !sameItem(base[key], current[key]));
	const deleted = Object.keys(base).filter((key) => !(key in current));
	return { changed, deleted };
}

/**
 * Tombstones after noticing the local deletions in `diff`: each newly deleted key is stamped
 * `now`; an existing tombstone keeps its original time; a key back on the board loses its
 * tombstone (the re-add is the newer change and is pushed as such).
 */
export function recordDeletions(
	tombstones: Tombstones,
	diff: BoardDiff,
	current: Board,
	now: Date
): Tombstones {
	const out: Record<string, string> = {};
	for (const [key, at] of Object.entries(tombstones)) {
		if (!(key in current)) out[key] = at;
	}
	for (const key of diff.deleted) out[key] ??= now.toISOString();
	return out;
}
