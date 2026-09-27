// Who is asking. Everywhere: a session cookie, set when someone signs in with a passkey
// (passkeys.ts); the session's account id is the user id for synced data. In dev (see config.ts)
// also a fake identity from a header or cookie, and only on a loopback hostname, so a dev build
// that somehow ended up on a public hostname still refuses it.

import type { AuthConfig } from './config';

export const DEV_HEADER = 'X-Giggle-Dev-User';
export const DEV_COOKIE = 'giggle_dev_user';
export const SESSION_COOKIE = 'giggle_session';
/** Sessions last this long from sign-in; then the passkey asks again. */
export const SESSION_DAYS = 400;

export interface Identity {
	/** An account id ("u_<uuid>") for passkey users; the email address for the dev identity. */
	user: string;
	via: 'passkey' | 'dev';
}

export type AuthResult =
	{ ok: true; identity: Identity } | { ok: false; status: 401 | 403; error: string };

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** A lower-cased email address, or null if `value` isn't one. */
export function normaliseEmail(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const email = value.trim().toLowerCase();
	return email.length <= 254 && EMAIL.test(email) ? email : null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopback(url: URL): boolean {
	return LOOPBACK.has(url.hostname) || url.hostname.endsWith('.localhost');
}

export function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq).trim() === name) {
			try {
				return decodeURIComponent(part.slice(eq + 1).trim());
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random, unguessable token (256 bits). */
export function newToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Tokens are stored hashed, so a leaked table doesn't hand out sessions. */
export async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return base64url(new Uint8Array(digest));
}

/** Signed-in browsers per account: signing in again past this ends the oldest sessions. */
export const MAX_SESSIONS = 50;

/**
 * Starts a session for `user`; returns its Set-Cookie header value. Tidies up as it goes:
 * expired sessions (anyone's) are deleted, and `user` keeps only their newest MAX_SESSIONS.
 */
export async function startSession(
	db: D1Database,
	user: string,
	url: URL,
	now = Date.now()
): Promise<string> {
	const token = newToken();
	const created = new Date(now).toISOString();
	const expires = new Date(now + SESSION_DAYS * 86_400_000).toISOString();
	await db.batch([
		db.prepare('DELETE FROM sessions WHERE expires <= ?').bind(created),
		db
			.prepare('INSERT INTO sessions (token_hash, user, created, expires) VALUES (?, ?, ?, ?)')
			.bind(await tokenHash(token), user, created, expires),
		db
			.prepare(
				`DELETE FROM sessions WHERE user = ?1 AND token_hash NOT IN (
					SELECT token_hash FROM sessions WHERE user = ?1 ORDER BY created DESC LIMIT ?2)`
			)
			.bind(user, MAX_SESSIONS)
	]);
	return sessionCookie(token, url, SESSION_DAYS * 86_400);
}

/** Ends every session of `user` (sign out everywhere). */
export async function endAllSessions(db: D1Database, user: string): Promise<void> {
	await db.prepare('DELETE FROM sessions WHERE user = ?').bind(user).run();
}

/** The session cookie: only sent to /api, never readable by page scripts. */
export function sessionCookie(token: string, url: URL, maxAge: number): string {
	const secure = url.protocol === 'https:' ? '; Secure' : '';
	return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Ends the request's session (if any); returns the Set-Cookie header value that clears it. */
export async function endSession(db: D1Database, request: Request): Promise<string> {
	const token = readCookie(request, SESSION_COOKIE);
	if (token) {
		await db
			.prepare('DELETE FROM sessions WHERE token_hash = ?')
			.bind(await tokenHash(token))
			.run();
	}
	return sessionCookie('', new URL(request.url), 0);
}

async function fromSession(request: Request, db: D1Database): Promise<AuthResult | null> {
	const token = readCookie(request, SESSION_COOKIE);
	if (!token) return null;
	const row = await db
		.prepare('SELECT user, expires FROM sessions WHERE token_hash = ?')
		.bind(await tokenHash(token))
		.first<{ user: string; expires: string }>();
	if (!row || Date.parse(row.expires) <= Date.now()) {
		return { ok: false, status: 401, error: 'session expired: sign in again' };
	}
	return { ok: true, identity: { user: row.user, via: 'passkey' } };
}

function fromDev(request: Request): AuthResult {
	if (!isLoopback(new URL(request.url))) {
		return { ok: false, status: 403, error: 'dev identity is only accepted on localhost' };
	}
	const raw = request.headers.get(DEV_HEADER) ?? readCookie(request, DEV_COOKIE);
	if (raw == null) return { ok: false, status: 401, error: 'not signed in (dev)' };
	const email = normaliseEmail(raw);
	if (!email) return { ok: false, status: 401, error: 'dev identity must be an email address' };
	return { ok: true, identity: { user: email, via: 'dev' } };
}

export async function authenticate(
	request: Request,
	config: AuthConfig,
	db: D1Database
): Promise<AuthResult> {
	const session = await fromSession(request, db);
	if (session?.ok) return session;
	if (config.mode === 'dev') {
		const dev = fromDev(request);
		if (dev.ok || !session) return dev;
	}
	return session ?? { ok: false, status: 401, error: 'not signed in' };
}
