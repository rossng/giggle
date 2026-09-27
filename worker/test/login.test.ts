import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/index';
import { call } from './helpers';

describe('signing in and out', () => {
	it('/api/login sends a signed-in browser back where it came from', async () => {
		const res = await call('/api/login?next=/board?column=go', { devUser: 'alice@example.test' });
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('/board?column=go');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('/api/login needs a signed-in browser (Access signs it in on the way)', async () => {
		expect((await call('/api/login?next=/board')).status).toBe(401);
	});

	it('dev login and logout redirect when given next, and set or clear the cookie', async () => {
		const login = await call('/api/dev/login?as=bob@example.test&next=/radio');
		expect(login.status).toBe(302);
		expect(login.headers.get('Location')).toBe('/radio');
		expect(login.headers.get('Set-Cookie')).toMatch(/^giggle_dev_user=bob%40example\.test;/);
		const logout = await call('/api/dev/logout?next=/board');
		expect(logout.status).toBe(302);
		expect(logout.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
	});

	it.each([
		['/board', '/board'],
		['/agenda?days=30&q=nobu', '/agenda?days=30&q=nobu'],
		['//evil.example/x', '/'],
		['/\\evil.example', '/'],
		['https://evil.example/', '/'],
		['javascript:alert(1)', '/'],
		['/ok\r\nSet-Cookie: x=1', '/'],
		[null, '/']
	])('next %s → %s', (next, expected) => {
		const url = new URL('https://giggle.example/api/login');
		if (next !== null) url.searchParams.set('next', next);
		expect(safeNext(url)).toBe(expected);
	});
});
