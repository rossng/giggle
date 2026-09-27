// Who is asking. Everywhere: a session cookie, set when someone signs in with a passkey
// (passkeys.ts); the session's account id is the user id for synced data. In dev (see config.ts)
// also a fake identity from a header or cookie, and only on a loopback hostname, so a dev build
// that somehow ended up on a public hostname still refuses it.
//
// A session remembers the passkey that signed it in and when a passkey last confirmed it
// (`verified_at`). Changing the account's passkeys or deleting the account needs a recent
// confirmation (`isFresh`), so a stolen or forgotten session can't take the account over.

import type { AuthConfig } from './config';

export const DEV_HEADER = 'X-Giggle-Dev-User';
export const DEV_COOKIE = 'giggle_dev_user';
/**
 * The session cookie. In production `__Host-`: Secure, for this host only and the whole site
 * (Path=/), so no other site, not even a sibling on workers.dev, can set it. `wrangler dev` on
 * http://localhost can't use Secure cookies in every browser, so there it has a plain name.
 */
export const SESSION_COOKIE = '__Host-giggle_session';
export const DEV_SESSION_COOKIE = 'giggle_session_dev';
/** The cookie's name before it moved to `__Host-`: cleared when signing in or out. */
const OLD_SESSION_COOKIE = 'giggle_session';
/** Sessions last this long from sign-in; then the passkey asks again. */
export const SESSION_DAYS = 400;
/** How recently a passkey must have confirmed a session to change passkeys or delete it all. */
export const FRESH_MS = 5 * 60 * 1000;

export interface Session {
	/** The SHA-256 of the cookie's token: the session's row. */
	hash: string;
	/** The passkey that signed it in or last confirmed it. */
	passkey: string | null;
	/** When a passkey last confirmed it (ISO 8601). */
	verifiedAt: string | null;
}

export interface Identity {
	/** An account id ("u_<uuid>") for passkey users; the email address for the dev identity. */
	user: string;
	via: 'passkey' | 'dev';
	/** The passkey session, for `via: 'passkey'`. */
	session?: Session;
	/** The account's last active day as the session lookup found it (null: never), for passkeys. */
	lastSeen?: string | null;
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

export function sessionCookieName(config: AuthConfig): string {
	return config.mode === 'dev' ? DEV_SESSION_COOKIE : SESSION_COOKIE;
}

/** The session cookie: sent with every request to this site, never readable by page scripts. */
export function sessionCookie(config: AuthConfig, token: string, maxAge: number): string {
	const secure = config.mode === 'dev' ? '' : '; Secure';
	const name = sessionCookieName(config);
	return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Set-Cookie values that clear the session cookie (and the one from before `__Host-`). */
export function clearCookies(config: AuthConfig): string[] {
	return [sessionCookie(config, '', 0), `${OLD_SESSION_COOKIE}=; Path=/api; Max-Age=0`];
}

/**
 * Starts a session for `user`, signed in by `passkey` just now, in place of the one `request`
 * brought (if any); returns the Set-Cookie header values. Tidies up as it goes: expired sessions
 * (anyone's) are deleted, and `user` keeps only their newest MAX_SESSIONS.
 */
export async function startSession(
	db: D1Database,
	config: AuthConfig,
	request: Request,
	user: string,
	passkey: string,
	now = Date.now()
): Promise<string[]> {
	const token = newToken();
	const created = new Date(now).toISOString();
	const expires = new Date(now + SESSION_DAYS * 86_400_000).toISOString();
	const previous = readCookie(request, sessionCookieName(config));
	await db.batch([
		db.prepare('DELETE FROM sessions WHERE expires <= ?').bind(created),
		db
			.prepare('DELETE FROM sessions WHERE token_hash = ?')
			.bind(previous ? await tokenHash(previous) : ''),
		db
			.prepare(
				`INSERT INTO sessions (token_hash, user, created, expires, passkey, verified_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.bind(await tokenHash(token), user, created, expires, passkey, created),
		db
			.prepare(
				`DELETE FROM sessions WHERE user = ?1 AND token_hash NOT IN (
					SELECT token_hash FROM sessions WHERE user = ?1 ORDER BY created DESC LIMIT ?2)`
			)
			.bind(user, MAX_SESSIONS)
	]);
	return [sessionCookie(config, token, SESSION_DAYS * 86_400), clearCookies(config)[1]!];
}

/** Records that `passkey` has just confirmed the session. */
export async function confirmSession(
	db: D1Database,
	session: Session,
	passkey: string,
	now = Date.now()
): Promise<void> {
	await db
		.prepare('UPDATE sessions SET passkey = ?, verified_at = ? WHERE token_hash = ?')
		.bind(passkey, new Date(now).toISOString(), session.hash)
		.run();
}

/** Whether a passkey confirmed this session within FRESH_MS (the dev identity always is). */
export function isFresh(identity: Identity, now = Date.now()): boolean {
	if (identity.via === 'dev') return true;
	const at = Date.parse(identity.session?.verifiedAt ?? '');
	return now - at < FRESH_MS && at <= now + 60_000;
}

/**
 * Ends every session of `user` (sign out everywhere), and drops their unfinished ceremonies, so
 * a passkey someone started adding can't be finished afterwards.
 */
export async function endAllSessions(db: D1Database, user: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM sessions WHERE user = ?').bind(user),
		db.prepare('DELETE FROM challenges WHERE account = ?').bind(user)
	]);
}

/** Ends the request's session (if any); returns the Set-Cookie header values that clear it. */
export async function endSession(
	db: D1Database,
	config: AuthConfig,
	request: Request
): Promise<string[]> {
	const token = readCookie(request, sessionCookieName(config));
	if (token) {
		await db
			.prepare('DELETE FROM sessions WHERE token_hash = ?')
			.bind(await tokenHash(token))
			.run();
	}
	return clearCookies(config);
}

async function fromSession(
	request: Request,
	config: AuthConfig,
	db: D1Database
): Promise<AuthResult | null> {
	const token = readCookie(request, sessionCookieName(config));
	if (!token) return null;
	const hash = await tokenHash(token);
	const row = await db
		.prepare(
			`SELECT s.user, s.expires, s.passkey, s.verified_at, a.last_seen
			 FROM sessions s LEFT JOIN accounts a ON a.id = s.user WHERE s.token_hash = ?`
		)
		.bind(hash)
		.first<{
			user: string;
			expires: string;
			passkey: string | null;
			verified_at: string | null;
			last_seen: string | null;
		}>();
	if (!row || Date.parse(row.expires) <= Date.now()) {
		return { ok: false, status: 401, error: 'session expired: sign in again' };
	}
	return {
		ok: true,
		identity: {
			user: row.user,
			via: 'passkey',
			session: { hash, passkey: row.passkey, verifiedAt: row.verified_at },
			lastSeen: row.last_seen
		}
	};
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
	const session = await fromSession(request, config, db);
	if (session?.ok) return session;
	if (config.mode === 'dev') {
		const dev = fromDev(request);
		if (dev.ok || !session) return dev;
	}
	return session ?? { ok: false, status: 401, error: 'not signed in' };
}
