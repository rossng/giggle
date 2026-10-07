// The board as it travels to and from the accounts API (worker/src/collections.ts). The server
// rejects a whole batch if one item breaks its rules, so items it would refuse are kept local
// only and never pushed; keep these rules in step with the Worker's.

import { isArtistTriage, isGigKey, isGigTriage, TRIAGES, type Triage } from '$lib/board/board';

/** A board entry, or a deletion (`state: null`, a tombstone), with when it happened. */
export interface SyncItem {
	state: Triage | null;
	name: string;
	/** A gig's: the artist it was sorted for. */
	artist?: string;
	/** A gig's start, ISO 8601. */
	when?: string;
	/** LEGACY-BOARD: only on artists sorted by an older version: the gig they were sorted from.
	 * parseBoard (board.ts) moves want to go and got tickets onto that gig. */
	gig?: string;
	/** ISO 8601. Last write wins by this. */
	at: string;
}

export interface WireItem extends SyncItem {
	key: string;
}

export const LIMITS = {
	/** Items per PUT; the server allows 500, but the body must stay under 256 KB too. */
	batch: 200,
	keyLength: 256,
	nameLength: 300,
	gigLength: 256
} as const;

const MBID = /^mb:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_KEY = /^name:[^\p{Cc}\p{Cs}]*$/u;
const GIG_KEY = /^gig:[a-z0-9-]+:[^\p{Cc}\p{Cs}]+$/u;
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const EPOCH = Date.parse('2024-01-01T00:00:00Z');

function isText(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length <= max && NO_CONTROL.test(value);
}

/** "mb:<mbid>" or "name:<normalised name>", as the server accepts them. */
export function isArtistKey(key: string): boolean {
	return key.length <= LIMITS.keyLength && (MBID.test(key) || NAME_KEY.test(key));
}

/** "gig:<venue>:<source_id>", as the server accepts them. */
export function isGigBoardKey(key: string): boolean {
	return key.length <= LIMITS.keyLength && GIG_KEY.test(key);
}

/** Would the server accept this item? */
export function isSyncable(key: string, item: SyncItem): boolean {
	const gig = isGigKey(key);
	if (!(gig ? isGigBoardKey(key) : isArtistKey(key))) return false;
	const at = Date.parse(item.at);
	if (Number.isNaN(at) || at < EPOCH) return false;
	if (item.state === null) return true;
	if (!isText(item.name, LIMITS.nameLength) || !item.name.trim()) return false;
	if (!gig) return isArtistTriage(item.state) && item.gig === undefined;
	if (!isGigTriage(item.state)) return false;
	if (item.artist !== undefined && !isArtistKey(item.artist)) return false;
	return item.when === undefined || (ISO.test(item.when) && Date.parse(item.when) >= EPOCH);
}

export function toWire(key: string, item: SyncItem): WireItem {
	const kept = item.state !== null && isGigKey(key);
	return {
		key,
		state: item.state,
		name: item.state === null ? '' : item.name,
		...(kept && item.artist ? { artist: item.artist } : {}),
		...(kept && item.when ? { when: item.when } : {}),
		at: new Date(Date.parse(item.at)).toISOString()
	};
}

function isTriage(value: unknown): value is Triage {
	return (TRIAGES as readonly unknown[]).includes(value);
}

function optional(value: unknown, test: (v: string) => boolean): string | undefined {
	return typeof value === 'string' && value && test(value) ? value : undefined;
}

/** One item from a server response (or a stored copy of one), or null if it's malformed. */
export function fromWire(raw: unknown): WireItem | null {
	const item = raw as Partial<WireItem> | null;
	if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key) return null;
	if (item.state !== null && !isTriage(item.state)) return null;
	if (typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) return null;
	const artist = optional(item.artist, () => true);
	const when = optional(item.when, (v) => !Number.isNaN(Date.parse(v)));
	const gig = optional(item.gig, () => true); // LEGACY-BOARD
	return {
		key: item.key,
		state: item.state,
		name: typeof item.name === 'string' ? item.name : '',
		...(artist ? { artist } : {}),
		...(when ? { when } : {}),
		...(gig ? { gig } : {}),
		at: item.at
	};
}
