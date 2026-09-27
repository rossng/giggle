-- Every kind of synced personal data in one table: the board, unavailable dates and play history
-- are "collections" of keyed rows, synced the same way (last write wins per key by `at`, deletions
-- as tombstones, a per-user, per-collection change counter for `since` cursors). src/collections.ts
-- says what a row's key and data mean in each collection.
CREATE TABLE sync_items (
	-- The user's email address, lower-cased (from Cloudflare Access, or the dev identity).
	user TEXT NOT NULL,
	collection TEXT NOT NULL CHECK (collection IN ('board', 'unavailable', 'plays')),
	-- board: the artist key; unavailable: "2026-10-03", "2026-10-01/2026-10-07" or "weekly:mon";
	-- plays: "<at> <artist key>".
	key TEXT NOT NULL,
	-- The item as a JSON object; NULL is a deletion (a tombstone).
	data TEXT CHECK (data IS NULL OR json_valid(data)),
	-- When the client made the change (ISO 8601, UTC, milliseconds). Last write wins by this.
	at TEXT NOT NULL,
	-- Change counter per (user, collection), bumped on every accepted write: `GET ?since=` pages by
	-- it, so a change is never missed because of clock skew between devices or servers.
	seq INTEGER NOT NULL,
	PRIMARY KEY (user, collection, key)
) WITHOUT ROWID;

CREATE INDEX sync_items_seq ON sync_items (user, collection, seq);

-- The board moves in unchanged: same keys, times and seqs, so clients' cursors stay valid.
INSERT INTO sync_items (user, collection, key, data, at, seq)
SELECT user, 'board', artist_key,
       CASE WHEN state IS NULL THEN NULL
            -- json_patch drops the null members (a board item without a gig has no "gig").
            ELSE json_patch('{}', json_object('state', state, 'name', name, 'gig', gig)) END,
       at, seq
FROM board_items;

DROP TABLE board_items;
