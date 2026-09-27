// Site-wide counts per UTC day for the admin panel (table daily_stats, migrations/0006), and each
// account's last active day (accounts.last_seen). Neither keeps a history per user: daily_stats
// holds no user ids, and last_seen is overwritten.
//
// Every counter is bumped in the same batch as what it counts, or behind a condition that holds
// at most once per account (or per site) a day, so a client can't spend D1 writes through them.

const DAY_MS = 86_400_000;
/** Days of daily_stats kept. */
export const STATS_DAYS = 400;

export type Counter = 'active_users' | 'new_accounts' | 'rows_written' | 'quota_hits';

/**
 * Adds ?2 to today's (?1) `counter` when `where` holds (it may use ?3 and on). `counter` is one
 * of four fixed column names, never input.
 */
function bumpSql(counter: Counter, where = 'true'): string {
	return `INSERT INTO daily_stats (day, ${counter}) SELECT ?1, ?2 WHERE ${where}
	ON CONFLICT (day) DO UPDATE SET ${counter} = ${counter} + excluded.${counter}`;
}

/** Adds `by` to `day`'s `counter`: for a batch alongside the write it counts. */
export function bump(db: D1Database, counter: Counter, day: string, by = 1): D1PreparedStatement {
	return db.prepare(bumpSql(counter)).bind(day, by);
}

/** The UTC day `days` before `day`. */
export function daysBefore(day: string, days: number): string {
	return new Date(Date.parse(day) - days * DAY_MS).toISOString().slice(0, 10);
}

const NOT_SEEN = '(last_seen IS NULL OR last_seen < ?1)';

/**
 * Moves `account`'s last_seen to `day` and counts it active that day, if it wasn't already: one
 * write per account per day at most. Also forgets daily_stats past STATS_DAYS. The batch is one
 * transaction, so the count and the move see the same last_seen.
 */
export async function markSeen(db: D1Database, account: string, day: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				bumpSql('active_users', `EXISTS (SELECT 1 FROM accounts WHERE id = ?3 AND ${NOT_SEEN})`)
			)
			.bind(day, 1, account),
		db
			.prepare(`UPDATE accounts SET last_seen = ?1 WHERE id = ?2 AND ${NOT_SEEN}`)
			.bind(day, account),
		db.prepare('DELETE FROM daily_stats WHERE day <= ?').bind(daysBefore(day, STATS_DAYS))
	]);
}

/** Counts `user`'s row budget refusing a write, once a day (usage.refused). */
export async function noteOverBudget(db: D1Database, user: string, day: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				bumpSql(
					'quota_hits',
					'EXISTS (SELECT 1 FROM usage WHERE user = ?3 AND day = ?1 AND refused = 0)'
				)
			)
			.bind(day, 1, user),
		db
			.prepare('UPDATE usage SET refused = 1 WHERE user = ?1 AND day = ?2 AND refused = 0')
			.bind(user, day)
	]);
}

/** The quotas row that remembers the new-account cap turned someone away today. */
const SIGNUPS_REFUSED = 'new-accounts-refused';

/** Counts the new-account cap refusing a sign-up, once a day. */
export async function noteSignupRefused(db: D1Database, day: string): Promise<void> {
	await db.batch([
		db
			.prepare(
				bumpSql('quota_hits', 'NOT EXISTS (SELECT 1 FROM quotas WHERE name = ?3 AND day = ?1)')
			)
			.bind(day, 1, SIGNUPS_REFUSED),
		db
			.prepare(
				`INSERT INTO quotas (name, day, n) VALUES (?1, ?2, 1)
				 ON CONFLICT (name) DO UPDATE SET day = excluded.day WHERE quotas.day <> excluded.day`
			)
			.bind(SIGNUPS_REFUSED, day)
	]);
}
