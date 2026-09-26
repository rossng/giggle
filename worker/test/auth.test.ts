import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authConfig, ConfigError } from '../src/config';
import { call, callJson, newUser } from './helpers';

describe('dev identity (ENVIRONMENT=dev)', () => {
	it('accepts the X-Giggle-Dev-User header on localhost', async () => {
		const res = await callJson('/api/me', { devUser: 'Alice@Example.Test' });
		expect(res).toEqual({ status: 200, body: { email: 'alice@example.test', via: 'dev' } });
	});

	it('accepts the dev cookie, and /api/dev/login sets it', async () => {
		const login = await call('/api/dev/login?as=bob@example.test');
		expect(login.status).toBe(200);
		const cookie = login.headers.get('Set-Cookie') ?? '';
		expect(cookie).toMatch(/^giggle_dev_user=bob%40example\.test; Path=\/api; HttpOnly/);
		const me = await callJson('/api/me', {
			headers: { Cookie: `other=1; ${cookie.split(';')[0]}` }
		});
		expect(me.body).toEqual({ email: 'bob@example.test', via: 'dev' });
	});

	it('is 401 without an identity, or with one that is not an email address', async () => {
		expect((await call('/api/me')).status).toBe(401);
		expect((await call('/api/me', { devUser: 'not an email' })).status).toBe(401);
		expect((await call('/api/dev/login?as=nope')).status).toBe(400);
	});

	it('is refused on a non-loopback hostname', async () => {
		for (const origin of ['https://giggle.example', 'https://giggle.workers.dev']) {
			const res = await callJson('/api/me', { origin, devUser: 'alice@example.test' });
			expect(res.status).toBe(403);
			expect((await call('/api/dev/login?as=a@b.test', { origin })).status).toBe(403);
		}
		for (const origin of [
			'http://127.0.0.1:8787',
			'http://[::1]:8787',
			'http://giggle.localhost'
		]) {
			expect((await call('/api/me', { origin, devUser: 'alice@example.test' })).status).toBe(200);
		}
	});

	it('refuses to serve when the Access vars are also set', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const extra of [
			{ ACCESS_AUD: 'a'.repeat(64) },
			{ ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com' }
		]) {
			const res = await callJson('/api/me', { devUser: 'alice@example.test', env: extra });
			expect(res).toEqual({ status: 500, body: { error: 'server misconfigured' } });
			expect((await call('/api/dev/login?as=a@b.test', { env: extra })).status).toBe(500);
		}
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('authConfig', () => {
	const team = 'giggle.cloudflareaccess.com';
	const aud = 'f'.repeat(64);

	it('has exactly two valid shapes', () => {
		expect(authConfig({ ENVIRONMENT: 'dev' })).toEqual({ mode: 'dev' });
		expect(authConfig({ ENVIRONMENT: 'dev', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: ' ' })).toEqual({
			mode: 'dev'
		});
		expect(
			authConfig({ ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud })
		).toEqual({ mode: 'access', teamDomain: team, aud });
	});

	it.each([
		{},
		{ ENVIRONMENT: '' },
		{ ENVIRONMENT: 'Dev' },
		{ ENVIRONMENT: 'staging', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud },
		{ ENVIRONMENT: 'dev', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud },
		{ ENVIRONMENT: 'production' },
		{ ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: team },
		{ ENVIRONMENT: 'production', ACCESS_AUD: aud },
		{ ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: 'evil.example.com', ACCESS_AUD: aud },
		{ ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'short' }
	])('refuses %o', (env) => {
		expect(() => authConfig(env)).toThrow(ConfigError);
	});
});

describe('Cloudflare Access (ENVIRONMENT=production)', () => {
	const TEAM = 'giggle-test.cloudflareaccess.com';
	const AUD = 'a1b2c3d4'.repeat(8);
	const ISS = `https://${TEAM}`;
	const PROD = { ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
	const ORIGIN = 'https://giggle.example';

	let key: CryptoKey;
	let otherKey: CryptoKey;
	let jwk: JWK;
	const certsFetched: string[] = [];

	beforeAll(async () => {
		const pair = await generateKeyPair('RS256', { extractable: true });
		key = pair.privateKey;
		otherKey = (await generateKeyPair('RS256')).privateKey;
		jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
	});

	// A stub of the team's JWKS endpoint; anything else the Worker fetches is a test failure.
	function stubCerts() {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			certsFetched.push(url);
			if (url === `${ISS}/cdn-cgi/access/certs`) {
				return Response.json({ keys: [jwk], public_cert: {}, public_certs: [] });
			}
			return new Response('unexpected fetch', { status: 599 });
		});
	}

	afterEach(() => vi.restoreAllMocks());

	async function token(
		claims: Record<string, unknown> = { email: 'Carol@Example.Test' },
		options: { signWith?: CryptoKey; aud?: string; iss?: string; exp?: string | number } = {}
	): Promise<string> {
		return new SignJWT({ type: 'app', ...claims })
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setIssuer(options.iss ?? ISS)
			.setAudience(options.aud ?? AUD)
			.setIssuedAt()
			.setSubject('user-id')
			.setExpirationTime(options.exp ?? '10m')
			.sign(options.signWith ?? key);
	}

	function asAccess(jwt: string | null, extra: Record<string, string> = {}) {
		return callJson('/api/me', {
			origin: ORIGIN,
			env: PROD,
			headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...extra }
		});
	}

	it('uses the email from a valid Access JWT, checked against the team JWKS', async () => {
		stubCerts();
		const res = await asAccess(await token());
		expect(res).toEqual({ status: 200, body: { email: 'carol@example.test', via: 'access' } });
		expect(certsFetched).toContain(`${ISS}/cdn-cgi/access/certs`);
	});

	it('never honours the dev header or cookie', async () => {
		stubCerts();
		const dev = {
			'X-Giggle-Dev-User': 'mallory@example.test',
			Cookie: 'giggle_dev_user=mallory@example.test'
		};
		expect((await asAccess(null, dev)).status).toBe(401);
		// Even on localhost.
		const local = await callJson('/api/me', { env: PROD, headers: dev });
		expect(local.status).toBe(401);
		// With a valid JWT, the JWT decides.
		expect((await asAccess(await token(), dev)).body).toEqual({
			email: 'carol@example.test',
			via: 'access'
		});
		// And there is no dev login route.
		const login = await call('/api/dev/login?as=mallory@example.test', {
			env: PROD,
			origin: ORIGIN
		});
		expect(login.status).toBe(401);
		expect(login.headers.get('Set-Cookie')).toBeNull();
	});

	it.each([
		['wrong audience', () => token(undefined, { aud: 'b'.repeat(64) })],
		['wrong issuer', () => token(undefined, { iss: 'https://evil.cloudflareaccess.com' })],
		['expired', () => token(undefined, { exp: Math.floor(Date.now() / 1000) - 3600 })],
		['signed by another key', () => token(undefined, { signWith: otherKey })],
		['no email (service token)', () => token({ common_name: 'svc.access' })],
		['bad email', () => token({ email: 'not-an-email' })],
		['garbage', async () => 'not.a.jwt'],
		[
			'alg none',
			async () => {
				const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '');
				const now = Math.floor(Date.now() / 1000);
				return `${b64({ alg: 'none' })}.${b64({ email: 'x@y.test', aud: AUD, iss: ISS, exp: now + 600 })}.`;
			}
		]
	])('rejects a JWT that is %s', async (_, make) => {
		stubCerts();
		expect((await asAccess(await make())).status).toBe(401);
	});

	it('refuses to serve until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await callJson('/api/me', {
			origin: ORIGIN,
			env: { ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
			headers: { 'X-Giggle-Dev-User': 'alice@example.test' }
		});
		expect(res.status).toBe(500);
	});

	it('stores board rows under the Access email', async () => {
		stubCerts();
		const email = newUser('dave');
		const jwt = await token({ email });
		const headers = { 'Cf-Access-Jwt-Assertion': jwt };
		const at = '2026-09-26T20:00:00.000Z';
		const put = await callJson('/api/board', {
			method: 'PUT',
			origin: ORIGIN,
			env: PROD,
			headers,
			body: { items: [{ key: 'name:mogwai', state: 'go', name: 'Mogwai', at }] }
		});
		expect(put.status).toBe(200);
		const get = await callJson<{ items: unknown[] }>('/api/board', {
			origin: ORIGIN,
			env: PROD,
			headers
		});
		expect(get.body.items).toEqual([{ key: 'name:mogwai', state: 'go', name: 'Mogwai', at }]);
	});
});
