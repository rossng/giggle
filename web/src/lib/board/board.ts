// The listener's board. Two kinds of mark, in one map:
//   - an artist's, keyed by artist key ("mb:<mbid>" or "name:<normalised name>"): listen more or
//     not for me. Only the radio reads these: it plays them more often, or leaves them out.
//   - a gig's, keyed "gig:<venue>:<source_id>" (`gigKey`): want to go or got tickets, the
//     listener's plans. Each remembers the artist it was sorted for, and the gig's start.
// Kept in this browser's localStorage and synced as the `board` collection (lib/sync/).
//
// Plain JSON-serialisable data; the functions below return new objects and never mutate.

import { own } from '$lib/data/own';
import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';

/** Every state, in the order the buttons show them: the artist's pair, then the gig's. */
export const TRIAGES = ['listen', 'nope', 'go', 'tickets'] as const;
export type Triage = (typeof TRIAGES)[number];

/** An artist's states: how the radio treats them. */
export const ARTIST_TRIAGES = ['listen', 'nope'] as const;
export type ArtistTriage = (typeof ARTIST_TRIAGES)[number];

/** A gig's states: the listener's plans. */
export const GIG_TRIAGES = ['go', 'tickets'] as const;
export type GigTriage = (typeof GIG_TRIAGES)[number];

export const TRIAGE_LABELS: Readonly<Record<Triage, string>> = {
	listen: 'Listen more',
	go: 'Want to go',
	tickets: 'Got tickets',
	nope: 'Not for me'
};

/** One-word labels, for where the full ones don't fit (the player bar on narrower screens). */
export const TRIAGE_SHORT: Readonly<Record<Triage, string>> = {
	listen: 'Listen',
	go: 'Go',
	tickets: 'Tickets',
	nope: 'Nope'
};

/** The keyboard shortcut for each state on the radio. */
export const TRIAGE_KEYS: Readonly<Record<Triage, string>> = {
	listen: '1',
	go: '2',
	tickets: '3',
	nope: 'X'
};

/** States that say the listener likes the act. */
export const POSITIVE: readonly Triage[] = ['listen', 'go', 'tickets'];

export function isArtistTriage(state: Triage): state is ArtistTriage {
	return (ARTIST_TRIAGES as readonly Triage[]).includes(state);
}

export function isGigTriage(state: Triage): state is GigTriage {
	return (GIG_TRIAGES as readonly Triage[]).includes(state);
}

export interface BoardItem {
	state: Triage;
	/** The artist's name, so the board can list it without the data. */
	name: string;
	/** A gig's: the artist it was sorted for ("mb:<mbid>" or "name:<normalised name>"). */
	artist?: string;
	/** A gig's start, ISO 8601: past gigs drop out of the data, and the Board still needs to
	 * know a gig has happened. */
	when?: string;
	/** When it was sorted, ISO 8601. */
	at: string;
}

/** Artist key or gig key → how it's sorted. Unsorted ones are absent. */
export type Board = Readonly<Record<string, BoardItem>>;

export const BOARD_STORAGE_KEY = 'giggle:board:v1';

const GIG_PREFIX = 'gig:';

/** A gig's key on the board, from its id ("<venue>:<source_id>"). */
export function gigKey(gigId: string): string {
	return GIG_PREFIX + gigId;
}

export function isGigKey(key: string): boolean {
	return key.startsWith(GIG_PREFIX);
}

/** The gig id in a gig key. */
export function gigIdOf(key: string): string {
	return key.slice(GIG_PREFIX.length);
}

function isTriage(value: unknown): value is Triage {
	return (TRIAGES as readonly unknown[]).includes(value);
}

