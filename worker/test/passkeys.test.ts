import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { b64url, SoftAuthenticator } from './authenticator';
import { MAX_SESSIONS } from '../src/auth';
import { MAX_PASSKEYS } from '../src/passkeys';
import { call, callJson, DEV_ENV } from './helpers';

/** The id of an authenticator's (first) passkey. */
const passkeyId = (auth: SoftAuthenticator, n = 0) => b64url(auth.credentials[n]!.id);

const DB = (env as unknown as { DB: D1Database }).DB;

const PROD = {
	ENVIRONMENT: 'production',
	PASSKEY_RP_ID: 'giggle.example',
	SITE_ORIGINS: 'https://giggle.example'
};

/** What the options endpoints return (registration and login options, loosely). */
interface Json {
	ticket: string;
	options: {
		challenge: string;
		user: { id: string };
		rp: { id?: string };
		rpId?: string;
		excludeCredentials?: { id: string }[];
	};
}

/** The session cookie a response set, as a Cookie header value. */
function cookieFrom(res: Response): string {
	const set = res.headers.getSetCookie()[0] ?? '';
	expect(set).toMatch(/^giggle_session_dev=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
	return set.split(';')[0]!;
}

async function post(path: string, body: unknown, options: Parameters<typeof call>[1] = {}) {
	return call(path, { method: 'POST', body, ...options });
}

async function signUp(auth: SoftAuthenticator, options: Parameters<typeof call>[1] = {}) {
	const start = await (await post('/api/passkey/register/options', {}, options)).json<Json>();
	const response = await auth.register(start.options);
	return post('/api/passkey/register/verify', { ticket: start.ticket, response }, options);
}

async function signIn(auth: SoftAuthenticator, options: Parameters<typeof call>[1] = {}) {
	const start = await (await post('/api/passkey/login/options', {}, options)).json<Json>();
	const response = await auth.login(start.options);
	return post('/api/passkey/login/verify', { ticket: start.ticket, response }, options);
}

describe('passkeys', () => {
	it('signing up makes an account and a session', async () => {
		const auth = new SoftAuthenticator();
		const res = await signUp(auth);
		expect(res.status).toBe(200);
		const body = await res.json<{ user: string; via: string }>();
		expect(body.user).toMatch(/^u_[0-9a-f-]{36}$/);
		expect(body.via).toBe('passkey');
		expect(res.headers.get('Set-Cookie')).not.toMatch(/Secure/); // http://localhost
		const me = await callJson('/api/me', { headers: { Cookie: cookieFrom(res) } });
		expect(me).toEqual({ status: 200, body: { user: body.user, via: 'passkey', passkeys: 1 } });
	});

	it('signing in with the passkey reaches the same account and its data, on another device', async () => {
		const auth = new SoftAuthenticator();
		const first = await signUp(auth);
		const { user } = await first.json<{ user: string }>();
		const item = { key: 'name:nobu', state: 'go', name: 'Nobu', at: new Date().toISOString() };
		const put = await call('/api/board', {
			method: 'PUT',
			body: { items: [item] },
			headers: { Cookie: cookieFrom(first) }
		});
		expect(put.status).toBe(200);

		const second = await signIn(auth);
		expect(second.status).toBe(200);
		expect((await second.json<{ user: string }>()).user).toBe(user);
		const board = await callJson<{ items: { key: string }[] }>('/api/board', {
			headers: { Cookie: cookieFrom(second) }
		});
		expect(board.body.items.map((i) => i.key)).toEqual(['name:nobu']);
	});

	it('a signed-in account adds a passkey for a new device', async () => {
		const phone = new SoftAuthenticator();
		const res = await signUp(phone);
		const cookie = cookieFrom(res);
		const laptop = new SoftAuthenticator();
		const start = await (
			await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
		).json<{
			ticket: string;
			options: { excludeCredentials: { id: string }[] } & Json['options'];
		}>();
		// The authenticator is told which passkeys the account has, so it won't make a duplicate.
		expect(start.options.excludeCredentials).toHaveLength(1);
		const response = await laptop.register(start.options);
		const added = await post(
			'/api/passkey/register/verify',
			{ ticket: start.ticket, response },
			{ headers: { Cookie: cookie } }
		);
		expect(added.status).toBe(200);
		const me = await callJson<{ passkeys: number }>('/api/me', {
			headers: { Cookie: cookieFrom(await signIn(laptop)) }
		});
		expect(me.body.passkeys).toBe(2);
	});

	it('a ticket works once', async () => {
		const auth = new SoftAuthenticator();
		await signUp(auth);
		const start = await (await post('/api/passkey/login/options', {})).json<Json>();
		const response = await auth.login(start.options);
		const ok = await post('/api/passkey/login/verify', { ticket: start.ticket, response });
		expect(ok.status).toBe(200);
		const again = await post('/api/passkey/login/verify', { ticket: start.ticket, response });
		expect(again.status).toBe(400);
	});

	it('refuses a ceremony from another origin, or answering another challenge', async () => {
		const evil = new SoftAuthenticator('https://evil.example');
		expect((await signUp(evil)).status).toBe(400);

		const auth = new SoftAuthenticator();
		await signUp(auth);
		const a = await (await post('/api/passkey/login/options', {})).json<Json>();
		const b = await (await post('/api/passkey/login/options', {})).json<Json>();
		const response = await auth.login(a.options);
		expect((await post('/api/passkey/login/verify', { ticket: b.ticket, response })).status).toBe(
			401
		);
	});

	it("refuses a passkey giggle doesn't know", async () => {
		const stranger = new SoftAuthenticator();
		const other = await (await post('/api/passkey/register/options', {})).json<Json>();
		await stranger.register(other.options); // made, but never sent to the server
		expect((await signIn(stranger)).status).toBe(401);
	});

	it('signing out ends the session', async () => {
		const res = await signUp(new SoftAuthenticator());
		const cookie = cookieFrom(res);
		const out = await post('/api/logout', {}, { headers: { Cookie: cookie } });
		expect(out.headers.getSetCookie()).toEqual([
			'giggle_session_dev=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
			// The cookie's name and path before __Host-.
			'giggle_session=; Path=/api; Max-Age=0'
		]);
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
	});

	it('an expired session is refused', async () => {
		const res = await signUp(new SoftAuthenticator());
		const cookie = cookieFrom(res);
		await (env as unknown as { DB: D1Database }).DB.prepare(
			"UPDATE sessions SET expires = '2000-01-01T00:00:00.000Z'"
		).run();
		const me = await callJson('/api/me', { headers: { Cookie: cookie } });
		expect(me.status).toBe(401);
	});

	it('works in production on the site origin only, with a Secure cookie, and no dev identity', async () => {
		const auth = new SoftAuthenticator('https://giggle.example', 'giggle.example');
		const options = { origin: 'https://giggle.example', env: PROD };
		const res = await signUp(auth, options);
		expect(res.status).toBe(200);
		const [session] = res.headers.getSetCookie();
		expect(session).toMatch(
			/^__Host-giggle_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/
		);
		const cookie = session!.split(';')[0]!;
		expect((await call('/api/me', { ...options, headers: { Cookie: cookie } })).status).toBe(200);
		// The dev cookie's name means nothing here.
		const devName = cookie.replace('__Host-giggle_session', 'giggle_session_dev');
		expect((await call('/api/me', { ...options, headers: { Cookie: devName } })).status).toBe(401);
		const me = await call('/api/me', { ...options, devUser: 'alice@example.test' });
		expect(me.status).toBe(401);
		expect((await call('/api/dev/login?as=alice@example.test', options)).status).toBe(401);
		expect(DEV_ENV.ENVIRONMENT).toBe('dev');
	});

	it('only POST', async () => {
		expect((await call('/api/passkey/login/options')).status).toBe(405);
		expect((await call('/api/logout')).status).toBe(405);
		expect((await call('/api/logout-everywhere')).status).toBe(401); // signed out
	});

	it('signing out needs a JSON request, so a cross-site form cannot do it', async () => {
		const cookie = cookieFrom(await signUp(new SoftAuthenticator()));
		const form = await call('/api/logout', {
			method: 'POST',
			body: '',
			headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }
		});
		expect(form.status).toBe(415);
		expect(form.headers.get('Set-Cookie')).toBeNull();
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(200);
	});

	it('answers with nosniff JSON', async () => {
		const res = await call('/api/me');
		expect(res.status).toBe(401);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
	});
});

