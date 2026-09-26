// The listener's board: how they've sorted each artist. The radio writes it (keys 1/2/3/X);
// the Board page will read it. Kept in this browser's localStorage for now (the Worker/D1
// sync comes later), keyed by artist key ("mb:<mbid>" or "name:<normalised name>").
//
// Plain JSON-serialisable data; the functions below return new objects and never mutate.

import { browserStorage, readJson, writeJson, type KeyValueStorage } from '$lib/storage';

export const TRIAGES = ['listen', 'go', 'tickets', 'nope'] as const;
export type Triage = (typeof TRIAGES)[number];

export const TRIAGE_LABELS: Readonly<Record<Triage, string>> = {
	listen: 'Listen more',
	go: 'Want to go',
	tickets: 'Got tickets',
	nope: 'Not for me'
};

/** The keyboard shortcut for each state on the radio. */
export const TRIAGE_KEYS: Readonly<Record<Triage, string>> = {
	listen: '1',
	go: '2',
	tickets: '3',
	nope: 'X'
};

/** States that put an artist on the board (the listener likes them). */
export const POSITIVE: readonly Triage[] = ['listen', 'go', 'tickets'];

export interface BoardItem {
	state: Triage;
	/** The artist's name when sorted, so the board can list them without the data. */
	name: string;
	/** The gig they were sorted from, if any ("<venue>:<source_id>"). */
	gig?: string;
	/** That gig's start, ISO 8601: past gigs drop out of the data, and the Board still
	 * needs to know an artist's gig has happened. */
	when?: string;
	/** When, ISO 8601. */
	at: string;
}

/** artistKey → how it's sorted. Unsorted artists are absent. */
export type Board = Readonly<Record<string, BoardItem>>;

export const BOARD_STORAGE_KEY = 'giggle:board:v1';

function isTriage(value: unknown): value is Triage {
	return (TRIAGES as readonly unknown[]).includes(value);
}

/** Reads a board back from storage, dropping anything malformed. */
export function parseBoard(value: unknown): Board {
	const items = (value as { items?: unknown } | null)?.items;
	if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
	const out: Record<string, BoardItem> = {};
	for (const [key, raw] of Object.entries(items as Record<string, unknown>)) {
		const item = raw as Partial<BoardItem> | null;
		if (!key || !item || !isTriage(item.state)) continue;
		if (typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) continue;
		out[key] = {
			state: item.state,
			name: typeof item.name === 'string' ? item.name : key,
			...(typeof item.gig === 'string' ? { gig: item.gig } : {}),
			...(typeof item.when === 'string' && !Number.isNaN(Date.parse(item.when))
				? { when: item.when }
				: {}),
			at: item.at
		};
	}
	return out;
}

/** What goes into storage. */
export function serialiseBoard(board: Board): { version: 1; items: Board } {
	return { version: 1, items: board };
}

export interface TriageMeta {
	name: string;
	gig?: string;
	/** The gig's start (see BoardItem.when). */
	when?: string;
}

/** Sorts `artistKey` into `state`, or unsorts it with null. */
export function setTriage(
	board: Board,
	artistKey: string,
	state: Triage | null,
	meta: TriageMeta,
	now: Date
): Board {
	const { [artistKey]: _old, ...rest } = board;
	if (state === null) return rest;
	return {
		...rest,
		[artistKey]: {
			state,
			name: meta.name,
			...(meta.gig ? { gig: meta.gig } : {}),
			...(meta.when ? { when: meta.when } : {}),
			at: now.toISOString()
		}
	};
}

/** Pressing the same state again unsorts; another state replaces it. */
export function toggleTriage(
	board: Board,
	artistKey: string,
	state: Triage,
	meta: TriageMeta,
	now: Date
): Board {
	return setTriage(board, artistKey, board[artistKey]?.state === state ? null : state, meta, now);
}

export function triageOf(board: Board, artistKey: string): Triage | null {
	return board[artistKey]?.state ?? null;
}

/** Artist keys sorted into any of `states`. */
export function keysIn(board: Board, states: readonly Triage[]): Set<string> {
	return new Set(
		Object.entries(board)
			.filter(([, item]) => states.includes(item.state))
			.map(([key]) => key)
	);
}

/** Names of artists sorted into any of `states`. */
export function namesIn(board: Board, states: readonly Triage[]): string[] {
	return Object.values(board)
		.filter((item) => states.includes(item.state))
		.map((item) => item.name);
}

export function countByState(board: Board): Record<Triage, number> {
	const counts: Record<Triage, number> = { listen: 0, go: 0, tickets: 0, nope: 0 };
	for (const item of Object.values(board)) counts[item.state]++;
	return counts;
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
