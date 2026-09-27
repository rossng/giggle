-- Sessions that know which passkey signed them in, row counts kept alongside the synced data,
-- and daily quotas (src/auth.ts, src/passkeys.ts, src/store.ts, src/quotas.ts).
--
-- (The comments in 0001 and 0002 say `user` is an email address from Cloudflare Access: it is
-- the account id, "u_<uuid>", or the dev identity's email address.)

-- The session cookie changed name (__Host-giggle_session), so no existing session can be used
-- again: everyone signs in once more.
DELETE FROM sessions;
-- The passkey that signed this session in (or last confirmed it): removing that passkey ends it.
ALTER TABLE sessions ADD COLUMN passkey TEXT;
-- When a passkey last confirmed it's really them (ISO 8601): adding or removing a passkey and
-- deleting the account need this to be recent.
ALTER TABLE sessions ADD COLUMN verified_at TEXT;
CREATE INDEX sessions_passkey ON sessions (passkey);

-- Challenges only live five minutes, so the table can be remade to allow the 'reauth' purpose
-- (confirming a signed-in session with a passkey).
DROP TABLE challenges;
CREATE TABLE challenges (
	id TEXT PRIMARY KEY,
	challenge TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'reauth')),
	-- register: the account the new passkey joins (new or the signed-in one); reauth: the
	-- signed-in account.
	account TEXT,
	-- register: whether that account already exists.
	existing INTEGER NOT NULL DEFAULT 0,
	expires TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX challenges_expires ON challenges (expires);
CREATE INDEX challenges_account ON challenges (account);

-- How many rows (tombstones included) each user has in each collection, kept in step by every
-- write, so a write doesn't have to count them. `pruned` is the day (YYYY-MM-DD) old rows were
-- last forgotten, for collections that forget.
CREATE TABLE sync_counts (
	user TEXT NOT NULL,
	collection TEXT NOT NULL,
	rows INTEGER NOT NULL,
	pruned TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (user, collection)
) WITHOUT ROWID;

INSERT INTO sync_counts (user, collection, rows)
SELECT user, collection, count(*) FROM sync_items GROUP BY user, collection;

-- Rows each user wrote to sync_items today (UTC): a daily budget per account.
CREATE TABLE usage (
	user TEXT PRIMARY KEY,
	day TEXT NOT NULL,
	rows INTEGER NOT NULL
) WITHOUT ROWID;

-- Site-wide daily counters, e.g. 'new-accounts'.
CREATE TABLE quotas (
	name TEXT PRIMARY KEY,
	day TEXT NOT NULL,
	n INTEGER NOT NULL
) WITHOUT ROWID;