describe('sessions', () => {
	async function sessionsOf(user: string) {
		const { results } = await DB.prepare('SELECT token_hash, expires FROM sessions WHERE user = ?')
			.bind(user)
			.all<{ token_hash: string; expires: string }>();
		return results;
	}

	it('signing in deletes expired sessions and keeps only the newest', async () => {
		const auth = new SoftAuthenticator();
		const first = await signUp(auth);
		const { user } = await first.json<{ user: string }>();
		const firstCookie = cookieFrom(first);
		// A pile of old sessions: some expired, the rest older than the new one.
		const stmts = [];
		for (let i = 0; i < MAX_SESSIONS + 10; i++) {
			const created = new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString();
			const expires = i < 5 ? '2021-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z';
			stmts.push(
				DB.prepare(
					'INSERT INTO sessions (token_hash, user, created, expires) VALUES (?, ?, ?, ?)'
				).bind(`old-${user}-${i}`, user, created, expires)
			);
		}
		await DB.batch(stmts);
		const second = await signIn(auth);
		expect(second.status).toBe(200);
		const left = await sessionsOf(user);
		expect(left).toHaveLength(MAX_SESSIONS);
		expect(left.every((s) => Date.parse(s.expires) > Date.now())).toBe(true);
		// The two real sessions are the newest, so both survive.
		expect((await call('/api/me', { headers: { Cookie: firstCookie } })).status).toBe(200);
		expect((await call('/api/me', { headers: { Cookie: cookieFrom(second) } })).status).toBe(200);
	});

	it('signing out everywhere ends every session of the account, and only that account', async () => {
		const auth = new SoftAuthenticator();
		const a = cookieFrom(await signUp(auth));
		const b = cookieFrom(await signIn(auth));
		const stranger = cookieFrom(await signUp(new SoftAuthenticator()));
		const out = await post('/api/logout-everywhere', {}, { headers: { Cookie: a } });
		expect(out.status).toBe(200);
		expect(out.headers.get('Set-Cookie')).toMatch(/^giggle_session_dev=; .*Max-Age=0/);
		expect((await call('/api/me', { headers: { Cookie: a } })).status).toBe(401);
		expect((await call('/api/me', { headers: { Cookie: b } })).status).toBe(401);
		expect((await call('/api/me', { headers: { Cookie: stranger } })).status).toBe(200);
		// Also JSON only.
		const form = await call('/api/logout-everywhere', {
			method: 'POST',
			body: '',
			headers: { Cookie: stranger, 'Content-Type': 'text/plain' }
		});
		expect(form.status).toBe(415);
	});
});