function isTime(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function later(a: BoardItem | undefined, b: BoardItem): BoardItem {
	return a && Date.parse(a.at) >= Date.parse(b.at) ? a : b;
}

/**
 * Reads a board back from storage (or from the sync, which may hand over items saved by an older
 * version), dropping anything malformed.
 *
 * Older versions gave an artist any of the four states, noting the gig it was sorted from
 * (`gig`). Want to go and got tickets on an artist become that gig's, for that artist. One
 * without a gig becomes listen more, a millisecond later than it was sorted, so the sync takes
 * it as a change. Deterministic, so every device reading the same data gets the same board.
 *
 * LEGACY-BOARD: that conversion (the last two branches below) stays while old-format items may
 * be anywhere: see CLAUDE.md for when it can go.
 */
export function parseBoard(value: unknown): Board {
	const items = (value as { items?: unknown } | null)?.items;
	if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
	const out: Record<string, BoardItem> = {};
	const keep = (key: string, item: BoardItem) => (out[key] = later(own(out, key), item));
	for (const [key, raw] of Object.entries(items as Record<string, unknown>)) {
		const item = raw as Partial<Record<keyof BoardItem | 'gig', unknown>> | null;
		if (!key || !item || !isTriage(item.state) || !isTime(item.at)) continue;
		const name = typeof item.name === 'string' ? item.name : key;
		const when = isTime(item.when) ? { when: item.when } : {};
		if (isGigKey(key)) {
			if (!isGigTriage(item.state)) continue;
			const artist = typeof item.artist === 'string' && item.artist ? { artist: item.artist } : {};
			keep(key, { state: item.state, name, ...artist, ...when, at: item.at });
		} else if (isArtistTriage(item.state)) {
			keep(key, { state: item.state, name, at: item.at });
		} else if (typeof item.gig === 'string' && item.gig) {
			// LEGACY-BOARD: a plan on an artist.
			keep(gigKey(item.gig), { state: item.state, name, artist: key, ...when, at: item.at });
		} else {
			// LEGACY-BOARD: a plan on an artist, without a gig.
			const at = new Date(Date.parse(item.at) + 1).toISOString();
			keep(key, { state: 'listen', name, at });
		}
	}
	return out;
}

/** What goes into storage. */
export function serialiseBoard(board: Board): { version: 1; items: Board } {
	return { version: 1, items: board };
}

/** How an artist is sorted (listen more, not for me), or null. */
export function artistState(board: Board, artistKey: string): ArtistTriage | null {
	const state = own(board, artistKey)?.state;
	return state && isArtistTriage(state) ? state : null;
}

/** How a gig is sorted (want to go, got tickets), or null. */
export function gigState(board: Board, gigId: string): GigTriage | null {
	const state = own(board, gigKey(gigId))?.state;
	return state && isGigTriage(state) ? state : null;
}

/** Sorts an artist into `state`, or unsorts them with null. */
export function setArtist(
	board: Board,
	artist: { key: string; name: string },
	state: ArtistTriage | null,
	now: Date
): Board {
	const { [artist.key]: _old, ...rest } = board;
	if (state === null) return rest;
	return { ...rest, [artist.key]: { state, name: artist.name, at: now.toISOString() } };
}

export interface GigMeta {
	/** The artist it's sorted for (no key: one whose key isn't known any more). */
	artist: { key: string | null; name: string };
	/** The gig's start (see BoardItem.when). */
	when?: string;
}

/** Sorts a gig into `state`, or unsorts it with null. */
export function setGig(
	board: Board,
	gigId: string,
	state: GigTriage | null,
	meta: GigMeta,
	now: Date
): Board {
	const key = gigKey(gigId);
	const { [key]: _old, ...rest } = board;
	if (state === null) return rest;
	return {
		...rest,
		[key]: {
			state,
			name: meta.artist.name,
			...(meta.artist.key ? { artist: meta.artist.key } : {}),
			...(meta.when ? { when: meta.when } : {}),
			at: now.toISOString()
		}
	};
}

/** Pressing the same state again unsorts; the other one replaces it. */
export function toggleArtist(
	board: Board,
	artist: { key: string; name: string },
	state: ArtistTriage,
	now: Date
): Board {
	return setArtist(board, artist, artistState(board, artist.key) === state ? null : state, now);
}

/** Pressing the same state again unsorts; the other one replaces it. */
export function toggleGig(
	board: Board,
	gigId: string,
	state: GigTriage,
	meta: GigMeta,
	now: Date
): Board {
	return setGig(board, gigId, gigState(board, gigId) === state ? null : state, meta, now);
}

/** Artists sorted into any of `states`, or with a gig sorted into one, sorted for them. */
export function artistsIn(board: Board, states: readonly Triage[]): Set<string> {
	const out = new Set<string>();
	for (const [key, item] of Object.entries(board)) {
		if (!states.includes(item.state)) continue;
		const artist = isGigKey(key) ? item.artist : key;
		if (artist) out.add(artist);
	}
	return out;
}

/** Names on items sorted into any of `states` (a name once, however many gigs it has). */
export function namesIn(board: Board, states: readonly Triage[]): string[] {
	return [
		...new Set(
			Object.values(board)
				.filter((item) => states.includes(item.state))
				.map((item) => item.name)
		)
	];
}

export function loadBoard(storage: KeyValueStorage | null = browserStorage()): Board {
	return parseBoard(readJson(BOARD_STORAGE_KEY, storage));
}

export function saveBoard(
	board: Board,
	storage: KeyValueStorage | null = browserStorage()
): boolean {
	return writeJson(BOARD_STORAGE_KEY, serialiseBoard(board), storage);
}
