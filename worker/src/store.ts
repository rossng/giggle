// Synced collections in D1 (table sync_items, migrations/0002). Last write wins per
// (user, collection, key) by the client's `at`; on a tie the stored row stays, and clients break
// ties the same way (the server's copy wins). Deletions are rows with data NULL (tombstones), so
// they sync like any other change. Every accepted write gets a new per-user, per-collection
// `seq`, which is what `since` cursors page by.
//
// Writes also keep each collection's row count (sync_counts) and spend the account's daily row
// budget (usage), so neither has to be found by counting rows (migrations/0005), and add to the
// day's site-wide rows_written (stats.ts).

import type { Collection, Parsed, Row } from './collections';
import { bump, noteOverBudget } from './stats';
import { LIMITS } from './validate';

const DAY_MS = 86_400_000;
const COLUMNS = 'key, data, at, seq';

/** Rows one account may write a day, all collections together. */
export const DAILY_ROWS = 10_000;

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

// Collections that forget: rows past the age limit (once a day), and the oldest past the row
// limit (when over it, down to OVERFLOW_KEEP of it, so that it doesn't run on every write).
const FORGET_OLD = `
DELETE FROM sync_items WHERE user = ?1 AND collection = ?2 AND at < ?3 AND ${NOT_NEWEST}`;
const FORGET_OVERFLOW = `
DELETE FROM sync_items WHERE user = ?1 AND collection = ?2 AND ${NOT_NEWEST} AND key IN (
  SELECT key FROM sync_items WHERE user = ?1 AND collection = ?2
  ORDER BY at DESC, key DESC LIMIT -1 OFFSET ?3)`;
const OVERFLOW_KEEP = 0.9;

// A write adds the keys that are new to the count, in the same transaction as the upsert, so it
// stays exact. Forgetting rows is rare enough to count them all again afterwards.
const COUNT_NEW = `
INSERT INTO sync_counts (user, collection, rows)
SELECT ?1, ?2, count(*) FROM json_each(?3) AS j
WHERE NOT EXISTS (
  SELECT 1 FROM sync_items WHERE user = ?1 AND collection = ?2 AND key = j.value)
ON CONFLICT (user, collection) DO UPDATE SET rows = sync_counts.rows + excluded.rows`;
const RECOUNT = `
INSERT INTO sync_counts (user, collection, rows, pruned)
VALUES (?1, ?2, (SELECT count(*) FROM sync_items WHERE user = ?1 AND collection = ?2), ?3)
ON CONFLICT (user, collection) DO UPDATE SET rows = excluded.rows, pruned = excluded.pruned`;

// Where a collection stands before a write: its row count, the day it last forgot old rows, and
// how many of the batch's keys it has already.
const STATE = `
SELECT
  COALESCE((SELECT rows FROM sync_counts WHERE user = ?1 AND collection = ?2), 0) AS rows,
  COALESCE((SELECT pruned FROM sync_counts WHERE user = ?1 AND collection = ?2), '') AS pruned,
  (SELECT count(*) FROM sync_items WHERE user = ?1 AND collection = ?2
     AND key IN (SELECT value FROM json_each(?3))) AS existing`;

// Spends ?3 rows of today's budget, unless that would take it past ?4 (then no row comes back).
// A new day starts with the whole budget and nothing refused.
const SPEND = `
INSERT INTO usage (user, day, rows) VALUES (?1, ?2, ?3)
ON CONFLICT (user) DO UPDATE SET
  rows = CASE WHEN usage.day = excluded.day THEN usage.rows + excluded.rows ELSE excluded.rows END,
  refused = CASE WHEN usage.day = excluded.day THEN usage.refused ELSE 0 END,
  day = excluded.day
WHERE usage.day <> excluded.day OR usage.rows + excluded.rows <= ?4
RETURNING rows`;

export class TooManyItems extends Error {}
/** The account has written its DAILY_ROWS today. */
export class OverBudget extends Error {}

/** The oldest `at` a collection still keeps, as an ISO string ('' when it keeps everything). */
function cutoff(collection: Collection, now: number): string {
	return collection.maxAgeDays === undefined
		? ''
		: new Date(now - collection.maxAgeDays * DAY_MS).toISOString();
}

/** The UTC day of `now`: "2026-10-03". */
export function dayOf(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Applies `items` to `user`'s `collection` (older ones lose), returning the stored rows for
 * those keys in wire form. Rows the collection forgets straight away aren't returned. Throws
 * OverBudget once the account has written DAILY_ROWS today, and TooManyItems if a collection that
 * refuses overflow would go past its maxRows.
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
	const day = dayOf(now);
	const [spent, state] = await db.batch<Record<string, unknown>>([
		db.prepare(SPEND).bind(user, day, items.length, DAILY_ROWS),
		db.prepare(STATE).bind(user, collection.name, keys)
	]);
	if (!spent?.results.length) {
		await noteOverBudget(db, user, day);
		throw new OverBudget();
	}
	const { rows, pruned, existing } = state!.results[0] as {
		rows: number;
		pruned: string;
		existing: number;
	};
	const after = rows + items.length - existing;
	if (collection.overflow === 'reject' && after > collection.maxRows) throw new TooManyItems();

	const wire = items.map((item) => ({
		key: item.key,
		data: item.data === null ? null : JSON.stringify(item.data),
		at: item.at
	}));
	const statements = [
		db.prepare(COUNT_NEW).bind(user, collection.name, keys),
		db.prepare(UPSERT).bind(user, collection.name, JSON.stringify(wire)),
		bump(db, 'rows_written', day, items.length)
	];
	const forgetOld = collection.maxAgeDays !== undefined && pruned !== day;
	const forgetOverflow = collection.overflow === 'forget-oldest' && after > collection.maxRows;
	if (forgetOld) {
		statements.push(db.prepare(FORGET_OLD).bind(user, collection.name, cutoff(collection, now)));
	}
	if (forgetOverflow) {
		const keep = Math.floor(collection.maxRows * OVERFLOW_KEEP);
		statements.push(db.prepare(FORGET_OVERFLOW).bind(user, collection.name, keep));
	}
	if (forgetOld || forgetOverflow) {
		statements.push(db.prepare(RECOUNT).bind(user, collection.name, forgetOld ? day : pruned));
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

/** Statements deleting everything `user` has synced, with its counts and usage. */
export function forgetUser(db: D1Database, user: string): D1PreparedStatement[] {
	return [
		db.prepare('DELETE FROM sync_items WHERE user = ?').bind(user),
		db.prepare('DELETE FROM sync_counts WHERE user = ?').bind(user),
		db.prepare('DELETE FROM usage WHERE user = ?').bind(user)
	];
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