describe('managing passkeys', () => {
	interface Listed {
		passkeys: {
			id: string;
			created: string;
			last_used: string | null;
			device_type: string;
			backed_up: boolean;
			transports: string[];
		}[];
	}

	async function addDevice(cookie: string, auth: SoftAuthenticator) {
		const start = await (
			await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
		).json<Json>();
		const response = await auth.register(start.options);
		return post(
			'/api/passkey/register/verify',
			{ ticket: start.ticket, response },
			{ headers: { Cookie: cookie } }
		);
	}

	it('lists the account’s passkeys without their keys, and removes all but the last', async () => {
		const phone = new SoftAuthenticator();
		const phoneCookie = cookieFrom(await signUp(phone));
		const laptop = new SoftAuthenticator();
		expect((await addDevice(phoneCookie, laptop)).status).toBe(200);
		const cookie = cookieFrom(await signIn(laptop));

		const list = await callJson<Listed>('/api/passkeys', { headers: { Cookie: cookie } });
		expect(list.status).toBe(200);
		expect(list.body.passkeys).toHaveLength(2);
		for (const p of list.body.passkeys) {
			expect(Object.keys(p).sort()).toEqual(
				['backed_up', 'created', 'device_type', 'id', 'last_used', 'transports'].sort()
			);
		}
		expect(list.body.passkeys.filter((p) => p.last_used)).toHaveLength(1);
		expect(list.body.passkeys[0]).toMatchObject({ device_type: 'multiDevice', backed_up: true });

		// Someone else can't see or remove them.
		const other = cookieFrom(await signUp(new SoftAuthenticator()));
		const theirs = await callJson<Listed>('/api/passkeys', { headers: { Cookie: other } });
		expect(theirs.body.passkeys).toHaveLength(1);
		const first = passkeyId(phone);
		const second = passkeyId(laptop);
		expect(list.body.passkeys.map((p) => p.id).sort()).toEqual([first, second].sort());
		const del = (id: string, c = cookie) =>
			call(`/api/passkeys/${id}`, { method: 'DELETE', headers: { Cookie: c } });
		expect((await del(first, other)).status).toBe(404);

		// Removing the phone's passkey ends the phone's session, not the laptop's.
		const removed = await del(first);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true, signedOut: false });
		expect(removed.headers.get('Set-Cookie')).toBeNull();
		expect((await call('/api/me', { headers: { Cookie: phoneCookie } })).status).toBe(401);
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(200);
		expect((await del(first)).status).toBe(404);
		const last = await del(second);
		expect(last.status).toBe(409);
		expect(await last.json()).toEqual({ error: expect.stringMatching(/only passkey/) });
		const after = await callJson<Listed>('/api/passkeys', { headers: { Cookie: cookie } });
		expect(after.body.passkeys.map((p) => p.id)).toEqual([second]);
		expect((await del('not!an!id')).status).toBe(404);
		expect(
			(await call('/api/passkeys', { method: 'POST', body: {}, headers: { Cookie: cookie } }))
				.status
		).toBe(405);
		expect((await call(`/api/passkeys/${second}`, { headers: { Cookie: cookie } })).status).toBe(
			405
		);
	});

	it('the dev identity has no passkeys', async () => {
		const list = await callJson<Listed>('/api/passkeys', { devUser: 'dev@example.test' });
		expect(list).toEqual({ status: 200, body: { passkeys: [] } });
	});

	it('never lets outstanding tickets take an account over the passkey limit', async () => {
		const res = await signUp(new SoftAuthenticator());
		const { user } = await res.json<{ user: string }>();
		const cookie = cookieFrom(res);
		// One short of the limit.
		const stmts = [];
		for (let i = 1; i < MAX_PASSKEYS - 1; i++) {
			stmts.push(
				DB.prepare(
					`INSERT INTO passkeys (id, account, public_key, counter, transports, device_type, backed_up, created)
					 VALUES (?, ?, x'00', 0, '[]', 'singleDevice', 0, '2026-01-01T00:00:00.000Z')`
				).bind(`fake-${user}-${i}`, user)
			);
		}
		await DB.batch(stmts);
		// Two tickets while there's room for one more…
		const tickets = [];
		for (let i = 0; i < 2; i++) {
			tickets.push(
				await (
					await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
				).json<Json>()
			);
		}
		const results = [];
		for (const t of tickets) {
			const response = await new SoftAuthenticator().register(t.options);
			const verify = await post(
				'/api/passkey/register/verify',
				{ ticket: t.ticket, response },
				{ headers: { Cookie: cookie } }
			);
			results.push(verify.status);
		}
		// …only one is used.
		expect(results).toEqual([200, 409]);
		const me = await callJson<{ passkeys: number }>('/api/me', { headers: { Cookie: cookie } });
		expect(me.body.passkeys).toBe(MAX_PASSKEYS);
		expect(
			(await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })).status
		).toBe(409);
	});
});

