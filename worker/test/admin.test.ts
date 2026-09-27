import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Overview } from '../src/admin';
import { markSeen, noteSignupRefused, STATS_DAYS } from '../src/stats';
import { DAILY_ROWS, dayOf } from '../src/store';
import { SoftAuthenticator } from './authenticator';
import { cookieFrom, post, reauth, signUp, stale } from './ceremonies';
import { call, callJson, MBID, newUser } from './helpers';

const DB = (env as unknown as { DB: D1Database }).DB;
const OVERVIEW = '/api/admin/overview';
const today = () => dayOf(Date.now());

const PROD = {
	ENVIRONMENT: 'production',
	PASSKEY_RP_ID: 'giggle.example',
	SITE_ORIGINS: 'https://giggle.example'
};

/** A new passkey account made an admin: its id, session cookie, authenticator and env. */
async function newAdmin() {
	const auth = new SoftAuthenticator();
	const res = await signUp(auth);
	const { user } = await res.json<{ user: string }>();
	const options = { env: { ADMIN_ACCOUNTS: `someone-else, ${user}` } };
	return { user, auth, cookie: cookieFrom(res), options };
}

async function stat(column: string, day = today()): Promise<number> {
	const row = await DB.prepare(`SELECT ${column} AS n FROM daily_stats WHERE day = ?`)
		.bind(day)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function lastSeen(user: string): Promise<string | null | undefined> {
	const row = await DB.prepare('SELECT last_seen FROM accounts WHERE id = ?')
		.bind(user)
		.first<{ last_seen: string | null }>();
	return row?.last_seen;
}

/** Status and body, to compare with an unknown path's. */
async function answer(path: string, options: Parameters<typeof call>[1] = {}) {
	const res = await call(path, options);
	return { status: res.status, body: await res.text(), type: res.headers.get('Content-Type') };
}

describe('admin panel access', () => {
	it('answers anyone but an admin exactly like an unknown path', async () => {
		const passkeyUser = cookieFrom(await signUp(new SoftAuthenticator()));
		const cases: Parameters<typeof call>[1][] = [
			{}, // signed out
			{ devUser: newUser() }, // not an admin
			{ headers: { Cookie: passkeyUser } }, // not an admin
			// The dev identity, listed, in production: not signed in at all there.
			{
				devUser: 'alice@example.test',
				origin: 'https://giggle.example',
				env: { ...PROD, ADMIN_ACCOUNTS: 'alice@example.test' }
			},
			// Listed, but the panel is off.
			{ devUser: 'alice@example.test', env: { ADMIN_ACCOUNTS: '' } },
			{ devUser: 'alice@example.test', env: { ADMIN_ACCOUNTS: ' , ' } }
		];
		for (const options of cases) {
			const unknown = await answer('/api/nope', options);
			expect(unknown.status).toBeOneOf([401, 404]);
			for (const path of [OVERVIEW, '/api/admin/', '/api/admin/nope']) {
				expect(await answer(path, options)).toEqual(unknown);
			}
			// Other methods too.
			const put = { ...options, method: 'PUT', body: {} };
			expect(await answer(OVERVIEW, put)).toEqual(await answer('/api/nope', put));
		}
		expect((await call(OVERVIEW, { devUser: newUser() })).status).toBe(404);
		expect((await call(OVERVIEW)).status).toBe(401);
	});

	it('lets the dev identity in, in dev, without a passkey', async () => {
		const res = await call(OVERVIEW, { devUser: 'alice@example.test' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
		expect((await call('/api/admin/nope', { devUser: 'alice@example.test' })).status).toBe(404);
		const post = await call(OVERVIEW, { method: 'POST', body: {}, devUser: 'alice@example.test' });
		expect(post.status).toBe(405);
	});

	it('asks an admin to confirm with a passkey first', async () => {
		const admin = await newAdmin();
		const headers = { Cookie: admin.cookie };
		// Signing up just now counts as a confirmation.
		expect((await call(OVERVIEW, { headers, ...admin.options })).status).toBe(200);
		await stale(admin.cookie);
		const needs = await callJson(OVERVIEW, { headers, ...admin.options });
		expect(needs).toEqual({
			status: 403,
			body: { error: expect.stringMatching(/confirm/), reauth: true }
		});
		expect((await reauth(admin.cookie, admin.auth)).status).toBe(200);
		expect((await call(OVERVIEW, { headers, ...admin.options })).status).toBe(200);
	});

	it('is rate limited per account', async () => {
		const admin = await newAdmin();
		const get = () => call(OVERVIEW, { headers: { Cookie: admin.cookie }, ...admin.options });
		for (let i = 0; i < 10; i++) expect((await get()).status).toBe(200);
		const over = await get();
		expect(over.status).toBe(429);
		expect(over.headers.get('Retry-After')).toBe('60');
	});
});

describe('admin overview', () => {
	it('shows counts and sizes, never what anyone stored', async () => {
		const admin = await newAdmin();
		const other = cookieFrom(await signUp(new SoftAuthenticator()));
		const { user: otherId } = await callJson<{ user: string }>('/api/me', {
			headers: { Cookie: other }
		}).then((r) => r.body);
		const now = new Date().toISOString();
		const secrets = ['Secret Band Xyzzy', 'name:secret band xyzzy', 'Lisbon with Plugh'];
		const puts: [string, unknown[]][] = [
			[
				'/api/board',
				[
					{ key: 'name:secret band xyzzy', state: 'go', name: 'Secret Band Xyzzy', at: now },
					{ key: MBID(7), state: 'nope', name: 'Artist', at: now }
				]
			],
			['/api/unavailable', [{ key: '2026-10-03', label: 'Lisbon with Plugh', at: now }]],
			['/api/plays', [{ key: MBID(7), at: now }]]
		];
		for (const [path, items] of puts) {
			const put = await call(path, { method: 'PUT', body: { items }, headers: { Cookie: other } });
			expect(put.status).toBe(200);
		}

		const res = await call(OVERVIEW, { headers: { Cookie: admin.cookie }, ...admin.options });
		const text = await res.text();
		for (const secret of [...secrets, '2026-10-03', MBID(7), otherId, admin.user]) {
			expect(text).not.toContain(secret);
		}
		const body = JSON.parse(text) as Overview;
		const row = body.users.find((u) => otherId.startsWith(`u_${u.id}`));
		expect(row).toEqual({
			id: otherId.slice(2, 10),
			you: false,
			created: today(),
			last_seen: today(),
			passkey_used: null,
			passkeys: 1,
			sessions: 1,
			rows: { board: 2, unavailable: 1, plays: 1 },
			bytes: expect.any(Number),
			written_today: 4
		});
		expect(row!.bytes).toBeGreaterThan(50);
		expect(row!.bytes).toBeLessThan(500);
		expect(body.users.find((u) => u.you)?.id).toBe(admin.user.slice(2, 10));
		expect(body.totals.users).toBe(body.users.length);
		expect(body.totals.rows).toBeGreaterThanOrEqual(4);
		expect(body.totals.dbBytes).toBeGreaterThan(0);
		expect(body.limits).toMatchObject({ dailyRows: DAILY_ROWS, maxPasskeys: 20, maxSessions: 50 });
		expect(body.limits.maxRows).toEqual({ board: 20_000, unavailable: 2000, plays: 10_000 });
		expect(body.days.at(-1)).toMatchObject({ day: today() });
		// Only the keys the panel knows: nothing else slips in.
		expect(Object.keys(body).sort()).toEqual(
			['days', 'limits', 'now', 'today', 'totals', 'users'].sort()
		);
	});
});

describe('activity', () => {
	it('moves last_seen and counts an account active once a day', async () => {
		const day = '2031-02-03';
		const [a, b] = [`u_seen-a-${crypto.randomUUID()}`, `u_seen-b-${crypto.randomUUID()}`];
		for (const id of [a, b]) {
			await DB.prepare('INSERT INTO accounts (id, created) VALUES (?, ?)').bind(id, day).run();
		}
		await Promise.all([markSeen(DB, a, day), markSeen(DB, a, day), markSeen(DB, a, day)]);
		await markSeen(DB, a, day);
		expect(await stat('active_users', day)).toBe(1);
		expect(await lastSeen(a)).toBe(day);
		await markSeen(DB, b, day);
		expect(await stat('active_users', day)).toBe(2);
		// Never backwards.
		await markSeen(DB, a, '2031-02-01');
		expect(await lastSeen(a)).toBe(day);
		expect(await stat('active_users', '2031-02-01')).toBe(0);
		await markSeen(DB, a, '2031-02-04');
		expect(await lastSeen(a)).toBe('2031-02-04');
		expect(await stat('active_users', '2031-02-04')).toBe(1);
		// Unknown accounts (the dev identity has none) aren't counted.
		await markSeen(DB, 'nobody@example.test', '2031-02-04');
		expect(await stat('active_users', '2031-02-04')).toBe(1);
	});

	it('follows signed-in requests, one write a day', async () => {
		const res = await signUp(new SoftAuthenticator());
		const { user } = await res.json<{ user: string }>();
		const headers = { Cookie: cookieFrom(res) };
		expect(await lastSeen(user)).toBeNull();
		const before = await stat('active_users');
		expect((await call('/api/me', { headers })).status).toBe(200);
		expect(await lastSeen(user)).toBe(today());
		await Promise.all([1, 2, 3].map(() => call('/api/board', { headers })));
		expect(await stat('active_users')).toBe(before + 1);
		// Yesterday's account comes back today.
		await DB.prepare("UPDATE accounts SET last_seen = '2026-01-01' WHERE id = ?").bind(user).run();
		await call('/api/me', { headers });
		expect(await lastSeen(user)).toBe(today());
		expect(await stat('active_users')).toBe(before + 2);
	});

	it(`keeps ${STATS_DAYS} days`, async () => {
		const day = '2032-06-01';
		const id = `u_prune-${crypto.randomUUID()}`;
		await DB.prepare('INSERT INTO accounts (id, created) VALUES (?, ?)').bind(id, day).run();
		const old = ['2031-04-27', '2031-04-28', '2031-04-29'];
		for (const d of old) {
			await DB.prepare('INSERT OR REPLACE INTO daily_stats (day, new_accounts) VALUES (?, 1)')
				.bind(d)
				.run();
		}
		await markSeen(DB, id, day);
		const { results } = await DB.prepare(
			"SELECT day FROM daily_stats WHERE day BETWEEN '2031-04-01' AND '2031-04-30' ORDER BY day"
		).all<{ day: string }>();
		// 2032-06-01 is day 400 after 2031-04-28: the day after is the oldest kept.
		expect(results.map((r) => r.day)).toEqual(['2031-04-29']);
	});
});

describe('daily counts', () => {
	it('count sign-ups', async () => {
		const before = await stat('new_accounts');
		expect((await signUp(new SoftAuthenticator())).status).toBe(200);
		expect((await signUp(new SoftAuthenticator())).status).toBe(200);
		expect(await stat('new_accounts')).toBe(before + 2);
	});

	it('count rows written, and an account running out of its budget once', async () => {
		const user = newUser();
		const put = (n: number, first = 0) =>
			call('/api/board', {
				method: 'PUT',
				devUser: user,
				body: {
					items: Array.from({ length: n }, (_, i) => ({
						key: MBID(first + i),
						state: 'go',
						name: 'Artist',
						at: new Date().toISOString()
					}))
				}
			});
		const written = await stat('rows_written');
		expect((await put(3)).status).toBe(200);
		expect(await stat('rows_written')).toBe(written + 3);

		const hits = await stat('quota_hits');
		await DB.prepare('UPDATE usage SET rows = ? WHERE user = ?')
			.bind(DAILY_ROWS - 1, user)
			.run();
		for (let i = 0; i < 3; i++) expect((await put(2, 10)).status).toBe(429);
		expect(await stat('quota_hits')).toBe(hits + 1);
		expect(await stat('rows_written')).toBe(written + 3);
		// What's left still goes through.
		expect((await put(1, 20)).status).toBe(200);
		expect(await stat('rows_written')).toBe(written + 4);
		// A new day starts again.
		await DB.prepare("UPDATE usage SET day = '2026-01-01' WHERE user = ?").bind(user).run();
		expect((await put(1, 30)).status).toBe(200);
		const usage = await DB.prepare('SELECT rows, refused FROM usage WHERE user = ?')
			.bind(user)
			.first();
		expect(usage).toEqual({ rows: 1, refused: 0 });
	});

	it('count the new-account cap turning people away, once a day', async () => {
		const day = '2033-03-03';
		await Promise.all([noteSignupRefused(DB, day), noteSignupRefused(DB, day)]);
		await noteSignupRefused(DB, day);
		expect(await stat('quota_hits', day)).toBe(1);
		await noteSignupRefused(DB, '2033-03-04');
		expect(await stat('quota_hits', '2033-03-04')).toBe(1);

		// Through the API: a full day refuses sign-ups, and it's noted for today.
		const full = { env: { NEW_ACCOUNTS_PER_DAY: '0' } };
		expect((await post('/api/passkey/register/options', {}, full)).status).toBe(429);
		const refused = await DB.prepare(
			"SELECT day FROM quotas WHERE name = 'new-accounts-refused'"
		).first<{ day: string }>();
		expect(refused?.day).toBe(today());
		expect(await stat('quota_hits')).toBeGreaterThanOrEqual(1);
	});
});

describe('deleting an account', () => {
	it('leaves nothing with its id in any table', async () => {
		const admin = await newAdmin();
		const now = new Date().toISOString();
		await call('/api/board', {
			method: 'PUT',
			body: { items: [{ key: MBID(1), state: 'go', name: 'Artist', at: now }] },
			headers: { Cookie: admin.cookie }
		});
		expect(await lastSeen(admin.user)).toBe(today());
		const gone = await call('/api/account', {
			method: 'DELETE',
			headers: { Cookie: admin.cookie }
		});
		expect(gone.status).toBe(200);

		const { results: tables } = await DB.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table'
			 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`
		).all<{ name: string }>();
		expect(tables.map((t) => t.name)).toContain('daily_stats');
		for (const { name } of tables) {
			const { results: columns } = await DB.prepare('SELECT name FROM pragma_table_info(?)')
				.bind(name)
				.all<{ name: string }>();
			for (const column of columns) {
				const row = await DB.prepare(
					`SELECT count(*) AS n FROM "${name}" WHERE CAST("${column.name}" AS TEXT) LIKE ?`
				)
					.bind(`%${admin.user.slice(2)}%`)
					.first<{ n: number }>();
				expect([name, column.name, row?.n]).toEqual([name, column.name, 0]);
			}
		}
	});
});
