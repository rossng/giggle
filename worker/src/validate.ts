// Strict parsing of what clients send. A batch is accepted whole or rejected whole (400), so a
// client never has to work out which of its changes landed. The web client (web/src/lib/sync/)
// applies the same rules before pushing; keep the two in step. What each collection's items
// look like is in collections.ts; the shared rules are here.

export const LIMITS = {
	/** Items per PUT (the web app sends at most 400). */
	batch: 400,
	/** Request body, bytes. */
	body: 256 * 1024,
	keyLength: 256,
	nameLength: 300,
	gigLength: 256,
	labelLength: 100,
	/** Board rows (including tombstones) one user may have. */
	itemsPerUser: 20_000,
	/** Rows per GET page. */
	page: 1000
} as const;

export class ValidationError extends Error {}

const MBID = /^mb:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// "name:" + the pipeline's normalised name (may be empty for names that normalise away).
const NAME_KEY = /^name:[^\p{Cc}\p{Cs}]*$/u;
const NO_CONTROL = /^[^\p{Cc}\p{Cs}]*$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Earliest acceptable change time; anything older is a broken clock. */
export const EPOCH = Date.parse('2024-01-01T00:00:00Z');
/** Changes stamped further ahead than this are clamped to the server's clock. */
export const MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000;

export function isArtistKey(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= LIMITS.keyLength &&
		(MBID.test(value) || NAME_KEY.test(value))
	);
}

/** `value` as milliseconds since the epoch (not before EPOCH), or throws. */
export function parseTime(value: unknown): number {
	if (typeof value !== 'string' || !ISO.test(value)) {
		throw new ValidationError('at must be an ISO 8601 timestamp');
	}
	const ms = Date.parse(value);
	if (Number.isNaN(ms) || ms < EPOCH) throw new ValidationError('at is out of range');
	return ms;
}

/** `value` as a normalised ISO timestamp (clamped to `now` if from the future), or throws. */
export function parseAt(value: unknown, now: number): string {
	const ms = parseTime(value);
	return new Date(ms > now + MAX_CLOCK_AHEAD_MS ? now : ms).toISOString();
}

export function text(value: unknown, field: string, max: number): string {
	if (typeof value !== 'string' || value.length > max || !NO_CONTROL.test(value)) {
		throw new ValidationError(`${field} must be a string of at most ${max} characters`);
	}
	return value;
}

/** `raw` as an object with only `allowed` fields, or throws. */
export function fields(raw: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ValidationError('each item must be an object');
	}
	const item = raw as Record<string, unknown>;
	for (const field of Object.keys(item)) {
		if (!allowed.has(field)) throw new ValidationError(`unknown field: ${field}`);
	}
	return item;
}

/**
 * The body of a PUT: `{"items": [...]}`, each parsed by `parseItem` (null: valid, but not to be
 * stored). Items are told apart by the key `parseItem` gives them; a batch may not repeat one.
 */
export function parseBatch<T extends { key: string }>(
	body: unknown,
	parseItem: (raw: unknown) => T | null
): T[] {
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
	const parsed = items.map(parseItem);
	const kept = parsed.filter((item): item is T => item !== null);
	if (new Set(kept.map((item) => item.key)).size !== kept.length) {
		throw new ValidationError('duplicate keys in batch');
	}
	return kept;
}

/** `?since=` : a cursor returned by an earlier GET, or absent for everything. */
export function parseSince(value: string | null): number {
	if (value === null || value === '') return 0;
	if (!/^\d{1,15}$/.test(value))
		throw new ValidationError('since must be a cursor from a previous response');
	return Number(value);
}