describe('confirming it’s you', () => {
	/** Makes the session's last passkey confirmation older than FRESH_MS. */
	async function stale(cookie: string) {
		const token = decodeURIComponent(cookie.split('=')[1]!);
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
		await DB.prepare(
			"UPDATE sessions SET verified_at = '2026-01-01T00:00:00.000Z' WHERE token_hash = ?"
		)
			.bind(b64url(new Uint8Array(digest)))
			.run();
	}

	async function reauth(cookie: string, auth: SoftAuthenticator) {
		const start = await (
			await post('/api/passkey/reauth/options', {}, { headers: { Cookie: cookie } })
		).json<Json>();
		const response = await auth.login(start.options);
		return post(
			'/api/passkey/reauth/verify',
			{ ticket: start.ticket, response },
			{ headers: { Cookie: cookie } }
		);
	}

	async function addDevice(cookie: string, auth: SoftAuthenticator) {
		const start = await (
			await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
		).json<Json>();
		return post(
			'/api/passkey/register/verify',
			{ ticket: start.ticket, response: await auth.register(start.options) },
			{ headers: { Cookie: cookie } }
		);
	}

	const del = (path: string, cookie: string) =>
		call(path, { method: 'DELETE', headers: { Cookie: cookie } });

	it('adding or removing a passkey, or deleting the account, needs a recent confirmation', async () => {
		const phone = new SoftAuthenticator();
		const cookie = cookieFrom(await signUp(phone));
		const laptop = new SoftAuthenticator();
		const early = await (
			await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
		).json<Json>();
		await stale(cookie);

		const needs = { error: expect.stringMatching(/confirm/), reauth: true };
		const options = await post(
			'/api/passkey/register/options',
			{},
			{ headers: { Cookie: cookie } }
		);
		expect(options.status).toBe(403);
		expect(await options.json()).toEqual(needs);
		// A ticket from before goes stale with the session.
		const late = await post(
			'/api/passkey/register/verify',
			{ ticket: early.ticket, response: await laptop.register(early.options) },
			{ headers: { Cookie: cookie } }
		);
		expect(late.status).toBe(403);
		const removing = await del(`/api/passkeys/${passkeyId(phone)}`, cookie);
		expect(removing.status).toBe(403);
		expect(await removing.json()).toEqual(needs);
		const deleting = await del('/api/account', cookie);
		expect(deleting.status).toBe(403);
		expect(await deleting.json()).toEqual(needs);
		// Still signed in: only these need it.
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(200);

		// The account's own passkey confirms the session, and then it works.
		const confirmed = await reauth(cookie, phone);
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).toEqual({ ok: true });
		expect(confirmed.headers.get('Set-Cookie')).toBeNull();
		const added = await addDevice(cookie, new SoftAuthenticator());
		expect(added.status).toBe(200);
		// Adding a device keeps this browser's session: no new cookie.
		expect(await added.json()).toMatchObject({ created: false });
		expect(added.headers.get('Set-Cookie')).toBeNull();
		expect((await callJson('/api/me', { headers: { Cookie: cookie } })).body).toMatchObject({
			passkeys: 2
		});
	});

	it('offers and accepts only the account’s own passkeys', async () => {
		const mine = new SoftAuthenticator();
		const cookie = cookieFrom(await signUp(mine));
		const theirs = new SoftAuthenticator();
		const otherCookie = cookieFrom(await signUp(theirs));
		const start = await (
			await post('/api/passkey/reauth/options', {}, { headers: { Cookie: cookie } })
		).json<Json & { options: { allowCredentials: { id: string }[] } }>();
		expect(start.options.allowCredentials.map((c) => c.id)).toEqual([passkeyId(mine)]);
		const refused = await post(
			'/api/passkey/reauth/verify',
			{ ticket: start.ticket, response: await theirs.login(start.options) },
			{ headers: { Cookie: cookie } }
		);
		expect(refused.status).toBe(401);

		// Someone else's ticket is no good in this session…
		const theirStart = await (
			await post('/api/passkey/reauth/options', {}, { headers: { Cookie: otherCookie } })
		).json<Json>();
		const wrong = await post(
			'/api/passkey/reauth/verify',
			{ ticket: theirStart.ticket, response: await mine.login(theirStart.options) },
			{ headers: { Cookie: cookie } }
		);
		expect(wrong.status).toBe(400);
		// …nor is a sign-in ticket; and signed out there's nothing to confirm.
		const login = await (await post('/api/passkey/login/options', {})).json<Json>();
		const swapped = await post(
			'/api/passkey/reauth/verify',
			{ ticket: login.ticket, response: await mine.login(login.options) },
			{ headers: { Cookie: cookie } }
		);
		expect(swapped.status).toBe(400);
		expect((await post('/api/passkey/reauth/options', {})).status).toBe(401);
	});

	it('removing the passkey that confirmed this session signs this browser out', async () => {
		const phone = new SoftAuthenticator();
		const cookie = cookieFrom(await signUp(phone));
		const laptop = new SoftAuthenticator();
		expect((await addDevice(cookie, laptop)).status).toBe(200);
		const res = await del(`/api/passkeys/${passkeyId(phone)}`, cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, signedOut: true });
		expect(res.headers.get('Set-Cookie')).toMatch(/^giggle_session_dev=; .*Max-Age=0/);
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
		const again = cookieFrom(await signIn(laptop));
		expect((await callJson('/api/me', { headers: { Cookie: again } })).body).toMatchObject({
			passkeys: 1
		});
	});

	it('signing out everywhere also drops passkeys that were being added', async () => {
		const cookie = cookieFrom(await signUp(new SoftAuthenticator()));
		const start = await (
			await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } })
		).json<Json>();
		const response = await new SoftAuthenticator().register(start.options);
		const out = await post('/api/logout-everywhere', {}, { headers: { Cookie: cookie } });
		expect(out.status).toBe(200);
		const late = await post(
			'/api/passkey/register/verify',
			{ ticket: start.ticket, response },
			{ headers: { Cookie: cookie } }
		);
		expect(late.status).toBe(400);
	});

	it('deleting the account deletes everything giggle keeps about it', async () => {
		const phone = new SoftAuthenticator();
		const res = await signUp(phone);
		const { user } = await res.json<{ user: string }>();
		const cookie = cookieFrom(res);
		const other = cookieFrom(await signIn(phone));
		const now = new Date().toISOString();
		const puts: [string, unknown[]][] = [
			['/api/board', [{ key: 'name:nobu', state: 'go', name: 'Nobu', at: now }]],
			['/api/unavailable', [{ key: '2026-10-03', at: now }]],
			['/api/plays', [{ key: 'name:nobu', at: now }]]
		];
		for (const [path, items] of puts) {
			const put = await call(path, { method: 'PUT', body: { items }, headers: { Cookie: cookie } });
			expect(put.status).toBe(200);
		}
		await post('/api/passkey/register/options', {}, { headers: { Cookie: cookie } });
		const bystander = cookieFrom(await signUp(new SoftAuthenticator()));

		const gone = await del('/api/account', cookie);
		expect(gone.status).toBe(200);
		expect(gone.headers.get('Set-Cookie')).toMatch(/^giggle_session_dev=; .*Max-Age=0/);
		for (const [table, column] of [
			['accounts', 'id'],
			['passkeys', 'account'],
			['sessions', 'user'],
			['challenges', 'account'],
			['sync_items', 'user'],
			['sync_counts', 'user'],
			['usage', 'user']
		]) {
			const row = await DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
				.bind(user)
				.first<{ n: number }>();
			expect([table, row?.n]).toEqual([table, 0]);
		}
		expect((await call('/api/me', { headers: { Cookie: other } })).status).toBe(401);
		expect((await signIn(phone)).status).toBe(401);
		expect((await call('/api/me', { headers: { Cookie: bystander } })).status).toBe(200);
		expect((await call('/api/account', { headers: { Cookie: bystander } })).status).toBe(405);
		// The dev identity has no account, but its data goes.
		const dev = await call('/api/account', { method: 'DELETE', devUser: 'x@example.test' });
		expect(dev.status).toBe(200);
	});
});

