// The collections the app syncs (see collection.ts), each matching one in
// worker/src/collections.ts: keep the wire rules of the two in step.

import {
	HISTORY_MAX_AGE_DAYS,
	parseHistory,
	pruneHistory,
	type PlayHistory
} from '@giggle/radio-core';
import {
	BOARD_STORAGE_KEY,
	loadBoard,
	parseBoard,
	saveBoard,
	type Board,
	type BoardItem
} from '$lib/board/board';
import {
	MAX_LABEL,
	parseRuleKey,
	parseUnavailable,
	saveUnavailable,
	UNAVAILABLE_STORAGE_KEY,
	loadUnavailable,
	type Unavailable
} from '$lib/data/unavailable';
import { KEYS as RADIO_KEYS, loadHistory, saveHistory } from '$lib/radio/persist';
import type { Collection } from './collection';
import { boardOf, sameItem } from './merge';
import {
	fromWire as boardFromWire,
	isArtistKey,
	isSyncable as boardSyncable,
	LIMITS,
	toWire as boardToWire,
	type SyncItem
} from './wire';

const EPOCH = Date.parse('2024-01-01T00:00:00Z');
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;
const DAY_MS = 86_400_000;

function iso(at: string): string {
	return new Date(Date.parse(at)).toISOString();
}

function sameTime(a: string, b: string): boolean {
	return Date.parse(a) === Date.parse(b);
}

function validTime(at: unknown): at is string {
	return typeof at === 'string' && !Number.isNaN(Date.parse(at));
}

// --- the board -------------------------------------------------------------------------------

/** Its record keeps the key it had before other collections synced. */
export const SYNC_STORAGE_KEY = 'giggle:sync:v1';

export const boardCollection: Collection<SyncItem, Board> = {
	name: 'board',
	dataKey: BOARD_STORAGE_KEY,
	recordKey: SYNC_STORAGE_KEY,
	batch: LIMITS.batch,
	deletions: true,
	immutable: false,
	load: (storage) => loadBoard(storage),
	save(items, storage) {
		// `when` (a sorted gig's date) isn't synced: keep this device's while the gig is the same.
		const current = loadBoard(storage);
		const next: Record<string, BoardItem> = {};
		for (const [key, item] of Object.entries(boardOf(items))) {
			const when = current[key]?.gig === item.gig ? current[key]?.when : undefined;
			next[key] = when ? { ...item, when } : item;
		}
		saveBoard(next, storage);
		return next;
	},
	packBase: (items) => items,
	parseBase: (value) => parseBoard({ items: value }),
	tombstone: (at) => ({ state: null, name: '', at }),
	isTombstone: (item) => item.state === null,
	same: sameItem,
	isSyncable: (key, item) => boardSyncable(key, item),
	toWire: (key, item) => boardToWire(key, item),
	fromWire(raw) {
		const wire = boardFromWire(raw);
		if (!wire) return null;
		const { key, ...item } = wire;
		return { key, item };
	}
};

// --- unavailable dates -----------------------------------------------------------------------

/** A rule, or its deletion. */
export interface UnavailableSyncItem {
	label?: string;
	deleted?: true;
	at: string;
}

function toUnavailable(items: Readonly<Record<string, UnavailableSyncItem>>): Unavailable {
	return parseUnavailable({ items });
}

export const unavailableCollection: Collection<UnavailableSyncItem, Unavailable> = {
	name: 'unavailable',
	dataKey: UNAVAILABLE_STORAGE_KEY,
	recordKey: 'giggle:sync:unavailable:v1',
	batch: 200,
	deletions: true,
	immutable: false,
	load: (storage) => loadUnavailable(storage),
	save(items, storage) {
		const next = toUnavailable(items);
		saveUnavailable(next, storage);
		return next;
	},
	packBase: (items) => items,
	parseBase: (value) => toUnavailable(value as Record<string, UnavailableSyncItem>),
	tombstone: (at) => ({ deleted: true, at }),
	isTombstone: (item) => item.deleted === true,
	same(a, b) {
		if (!a || !b) return a === b;
		return (
			!!a.deleted === !!b.deleted &&
			(a.deleted || (a.label ?? '') === (b.label ?? '')) &&
			sameTime(a.at, b.at)
		);
	},
	isSyncable(key, item) {
		if (!parseRuleKey(key) || !(Date.parse(item.at) >= EPOCH)) return false;
		const label = item.label ?? '';
		return item.deleted === true || (label.length <= MAX_LABEL && NO_CONTROL.test(label));
	},
	toWire(key, item) {
		if (item.deleted) return { key, deleted: true, at: iso(item.at) };
		return { key, ...(item.label ? { label: item.label } : {}), at: iso(item.at) };
	},
	fromWire(raw) {
		const w = raw as Record<string, unknown> | null;
		if (!w || typeof w !== 'object' || typeof w.key !== 'string' || !validTime(w.at)) return null;
		if (w.deleted === true) return { key: w.key, item: { deleted: true, at: w.at } };
		const label = typeof w.label === 'string' && w.label ? w.label : undefined;
		return { key: w.key, item: { ...(label ? { label } : {}), at: w.at } };
	}
};

