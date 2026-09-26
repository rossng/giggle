// The board in D1. Last write wins per (user, artist) by the client's `at`; on a tie the stored
// row stays, and clients break ties the same way (the server's copy wins). Deletions are rows with
// state NULL (tombstones), so they sync like any other change. Every accepted write gets a new
// per-user `seq`, which is what `since` cursors page by.

import { LIMITS, type State, type WireItem } from './validate';

interface Row {
	artist_key: string;
	state: State | null;
	name: string;
	gig: string | null;
	at: string;
	seq: number;
}

function toWire(row: Row): WireItem {
	return {
		key: row.artist_key,
		state: row.state,
		name: row.name,
		...(row.gig ? { gig: row.gig } : {}),
		at: row.at
	};
}

const COLUMNS = 'artist_key, state, name, gig, at, seq';

// One statement for the whole batch (D1 counts statements per invocation): rows come in as a JSON
// array. seq = the user's highest seq + position + 1, so every accepted row gets a fresh, higher seq.
const UPSERT = `
INSERT INTO board_items (user, artist_key, state, name, gig, at, seq)
SELECT ?1, j.value ->> 'key', j.value ->> 'state', j.value ->> 'name', j.value ->> 'gig',
       j.value ->> 'at',
       (SELECT COALESCE(MAX(seq), 0) FROM board_items WHERE user = ?1) + j.key + 1
FROM json_each(?2) AS j
WHERE true
ON CONFLICT (user, artist_key) DO UPDATE SET
  state = excluded.state, name = excluded.name, gig = excluded.gig, at = excluded.at,
  seq = excluded.seq
WHERE excluded.at > board_items.at`;

export class TooManyItems extends Error {}

/** Applies `items` for `user` (older ones lose), returning the stored rows for those keys. */
export async function putItems(
	db: D1Database,
	user: string,
	items: WireItem[]
): Promise<WireItem[]> {
	const keys = JSON.stringify(items.map((item) => item.key));
	const count = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM board_items WHERE user = ?1) AS total,
			   (SELECT COUNT(*) FROM board_items WHERE user = ?1
			      AND artist_key IN (SELECT value FROM json_each(?2))) AS existing`
		)
		.bind(user, keys)
		.first<{ total: number; existing: number }>();
	const added = items.length - (count?.existing ?? 0);
	if ((count?.total ?? 0) + added > LIMITS.itemsPerUser) throw new TooManyItems();

	const rows = items.map((item) => ({
		key: item.key,
		state: item.state,
		name: item.name,
		gig: item.gig ?? null,
		at: item.at
	}));
	const [, stored] = await db.batch<Row>([
		db.prepare(UPSERT).bind(user, JSON.stringify(rows)),
		db
			.prepare(
				`SELECT ${COLUMNS} FROM board_items
				 WHERE user = ?1 AND artist_key IN (SELECT value FROM json_each(?2))`
			)
			.bind(user, keys)
	]);
	return (stored?.results ?? []).map(toWire);
}

export interface Page {
	items: WireItem[];
	/** Pass back as `since` to get only what changed after this page. */
	cursor: string;
	/** More changes are waiting: ask again with `cursor`. */
	more: boolean;
}

/** `user`'s rows (tombstones included) changed after cursor `since`, oldest change first. */
export async function itemsSince(db: D1Database, user: string, since: number): Promise<Page> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM board_items WHERE user = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`
		)
		.bind(user, since, LIMITS.page + 1)
		.all<Row>();
	const more = results.length > LIMITS.page;
	const page = more ? results.slice(0, LIMITS.page) : results;
	const last = page.at(-1)?.seq ?? since;
	return { items: page.map(toWire), cursor: String(last), more };
}
