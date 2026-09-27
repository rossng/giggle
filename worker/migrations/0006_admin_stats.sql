-- What the admin panel shows (src/admin.ts), kept without a per-user activity history: each
-- account's last active day, and site-wide counts per day that hold no user ids (src/stats.ts).

-- The UTC day ("2026-10-03") the account last used the API: set at most once a day. Accounts from
-- before this migration start from the last day a passkey signed them in (or they were made).
ALTER TABLE accounts ADD COLUMN last_seen TEXT;
UPDATE accounts SET last_seen = substr(
	max(created, COALESCE((SELECT max(last_used) FROM passkeys WHERE account = accounts.id), '')),
	1, 10);

-- Site-wide counts per UTC day, kept 400 days:
--   active_users  accounts that used the API that day (each once, when last_seen moves to it)
--   new_accounts  sign-ups
--   rows_written  rows sent in accepted sync writes (what the daily row budget counts)
--   quota_hits    daily quotas that started refusing: once per account out of its row budget,
--                 and once when the day's new-account cap first turned someone away
CREATE TABLE daily_stats (
	day TEXT PRIMARY KEY,
	active_users INTEGER NOT NULL DEFAULT 0,
	new_accounts INTEGER NOT NULL DEFAULT 0,
	rows_written INTEGER NOT NULL DEFAULT 0,
	quota_hits INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT INTO daily_stats (day, new_accounts)
SELECT substr(created, 1, 10), count(*) FROM accounts
WHERE created >= date('now', '-400 days')
GROUP BY substr(created, 1, 10);

-- Whether the account's row budget has refused a write today (usage.day): quota_hits counts that
-- once, so refused writes can't themselves spend D1 writes.
ALTER TABLE usage ADD COLUMN refused INTEGER NOT NULL DEFAULT 0;
