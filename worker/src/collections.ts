// The kinds of personal data the API syncs. Each is a collection of keyed items stored the same
// way (store.ts: last write wins per key, tombstones, `since` cursors); what differs is what an
// item looks like on the wire, how many a user may keep, and whether old ones are forgotten.
//
//   board        An artist's: {key: artist key, state: listen | nope, name, at}. A gig's:
//                {key: "gig:<venue>:<source_id>", state: go | tickets, name, artist?, when?,
//                at}: `artist` is the artist key it was sorted for, `when` the gig's start.
//                state null is a deletion. Older web clients sorted artists into any state,
//                with the gig they were sorted from ({key: artist key, state, name, gig?, at}):
//                still accepted (a tab may run one for days), and the web app moves those
//                onto the gig. LEGACY-BOARD: see CLAUDE.md for when to stop accepting them.
//   unavailable  {key: "2026-10-03" | "2026-10-01/2026-10-07" | "weekly:mon", label?, at}, or
//                {key, deleted: true, at}. Amsterdam dates; a range includes both ends.
//   plays        {key: artist key, at: when it was heard}. One item per play, never changed or
//                deleted: two devices' histories are simply merged. Plays older than 60 days
//                are forgotten, and at most 10 000 kept.

import {
	fields,
	isArtistKey,
	isGigKey,
	LIMITS,
	MAX_CLOCK_AHEAD_MS,
	parseAt,
	parseTime,
	text,
	ValidationError
} from './validate';

export const COLLECTION_NAMES = ['board', 'unavailable', 'plays'] as const;
export type CollectionName = (typeof COLLECTION_NAMES)[number];

/** An item ready to store. `data` null is a tombstone. */
export interface Parsed {
	key: string;
	data: Record<string, unknown> | null;
	/** Normalised ISO 8601 (Date#toISOString), so that comparing strings compares times. */
	at: string;
}

/** A stored row. */
export interface Row {
	key: string;
	/** JSON, or null for a tombstone. */
	data: string | null;
	at: string;
	seq: number;
}

export interface Collection {
	name: CollectionName;
	/** Rows (tombstones included) one user may keep. */
	maxRows: number;
	/** Past `maxRows`: refuse the write (413), or forget the oldest rows. */
	overflow: 'reject' | 'forget-oldest';
	/** The 413 message when `overflow` is 'reject'. */
	fullMessage: string;
	/** Rows whose `at` is older than this are forgotten (and not served). */
	maxAgeDays?: number;
	/** One item from a PUT, or null if it's valid but not worth storing. Throws ValidationError. */
	parseItem(raw: unknown, now: number): Parsed | null;
	toWire(row: Row): Record<string, unknown>;
}

function data(row: Row): Record<string, unknown> {
	return row.data === null ? {} : (JSON.parse(row.data) as Record<string, unknown>);
}

// --- board -----------------------------------------------------------------------------------

export const STATES = ['listen', 'go', 'tickets', 'nope'] as const;
export type State = (typeof STATES)[number];
/** A gig's states; an artist's are the others (and, from older clients, any: LEGACY-BOARD). */
const GIG_STATES: readonly State[] = ['go', 'tickets'];

/** One board entry as it travels over the wire. `state: null` is a deletion (tombstone). */
export type BoardItem = {
	key: string;
	state: State | null;
	name: string;
	/** A gig's: the artist it was sorted for. */
	artist?: string;
	/** A gig's start, ISO 8601. */
	when?: string;
	/** LEGACY-BOARD: older clients' artists: the gig they were sorted from. */
	gig?: string;
	/** ISO 8601 UTC with milliseconds (Date#toISOString). */
	at: string;
};

const BOARD_FIELDS = new Set(['key', 'state', 'name', 'artist', 'when', 'gig', 'at']);

/** A gig's start, as sent (it keeps its offset), or throws. */
function parseWhen(value: unknown): string {
	try {
		parseTime(value);
	} catch {
		throw new ValidationError('when must be an ISO 8601 timestamp');
	}
	return value as string;
}

export function parseBoardItem(raw: unknown, now: number): Parsed {
	const item = fields(raw, BOARD_FIELDS);
	const key = item.key;
	if (!isGigKey(key) && !isArtistKey(key)) {
		throw new ValidationError('key must be "mb:<mbid>", "name:<name>" or "gig:<venue>:<id>"');
	}
	const gigKey = isGigKey(key);
	const state = item.state;
	if (state !== null && !(STATES as readonly unknown[]).includes(state)) {
		throw new ValidationError(`state must be one of ${STATES.join(', ')} or null`);
	}
	// LEGACY-BOARD: an artist key takes any state (from now on: listen, nope or null).
	if (gigKey && state !== null && !GIG_STATES.includes(state as State)) {
		throw new ValidationError(`a gig's state must be one of ${GIG_STATES.join(', ')} or null`);
	}
	const name =
		item.name === undefined && state === null ? '' : text(item.name, 'name', LIMITS.nameLength);
	if (state !== null && !name.trim()) throw new ValidationError('name is required');
	if (gigKey ? item.gig != null : item.artist != null || item.when != null) {
		throw new ValidationError(gigKey ? 'a gig has no gig field' : 'an artist has no artist or when');
	}
	const gig = item.gig == null ? undefined : text(item.gig, 'gig', LIMITS.gigLength);
	if (item.artist != null && !isArtistKey(item.artist)) {
		throw new ValidationError('artist must be "mb:<mbid>" or "name:<name>"');
	}
	const artist = item.artist == null ? undefined : (item.artist as string);
	const when = item.when == null ? undefined : parseWhen(item.when);
	const at = parseAt(item.at, now);
	if (state === null) return { key, data: null, at };
	return {
		key,
		data: {
			state,
			name,
			...(artist ? { artist } : {}),
			...(when ? { when } : {}),
			...(gig ? { gig } : {})
		},
		at
	};
}

