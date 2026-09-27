// The site owner's admin panel (web: /admin): how many people use giggle and how much they
// store, to spot abuse. Only aggregates and metadata ever leave here: short account ids, dates,
// counts and sizes, never an item's key or contents.
//
//   GET /api/admin/overview → Overview (below)
//
// Only for accounts listed in ADMIN_ACCOUNTS (comma-separated ids; empty turns the panel off),
// with a session a passkey confirmed in the last five minutes (else 403 {error, reauth: true});
// in dev the dev identity may be listed, and needs no confirmation. Anyone else gets exactly what
// an unknown /api path gets (index.ts), so the panel's existence isn't given away. Read-only:
// fixed SELECTs, one batch per view.

import { MAX_SESSIONS, type Identity } from './auth';
import { COLLECTION_NAMES, COLLECTIONS, type CollectionName } from './collections';
import type { AuthConfig, Env } from './config';
import { MAX_PASSKEYS } from './passkeys';
import { daysBefore } from './stats';
import { DAILY_ROWS, dayOf } from './store';

export const ADMIN_PREFIX = '/api/admin/';
/** Days of daily_stats the overview sends: 13 whole weeks and today. */
export const OVERVIEW_DAYS = 98;
/** Characters of an account id the panel shows (after "u_"). */
const SHORT_ID = 8;

/** Whether `identity` may use the admin panel. */
export function isAdmin(env: Pick<Env, 'ADMIN_ACCOUNTS'>, identity: Identity): boolean {
	const admins = (env.ADMIN_ACCOUNTS ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
	return admins.includes(identity.user);
}

export function shortId(id: string): string {
	return id.replace(/^u_/, '').slice(0, SHORT_ID);
}

export interface DayStats {
	day: string;
	active_users: number;
	new_accounts: number;
	rows_written: number;
	quota_hits: number;
}

export interface AdminUser {
	/** The account id's first characters. */
	id: string;
	/** The signed-in admin's own account. */
	you: boolean;
	/** UTC days. */
	created: string;
	last_seen: string | null;
	passkey_used: string | null;
	passkeys: number;
	/** Signed-in browsers (unexpired sessions). */
	sessions: number;
	/** Rows per collection, tombstones included. */
	rows: Record<CollectionName, number>;
	/** Keys and item JSON, in bytes. */
	bytes: number;
	/** Rows spent from today's budget. */
	written_today: number;
}

export interface Overview {
	now: string;
	today: string;
	limits: {
		dailyRows: number;
		newAccountsPerDay: number;
		maxPasskeys: number;
		maxSessions: number;
		maxRows: Record<CollectionName, number>;
	};
	totals: {
		users: number;
		/** Synced rows and their bytes, everyone's together. */
		rows: number;
		bytes: number;
		/** The whole database, as D1 reports it. */
		dbBytes: number | null;
	};
	/** daily_stats for the last OVERVIEW_DAYS days, oldest first; days without a row are left out. */
	days: DayStats[];
	users: AdminUser[];
}

const ACCOUNTS = `
SELECT a.id, substr(a.created, 1, 10) AS created, a.last_seen,
  (SELECT count(*) FROM passkeys p WHERE p.account = a.id) AS passkeys,
  (SELECT substr(max(p.last_used), 1, 10) FROM passkeys p WHERE p.account = a.id) AS passkey_used,
  (SELECT count(*) FROM sessions s WHERE s.user = a.id AND s.expires > ?1) AS sessions,
  COALESCE((SELECT rows FROM usage u WHERE u.user = a.id AND u.day = ?2), 0) AS written_today
FROM accounts a
ORDER BY a.created`;

const COUNTS = 'SELECT user, collection, rows FROM sync_counts';

// Every synced row is read: admin views are rare (see README.md → Admin panel).
const SIZES = `
SELECT user, count(*) AS rows,
  sum(length(CAST(key AS BLOB)) + COALESCE(length(CAST(data AS BLOB)), 0)) AS bytes
FROM sync_items GROUP BY user`;

const DAYS = `
SELECT day, active_users, new_accounts, rows_written, quota_hits FROM daily_stats
WHERE day > ? ORDER BY day`;

type AccountRow = Omit<AdminUser, 'id' | 'you' | 'rows' | 'bytes'> & { id: string };

export async function overview(
	db: D1Database,
	config: AuthConfig,
	identity: Identity,
	now = Date.now()
): Promise<Overview> {
	const today = dayOf(now);
	const [accounts, counts, sizes, days] = await db.batch<Record<string, unknown>>([
		db.prepare(ACCOUNTS).bind(new Date(now).toISOString(), today),
		db.prepare(COUNTS),
		db.prepare(SIZES),
		db.prepare(DAYS).bind(daysBefore(today, OVERVIEW_DAYS))
	]);
	const rows = new Map<string, Record<CollectionName, number>>();
	for (const r of counts!.results as { user: string; collection: CollectionName; rows: number }[]) {
		let per = rows.get(r.user);
		if (!per) rows.set(r.user, (per = { board: 0, unavailable: 0, plays: 0 }));
		if (Object.hasOwn(per, r.collection)) per[r.collection] = r.rows;
	}
	const size = new Map<string, { rows: number; bytes: number }>();
	for (const r of sizes!.results as { user: string; rows: number; bytes: number }[]) {
		size.set(r.user, { rows: r.rows, bytes: r.bytes });
	}
	const users = (accounts!.results as AccountRow[]).map((a): AdminUser => ({
		...a,
		id: shortId(a.id),
		you: a.id === identity.user,
		rows: rows.get(a.id) ?? { board: 0, unavailable: 0, plays: 0 },
		bytes: size.get(a.id)?.bytes ?? 0
	}));
	let totalRows = 0;
	let totalBytes = 0;
	for (const s of size.values()) {
		totalRows += s.rows;
		totalBytes += s.bytes;
	}
	return {
		now: new Date(now).toISOString(),
		today,
		limits: {
			dailyRows: DAILY_ROWS,
			newAccountsPerDay: config.newAccountsPerDay,
			maxPasskeys: MAX_PASSKEYS,
			maxSessions: MAX_SESSIONS,
			maxRows: Object.fromEntries(
				COLLECTION_NAMES.map((name) => [name, COLLECTIONS[name].maxRows])
			) as Record<CollectionName, number>
		},
		totals: {
			users: users.length,
			rows: totalRows,
			bytes: totalBytes,
			dbBytes: accounts!.meta.size_after ?? null
		},
		days: days!.results as unknown as DayStats[],
		users
	};
}
