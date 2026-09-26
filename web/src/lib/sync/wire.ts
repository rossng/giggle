// The board as it travels to and from the accounts API (worker/src/validate.ts). The server
// rejects a whole batch if one item breaks its rules, so items it would refuse are kept local
// only and never pushed; keep these rules in step with the Worker's.

import { TRIAGES, type BoardItem, type Triage } from '$lib/board/board';

/** A board entry, or a deletion (`state: null`, a tombstone), with when it happened. */
export interface SyncItem {
	state: Triage | null;
	name: string;
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
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;
const EPOCH = Date.parse('2024-01-01T00:00:00Z');

function isText(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length <= max && NO_CONTROL.test(value);
}

/** Would the server accept this item? */
export function isSyncable(key: string, item: SyncItem): boolean {
	if (key.length > LIMITS.keyLength || !(MBID.test(key) || NAME_KEY.test(key))) return false;
	const at = Date.parse(item.at);
	if (Number.isNaN(at) || at < EPOCH) return false;
	if (item.state === null) return true;
	if (!isText(item.name, LIMITS.nameLength) || !item.name.trim()) return false;
	return item.gig === undefined || isText(item.gig, LIMITS.gigLength);
}

export function toWire(key: string, item: SyncItem): WireItem {
	return {
		key,
		state: item.state,
		name: item.state === null ? '' : item.name,
		...(item.state !== null && item.gig ? { gig: item.gig } : {}),
		at: new Date(Date.parse(item.at)).toISOString()
	};
}

function isTriage(value: unknown): value is Triage {
	return (TRIAGES as readonly unknown[]).includes(value);
}

/** One item from a server response, or null if it's malformed. */
export function fromWire(raw: unknown): WireItem | null {
	const item = raw as Partial<WireItem> | null;
	if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key) return null;
	if (item.state !== null && !isTriage(item.state)) return null;
	if (typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) return null;
	return {
		key: item.key,
		state: item.state,
		name: typeof item.name === 'string' ? item.name : '',
		...(typeof item.gig === 'string' && item.gig ? { gig: item.gig } : {}),
		at: item.at
	};
}

export function toBoardItem(item: SyncItem & { state: Triage }): BoardItem {
	return {
		state: item.state,
		name: item.name,
		...(item.gig ? { gig: item.gig } : {}),
		at: item.at
	};
}