// --- play history ----------------------------------------------------------------------------

// A play's key here is "<epoch ms> <artist key>" (the server's is its ISO time and the artist
// key; on the wire it's {key: artist key, at: time}). The item is just its time.

export interface PlaySyncItem {
	at: string;
}

export function playKey(artistKey: string, ms: number): string {
	return `${ms} ${artistKey}`;
}

export function splitPlayKey(key: string): { artistKey: string; ms: number } | null {
	const space = key.indexOf(' ');
	const ms = Number(key.slice(0, space));
	return space > 0 && Number.isFinite(ms) ? { artistKey: key.slice(space + 1), ms } : null;
}

export function historyToPlays(history: PlayHistory): Record<string, PlaySyncItem> {
	const out: Record<string, PlaySyncItem> = {};
	for (const [artistKey, plays] of Object.entries(history)) {
		for (const ms of plays) out[playKey(artistKey, ms)] = { at: new Date(ms).toISOString() };
	}
	return out;
}

export function playsToHistory(plays: Readonly<Record<string, PlaySyncItem>>): PlayHistory {
	const out: Record<string, number[]> = {};
	for (const key of Object.keys(plays)) {
		const play = splitPlayKey(key);
		if (play) (out[play.artistKey] ??= []).push(play.ms);
	}
	return parseHistory(out); // sorts
}

/** Plays this close to the server's 60-day cut-off aren't sent (it might just have dropped them). */
const PUSH_MAX_AGE_DAYS = HISTORY_MAX_AGE_DAYS - 1;

export const playsCollection: Collection<PlaySyncItem, PlayHistory> = {
	name: 'plays',
	dataKey: RADIO_KEYS.history,
	recordKey: 'giggle:sync:plays:v1',
	batch: 400,
	deletions: false,
	immutable: true,
	load: (storage, now) => historyToPlays(loadHistory(now, storage)),
	save(items, storage, now) {
		// The union of both sides' plays, pruned like the radio prunes its own.
		const history = pruneHistory(playsToHistory(items), now);
		saveHistory(history, storage);
		return history;
	},
	// Packed like the history itself, which is much smaller than one entry per play.
	packBase: (items) => playsToHistory(items),
	parseBase: (value) => historyToPlays(parseHistory(value)),
	tombstone: (at) => ({ at }),
	isTombstone: () => false,
	same: (a, b) => (!a || !b ? a === b : sameTime(a.at, b.at)),
	isSyncable(key, _item, now) {
		const play = splitPlayKey(key);
		return (
			!!play &&
			isArtistKey(play.artistKey) &&
			play.ms >= now.getTime() - PUSH_MAX_AGE_DAYS * DAY_MS &&
			play.ms >= EPOCH
		);
	},
	toWire(key, item) {
		const play = splitPlayKey(key)!;
		return { key: play.artistKey, at: iso(item.at) };
	},
	fromWire(raw) {
		const w = raw as Record<string, unknown> | null;
		if (!w || typeof w !== 'object' || typeof w.key !== 'string' || !w.key) return null;
		if (!validTime(w.at)) return null;
		const ms = Date.parse(w.at);
		return { key: playKey(w.key, ms), item: { at: new Date(ms).toISOString() } };
	}
};

/** Everything the app syncs, in the order a round goes through them. */
export const ALL_COLLECTIONS = [boardCollection, unavailableCollection, playsCollection] as const;