export const board: Collection = {
	name: 'board',
	maxRows: LIMITS.itemsPerUser,
	overflow: 'reject',
	fullMessage: 'board is full',
	parseItem: parseBoardItem,
	toWire(row): BoardItem {
		if (row.data === null) return { key: row.key, state: null, name: '', at: row.at };
		const { state, name, artist, when, gig } = data(row) as {
			state: State;
			name?: string;
			artist?: string | null;
			when?: string | null;
			gig?: string | null;
		};
		return {
			key: row.key,
			state,
			name: name ?? '',
			...(artist ? { artist } : {}),
			...(when ? { when } : {}),
			...(gig ? { gig } : {}),
			at: row.at
		};
	}
};

// --- unavailable dates -----------------------------------------------------------------------

/** Longest date range, in days (both ends included). */
export const MAX_RANGE_DAYS = 366;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIRST_DAY = Date.UTC(2024, 0, 1);
const LAST_DAY = Date.UTC(2100, 11, 31);

/** "YYYY-MM-DD" as UTC midnight milliseconds, or null if it isn't a real date in range. */
function day(value: string): number | null {
	const m = DATE.exec(value);
	if (!m) return null;
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	if (new Date(ms).toISOString().slice(0, 10) !== value) return null; // 2026-02-31
	return ms >= FIRST_DAY && ms <= LAST_DAY ? ms : null;
}

/** Is `key` a canonical unavailable-dates key? */
export function isUnavailableKey(key: unknown): key is string {
	if (typeof key !== 'string' || key.length > 32) return false;
	if (key.startsWith('weekly:')) return (WEEKDAYS as readonly string[]).includes(key.slice(7));
	const [first, last, ...more] = key.split('/');
	if (more.length || first === undefined) return false;
	const a = day(first);
	if (a === null) return false;
	if (last === undefined) return true;
	const b = day(last);
	// A one-day range is written as the day alone, so each set of dates has one key.
	return b !== null && b > a && (b - a) / 86_400_000 < MAX_RANGE_DAYS;
}

const UNAVAILABLE_FIELDS = new Set(['key', 'label', 'deleted', 'at']);

export function parseUnavailableItem(raw: unknown, now: number): Parsed {
	const item = fields(raw, UNAVAILABLE_FIELDS);
	if (!isUnavailableKey(item.key)) {
		throw new ValidationError(
			'key must be "YYYY-MM-DD", "YYYY-MM-DD/YYYY-MM-DD" (in order, at most a year) or "weekly:<mon…sun>"'
		);
	}
	if (item.deleted !== undefined && item.deleted !== true) {
		throw new ValidationError('deleted must be true when present');
	}
	const at = parseAt(item.at, now);
	if (item.deleted) {
		if (item.label !== undefined) throw new ValidationError('a deletion has no label');
		return { key: item.key, data: null, at };
	}
	const label = item.label === undefined ? '' : text(item.label, 'label', LIMITS.labelLength);
	return {
		key: item.key,
		data: label.trim() ? { label: label.trim() } : {},
		at
	};
}

export const unavailable: Collection = {
	name: 'unavailable',
	maxRows: 2000,
	overflow: 'reject',
	fullMessage: 'too many unavailable dates',
	parseItem: parseUnavailableItem,
	toWire(row) {
		if (row.data === null) return { key: row.key, deleted: true, at: row.at };
		const { label } = data(row) as { label?: string };
		return { key: row.key, ...(label ? { label } : {}), at: row.at };
	}
};

// --- play history ----------------------------------------------------------------------------

/** Keep in step with radio-core's HISTORY_MAX_AGE_DAYS. */
export const PLAYS_MAX_AGE_DAYS = 60;
export const PLAYS_MAX_ROWS = 10_000;
const DAY_MS = 86_400_000;

const PLAY_FIELDS = new Set(['key', 'at']);

export function parsePlay(raw: unknown, now: number): Parsed | null {
	const item = fields(raw, PLAY_FIELDS);
	if (!isArtistKey(item.key)) throw new ValidationError('key must be "mb:<mbid>" or "name:<name>"');
	const ms = parseTime(item.at);
	// A play from the future is a broken clock, one past the window is already forgotten: neither
	// is stored, but neither is worth failing the batch over.
	if (ms > now + MAX_CLOCK_AHEAD_MS || ms < now - PLAYS_MAX_AGE_DAYS * DAY_MS) return null;
	const at = new Date(ms).toISOString();
	// The time goes first: ISO timestamps are all 24 characters, so the split is unambiguous.
	return { key: `${at} ${item.key}`, data: {}, at };
}

export const plays: Collection = {
	name: 'plays',
	maxRows: PLAYS_MAX_ROWS,
	overflow: 'forget-oldest',
	fullMessage: 'too many plays',
	maxAgeDays: PLAYS_MAX_AGE_DAYS,
	parseItem: parsePlay,
	toWire: (row) => ({ key: row.key.slice(25), at: row.at })
};

export const COLLECTIONS: Readonly<Record<CollectionName, Collection>> = {
	board,
	unavailable,
	plays
};
