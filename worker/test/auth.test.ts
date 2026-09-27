import { describe, expect, it, vi } from 'vitest';
import { authConfig, ConfigError } from '../src/config';
import { call, callJson } from './helpers';

describe('dev identity (ENVIRONMENT=dev)', () => {
	it('accepts the X-Giggle-Dev-User header on localhost', async () => {
		const res = await callJson('/api/me', { devUser: 'Alice@Example.Test' });
		expect(res).toEqual({
			status: 200,
			body: { user: 'alice@example.test', via: 'dev', passkeys: 0 }
		});
	});

	it('accepts the dev cookie, and /api/dev/login sets it', async () => {
		const login = await call('/api/dev/login?as=bob@example.test');
		expect(login.status).toBe(200);
		const cookie = login.headers.get('Set-Cookie') ?? '';
		expect(cookie).toMatch(/^giggle_dev_user=bob%40example\.test; Path=\/api; HttpOnly/);
		const me = await callJson('/api/me', {
			headers: { Cookie: `other=1; ${cookie.split(';')[0]}` }
		});
		expect(me.body).toEqual({ user: 'bob@example.test', via: 'dev', passkeys: 0 });
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

	it('refuses to serve when the dev flag meets a real hostname', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const extra = { PASSKEY_RP_ID: 'giggle.example', SITE_ORIGINS: 'https://giggle.example' };
		const res = await callJson('/api/me', { devUser: 'alice@example.test', env: extra });
		expect(res).toEqual({ status: 500, body: { error: 'server misconfigured' } });
		expect((await call('/api/dev/login?as=a@b.test', { env: extra })).status).toBe(500);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('authConfig', () => {
	const site = 'https://giggle.rossng.workers.dev';

	it('has exactly two valid shapes', () => {
		expect(
			authConfig({
				ENVIRONMENT: 'dev',
				PASSKEY_RP_ID: 'localhost',
				SITE_ORIGINS: 'http://localhost:5173  http://localhost:8787'
			})
		).toEqual({
			mode: 'dev',
			rpID: 'localhost',
			origins: ['http://localhost:5173', 'http://localhost:8787']
		});
		expect(
			authConfig({
				ENVIRONMENT: 'production',
				PASSKEY_RP_ID: 'giggle.rossng.workers.dev',
				SITE_ORIGINS: site
			})
		).toEqual({ mode: 'passkey', rpID: 'giggle.rossng.workers.dev', origins: [site] });
	});

	it.each([
		{},
		{ ENVIRONMENT: '' },
		{ ENVIRONMENT: 'Dev', PASSKEY_RP_ID: 'localhost', SITE_ORIGINS: 'http://localhost:5173' },
		{
			ENVIRONMENT: 'staging',
			PASSKEY_RP_ID: 'giggle.example',
			SITE_ORIGINS: 'https://giggle.example'
		},
		{ ENVIRONMENT: 'dev', PASSKEY_RP_ID: 'giggle.example', SITE_ORIGINS: 'https://giggle.example' },
		{ ENVIRONMENT: 'dev', PASSKEY_RP_ID: 'localhost' },
		{ ENVIRONMENT: 'production' },
		{ ENVIRONMENT: 'production', PASSKEY_RP_ID: 'localhost', SITE_ORIGINS: 'http://localhost' },
		{ ENVIRONMENT: 'production', PASSKEY_RP_ID: 'giggle.example' },
		{
			ENVIRONMENT: 'production',
			PASSKEY_RP_ID: 'giggle.example',
			SITE_ORIGINS: 'http://giggle.example'
		},
		{
			ENVIRONMENT: 'production',
			PASSKEY_RP_ID: 'giggle.example',
			SITE_ORIGINS: 'https://evil.example'
		},
		{
			ENVIRONMENT: 'production',
			PASSKEY_RP_ID: 'giggle.example',
			SITE_ORIGINS: 'https://giggle.example/'
		},
		{
			ENVIRONMENT: 'production',
			PASSKEY_RP_ID: 'giggle.example',
			SITE_ORIGINS: 'https://evilgiggle.example'
		}
	])('refuses %o', (env) => {
		expect(() => authConfig(env)).toThrow(ConfigError);
	});
});