describe('new accounts a day', () => {
	it('stops sign-ups once the day’s quota is used', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const row = await DB.prepare("SELECT n FROM quotas WHERE name = 'new-accounts' AND day = ?")
			.bind(today)
			.first<{ n: number }>();
		const options = { env: { NEW_ACCOUNTS_PER_DAY: String((row?.n ?? 0) + 1) } };
		// Two ceremonies started while there's room for one more account…
		const a = await (await post('/api/passkey/register/options', {}, options)).json<Json>();
		const b = await (await post('/api/passkey/register/options', {}, options)).json<Json>();
		const verify = async (t: Json) =>
			post(
				'/api/passkey/register/verify',
				{ ticket: t.ticket, response: await new SoftAuthenticator().register(t.options) },
				options
			);
		expect((await verify(a)).status).toBe(200);
		// …only one makes it.
		const full = await verify(b);
		expect(full.status).toBe(429);
		expect(await full.json()).toEqual({ error: expect.stringMatching(/new accounts today/) });
		expect((await post('/api/passkey/register/options', {}, options)).status).toBe(429);
		// Accounts that exist still sign in.
		const auth = new SoftAuthenticator();
		expect((await signUp(auth)).status).toBe(200); // the dev environment's own quota
		expect((await signIn(auth, options)).status).toBe(200);
	});
});

describe('cross-site requests', () => {
	it('refuses a POST, PUT or DELETE from another origin', async () => {
		const cookie = cookieFrom(await signUp(new SoftAuthenticator()));
		const evil = { Origin: 'https://evil.example', Cookie: cookie };
		expect((await post('/api/logout', {}, { headers: evil })).status).toBe(403);
		expect((await call('/api/account', { method: 'DELETE', headers: evil })).status).toBe(403);
		const put = await call('/api/board', { method: 'PUT', body: { items: [] }, headers: evil });
		expect(put.status).toBe(403);
		expect((await call('/api/me', { headers: { Cookie: cookie } })).status).toBe(200);
		const site = { Origin: 'http://localhost:5173', Cookie: cookie };
		expect((await post('/api/logout', {}, { headers: site })).status).toBe(200);
	});
});
