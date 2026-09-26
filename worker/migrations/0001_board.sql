-- Each user's board: artistKey → how they sorted it. One row per (user, artist), kept after
-- deletion as a tombstone (state NULL) so other devices learn about the deletion.
CREATE TABLE board_items (
	-- The user's email address, lower-cased (from Cloudflare Access, or the dev identity).
	user TEXT NOT NULL,
	-- "mb:<mbid>" or "name:<normalised name>".
	artist_key TEXT NOT NULL,
	-- NULL = unsorted (a tombstone).
	state TEXT CHECK (state IS NULL OR state IN ('listen', 'go', 'tickets', 'nope')),
	name TEXT NOT NULL DEFAULT '',
	-- "<venue>:<source_id>" the artist was sorted from, if any.
	gig TEXT,
	-- When the client made the change (ISO 8601, UTC, milliseconds). Last write wins by this.
	at TEXT NOT NULL,
	-- Per-user change counter, bumped on every accepted write: `GET /api/board?since=` pages by
	-- it, so a change is never missed because of clock skew between devices or servers.
	seq INTEGER NOT NULL,
	PRIMARY KEY (user, artist_key)
) WITHOUT ROWID;

CREATE INDEX board_items_user_seq ON board_items (user, seq);
