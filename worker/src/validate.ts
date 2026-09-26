// Strict parsing of what clients send. A batch is accepted whole or rejected whole (400), so a
// client never has to work out which of its changes landed. The web client
// (web/src/lib/sync/items.ts) applies the same rules before pushing; keep the two in step.

export const STATES = ['listen', 'go', 'tickets', 'nope'] as const;
export type State = (typeof STATES)[number];

export const LIMITS = {
	/** Items per PUT. */
	batch: 500,
	/** Request body, bytes. */
	body: 256 * 1024,
	keyLength: 256,
	nameLength: 300,
	gigLength: 256,
	/** Rows (including tombstones) one user may have. */
	itemsPerUser: 20_000,
	/** Rows per GET page. */
	page: 1000
} as const;

/** One board entry as it travels over the wire. `state: null` is a deletion (tombstone). */
export interface WireItem {
	key: string;
	state: State | null;
	name: string;
	gig?: string;
	/** ISO 8601 UTC with milliseconds (Date#toISOString). */
	at: string;
}

export class ValidationError extends Error {}

const MBID = /^mb:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// "name:" + the pipeline's normalised name (may be empty for names that normalise away).
const NAME_KEY = /^name:[^\p{Cc}\p{Cs}]*$/u;
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ALLOWED = new Set(['key', 'state', 'name', 'gig', 'at']);

/** Earliest acceptable change time; anything older is a broken clock. */
const EPOCH = Date.parse('2024-01-01T00:00:00Z');
/** Changes stamped further ahead than this are clamped to the server's clock. */
export const MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000;

export function isArtistKey(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= LIMITS.keyLength &&
		(MBID.test(value) || NAME_KEY.test(value))
	);
}

/** `value` as a normalised ISO timestamp (clamped to `now` if from the future), or throws. */
export function parseAt(value: unknown, now: number): string {
	if (typeof value !== 'string' || !ISO.test(value)) {
		throw new ValidationError('at must be an ISO 8601 timestamp');
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms) || ms < EPOCH) throw new ValidationError('at is out of range');
	return new Date(ms > now + MAX_CLOCK_AHEAD_MS ? now : ms).toISOString();
}

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== 'string' || value.length > max || !NO_CONTROL.test(value)) {
		throw new ValidationError(`${field} must be a string of at most ${max} characters`);
	}
	return value;
}

export function parseItem(raw: unknown, now: number): WireItem {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ValidationError('each item must be an object');
	}
	const item = raw as Record<string, unknown>;
	for (const field of Object.keys(item)) {
		if (!ALLOWED.has(field)) throw new ValidationError(`unknown field: ${field}`);
	}
	if (!isArtistKey(item.key)) throw new ValidationError('key must be "mb:<mbid>" or "name:<name>"');
	const state = item.state;
	if (state !== null && !(STATES as readonly unknown[]).includes(state)) {
		throw new ValidationError(`state must be one of ${STATES.join(', ')} or null`);
	}
	const name =
		item.name === undefined && state === null ? '' : text(item.name, 'name', LIMITS.nameLength);
	if (state !== null && !name.trim()) throw new ValidationError('name is required');
	const gig = item.gig == null ? undefined : text(item.gig, 'gig', LIMITS.gigLength);
	return {
		key: item.key,
		state: state as State | null,
		name,
		...(gig ? { gig } : {}),
		at: parseAt(item.at, now)
	};
}

/** The body of `PUT /api/board`: `{"items": [...]}`. */
export function parseBatch(body: unknown, now: number): WireItem[] {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new ValidationError('body must be {"items": [...]}');
	}
	const { items, ...rest } = body as Record<string, unknown>;
	if (Object.keys(rest).length) throw new ValidationError('body must only have "items"');
	if (!Array.isArray(items) || items.length === 0) {
		throw new ValidationError('items must be a non-empty array');
	}
	if (items.length > LIMITS.batch) {
		throw new ValidationError(`at most ${LIMITS.batch} items per request`);
	}
	const parsed = items.map((item) => parseItem(item, now));
	if (new Set(parsed.map((item) => item.key)).size !== parsed.length) {
		throw new ValidationError('duplicate keys in batch');
	}
	return parsed;
}

/** `?since=` : a cursor returned by an earlier GET, or absent for everything. */
export function parseSince(value: string | null): number {
	if (value === null || value === '') return 0;
	if (!/^\d{1,15}$/.test(value))
		throw new ValidationError('since must be a cursor from a previous response');
	return Number(value);
}
