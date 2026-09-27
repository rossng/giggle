import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { daysBefore, markSeen } from '../src/stats';

const { MIGRATION_DB: db, TEST_MIGRATIONS: migrations } = env as unknown as {
	MIGRATION_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
};

it('counts accounts backfilled to today once, while preserving sign-ups', async () => {
	const index = migrations.findIndex((m) => m.name === '0006_admin_stats.sql');
	expect(index).toBeGreaterThan(0);
	await applyD1Migrations(db, migrations.slice(0, index));
	const { day } = (await db.prepare("SELECT date('now') AS day").first<{ day: string }>())!;
	const yesterday = daysBefore(day, 1);
	await db.batch([
		db
			.prepare('INSERT INTO accounts (id, created) VALUES (?, ?), (?, ?), (?, ?)')
			.bind(
				'u_new',
				`${day}T00:00:00Z`,
				'u_returning',
				`${yesterday}T00:00:00Z`,
				'u_inactive',
				`${yesterday}T00:00:00Z`
			),
		db
			.prepare(
				`INSERT INTO passkeys
			(id, account, public_key, counter, transports, device_type, backed_up, created, last_used)
			VALUES ('test-key', 'u_returning', X'00', 0, '[]', 'multiDevice', 1, ?1, ?2)`
			)
			.bind(`${yesterday}T00:00:00Z`, `${day}T00:00:00Z`)
	]);
	await applyD1Migrations(db, migrations.slice(index, index + 1));
	const stats = () =>
		db
			.prepare('SELECT active_users, new_accounts FROM daily_stats WHERE day = ?')
			.bind(day)
			.first();
	expect(await stats()).toEqual({ active_users: 2, new_accounts: 1 });
	// Both kinds of backfilled account are already counted; repeated activity adds nothing.
	await markSeen(db, 'u_new', day);
	await markSeen(db, 'u_returning', day);
	expect(await stats()).toEqual({ active_users: 2, new_accounts: 1 });
	// An older account becomes active after migration and is counted exactly once.
	await markSeen(db, 'u_inactive', day);
	await markSeen(db, 'u_inactive', day);
	expect(await stats()).toEqual({ active_users: 3, new_accounts: 1 });
});
