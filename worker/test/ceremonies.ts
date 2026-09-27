// Passkey ceremonies against the Worker, for tests: signing up, signing in and confirming a
// session with a SoftAuthenticator.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { b64url, type SoftAuthenticator } from './authenticator';
import { call } from './helpers';

const DB = (env as unknown as { DB: D1Database }).DB;

/** What the options endpoints return (registration and login options, loosely). */
export interface Json {
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
export function cookieFrom(res: Response): string {
	const set = res.headers.getSetCookie()[0] ?? '';
	expect(set).toMatch(/^giggle_session_dev=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
	return set.split(';')[0]!;
}

export async function post(path: string, body: unknown, options: Parameters<typeof call>[1] = {}) {
	return call(path, { method: 'POST', body, ...options });
}

export async function signUp(auth: SoftAuthenticator, options: Parameters<typeof call>[1] = {}) {
	const start = await (await post('/api/passkey/register/options', {}, options)).json<Json>();
	const response = await auth.register(start.options);
	return post('/api/passkey/register/verify', { ticket: start.ticket, response }, options);
}

export async function signIn(auth: SoftAuthenticator, options: Parameters<typeof call>[1] = {}) {
	const start = await (await post('/api/passkey/login/options', {}, options)).json<Json>();
	const response = await auth.login(start.options);
	return post('/api/passkey/login/verify', { ticket: start.ticket, response }, options);
}

/** Makes the session's last passkey confirmation older than FRESH_MS. */
export async function stale(cookie: string) {
	const token = decodeURIComponent(cookie.split('=')[1]!);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	await DB.prepare(
		"UPDATE sessions SET verified_at = '2026-01-01T00:00:00.000Z' WHERE token_hash = ?"
	)
		.bind(b64url(new Uint8Array(digest)))
		.run();
}

/** Confirms the session with `auth`'s passkey. */
export async function reauth(cookie: string, auth: SoftAuthenticator) {
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
