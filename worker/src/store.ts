// Synced collections in D1 (table sync_items, migrations/0002). Last write wins per
// (user, collection, key) by the client's `at`; on a tie the stored row stays, and clients break
// ties the same way (the server's copy wins). Deletions are rows with data NULL (tombstones), so
// they sync like any other change. Every accepted write gets a new per-user, per-collection
// `seq`, which is what `since` cursors page by.

import type { Collection, Parsed, Row } from './collections';
import { LIMITS } from './validate';

const DAY_MS = 86_400_000;
const COLUMNS = 'key, data, at, seq';

// One statement for the whole batch (D1 counts statements per invocation): rows come in as a JSON
// array. seq = the collection's highest seq + position + 1, so every accepted row gets a fresh,
// higher seq. (Pruning never deletes the highest-seq row, so that maximum never goes down and a
// seq is never handed out twice.)
const UPSERT = `
INSERT INTO sync_items (user, collection, key, data, at, seq)
SELECT ?1, ?2, j.value ->> 'key', j.value ->> 'data', j.value ->> 'at',
       (SELECT COALESCE(MAX(seq), 0) FROM sync_items WHERE user = ?1 AND collection = ?2) + j.key + 1
FROM json_each(?3) AS j
WHERE true
ON CONFLICT (user, collection, key) DO UPDATE SET
  data = excluded.data, at = excluded.at, seq = excluded.seq
WHERE excluded.at > sync_items.at`;

const NOT_NEWEST = `seq < (SELECT MAX(seq) FROM sync_items WHERE user = ?1 AND collection = ?2)`;

// Collections that forget: rows past the age limit, then the oldest past the row limit.
const FORGET_OLD = `
DELETE FROM sync_items WHERE user = ?1 AND collection = ?2 AND at < ?3 AND ${NOT_NEWEST}`;
const FORGET_OVERFLOW = `
DELETE FROM sync_items WHERE user = ?1 AND collection = ?2 AND ${NOT_NEWEST} AND key IN (
  SELECT key FROM sync_items WHERE user = ?1 AND collection = ?2
  ORDER BY at DESC, key DESC LIMIT -1 OFFSET ?3)`;

export class TooManyItems extends Error {}

/** The oldest `at` a collection still keeps, as an ISO string ('' when it keeps everything). */
function cutoff(collection: Collection, now: number): string {
	return collection.maxAgeDays === undefined
		? ''
		: new Date(now - collection.maxAgeDays * DAY_MS).toISOString();
}

/**
 * Applies `items` to `user`'s `collection` (older ones lose), returning the stored rows for
 * those keys in wire form. Rows the collection forgets straight away aren't returned.
 */
export async function putItems(
	db: D1Database,
	collection: Collection,
	user: string,
	items: Parsed[],
	now: number
): Promise<Record<string, unknown>[]> {
	if (!items.length) return [];
	const keys = JSON.stringify(items.map((item) => item.key));
	if (collection.overflow === 'reject') {
		const count = await db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM sync_items WHERE user = ?1 AND collection = ?2) AS total,
				   (SELECT COUNT(*) FROM sync_items WHERE user = ?1 AND collection = ?2
				      AND key IN (SELECT value FROM json_each(?3))) AS existing`
			)
			.bind(user, collection.name, keys)
			.first<{ total: number; existing: number }>();
		const added = items.length - (count?.existing ?? 0);
		if ((count?.total ?? 0) + added > collection.maxRows) throw new TooManyItems();
	}

	const rows = items.map((item) => ({
		key: item.key,
		data: item.data === null ? null : JSON.stringify(item.data),
		at: item.at
	}));
	const statements = [db.prepare(UPSERT).bind(user, collection.name, JSON.stringify(rows))];
	if (collection.maxAgeDays !== undefined) {
		statements.push(db.prepare(FORGET_OLD).bind(user, collection.name, cutoff(collection, now)));
	}
	if (collection.overflow === 'forget-oldest') {
		statements.push(db.prepare(FORGET_OVERFLOW).bind(user, collection.name, collection.maxRows));
	}
	statements.push(
		db
			.prepare(
				`SELECT ${COLUMNS} FROM sync_items
				 WHERE user = ?1 AND collection = ?2 AND at >= ?4
				   AND key IN (SELECT value FROM json_each(?3))`
			)
			.bind(user, collection.name, keys, cutoff(collection, now))
	);
	const results = await db.batch<Row>(statements);
	return (results.at(-1)?.results ?? []).map(collection.toWire);
}

export interface Page {
	items: Record<string, unknown>[];
	/** Pass back as `since` to get only what changed after this page. */
	cursor: string;
	/** More changes are waiting: ask again with `cursor`. */
	more: boolean;
}

/** `user`'s rows (tombstones included) changed after cursor `since`, oldest change first. */
export async function itemsSince(
	db: D1Database,
	collection: Collection,
	user: string,
	since: number,
	now: number
): Promise<Page> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM sync_items
			 WHERE user = ?1 AND collection = ?2 AND seq > ?3 AND at >= ?4
			 ORDER BY seq LIMIT ?5`
		)
		.bind(user, collection.name, since, cutoff(collection, now), LIMITS.page + 1)
		.all<Row>();
	const more = results.length > LIMITS.page;
	const page = more ? results.slice(0, LIMITS.page) : results;
	const last = page.at(-1)?.seq ?? since;
	return { items: page.map(collection.toWire), cursor: String(last), more };
}
