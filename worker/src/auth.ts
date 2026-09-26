// Who is asking. In production the only source is the Cloudflare Access JWT (Cf-Access-Jwt-Assertion),
// verified here against the team's JWKS, AUD tag and issuer; the email claim is the user id. In dev
// (see config.ts) a fake identity comes from a header or cookie, and only on a loopback hostname,
// so a dev build that somehow ended up on a public hostname still refuses it.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config';

export const DEV_HEADER = 'X-Giggle-Dev-User';
export const DEV_COOKIE = 'giggle_dev_user';
export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

export interface Identity {
	email: string;
	via: 'access' | 'dev';
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

// One JWKS per team domain, per isolate: jose caches the keys and refetches on an unknown `kid`.
const jwksCache = new Map<string, JWTVerifyGetKey>();

function accessKeys(teamDomain: string): JWTVerifyGetKey {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

async function fromAccess(
	request: Request,
	config: Extract<AuthConfig, { mode: 'access' }>
): Promise<AuthResult> {
	const token = request.headers.get(ACCESS_HEADER);
	if (!token) return { ok: false, status: 401, error: 'not signed in' };
	try {
		const { payload } = await jwtVerify(token, accessKeys(config.teamDomain), {
			issuer: `https://${config.teamDomain}`,
			audience: config.aud,
			algorithms: ['RS256']
		});
		// Service tokens carry no email; they aren't users.
		const email = normaliseEmail(payload.email);
		if (!email) return { ok: false, status: 401, error: 'no email in Access token' };
		return { ok: true, identity: { email, via: 'access' } };
	} catch {
		return { ok: false, status: 401, error: 'invalid Access token' };
	}
}

function fromDev(request: Request): AuthResult {
	if (!isLoopback(new URL(request.url))) {
		return { ok: false, status: 403, error: 'dev identity is only accepted on localhost' };
	}
	const raw = request.headers.get(DEV_HEADER) ?? readCookie(request, DEV_COOKIE);
	if (raw == null) return { ok: false, status: 401, error: 'not signed in (dev)' };
	const email = normaliseEmail(raw);
	if (!email) return { ok: false, status: 401, error: 'dev identity must be an email address' };
	return { ok: true, identity: { email, via: 'dev' } };
}

export function authenticate(
	request: Request,
	config: AuthConfig
): Promise<AuthResult> | AuthResult {
	return config.mode === 'access' ? fromAccess(request, config) : fromDev(request);
}
