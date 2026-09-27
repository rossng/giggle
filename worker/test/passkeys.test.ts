import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { SoftAuthenticator } from './authenticator';
import { call, callJson, DEV_ENV } from './helpers';

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
	const set = res.headers.get('Set-Cookie') ?? '';
	expect(set).toMatch(/^giggle_session=[\w-]{43}; Path=\/api; HttpOnly; SameSite=Lax/);
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
		expect(out.headers.get('Set-Cookie')).toMatch(/^giggle_session=; .*Max-Age=0/);
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
		expect(res.headers.get('Set-Cookie')).toMatch(/; Secure$/);
		const me = await call('/api/me', { ...options, devUser: 'alice@example.test' });
		expect(me.status).toBe(401);
		expect((await call('/api/dev/login?as=alice@example.test', options)).status).toBe(401);
		expect(DEV_ENV.ENVIRONMENT).toBe('dev');
	});

	it('only POST', async () => {
		expect((await call('/api/passkey/login/options')).status).toBe(405);
		expect((await call('/api/logout')).status).toBe(405);
	});
});
