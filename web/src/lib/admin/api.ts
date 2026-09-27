// The admin panel's data: `GET /api/admin/overview` (worker/src/admin.ts, whose types these
// mirror). Only aggregates and metadata: short account ids, days, counts and sizes.

import { getJson } from '$lib/account/passkeys';

export const COLLECTIONS = ['board', 'unavailable', 'plays'] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

export interface DayStats {
	/** UTC day, "2026-10-03". */
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
	sessions: number;
	rows: Record<CollectionName, number>;
	bytes: number;
	/** Rows spent from today's write budget. */
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
	totals: { users: number; rows: number; bytes: number; dbBytes: number | null };
	/** Oldest first; days without activity may be missing. */
	days: DayStats[];
	users: AdminUser[];
}

export const loadOverview = () => getJson<Overview>('/api/admin/overview');
