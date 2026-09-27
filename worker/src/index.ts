// giggle's Worker. Static files (the SPA and the public gig data) are served by Workers static
// assets without running this code; only /api/* and /models/* reach it (run_worker_first in
// wrangler.jsonc).
//
//   GET  /models/<name>/<revision>/<file>  → the browser's Kokoro files from R2 (models.ts)
//
//   GET  /api/me                    → {user, via, passkeys}: who is signed in
//   POST /api/passkey/…             → signing in, adding passkeys and confirming it's you
//                                      (passkeys.ts)
//   POST /api/logout  {}            → ends this browser's session
//   POST /api/logout-everywhere  {} → ends every session of this account, this one included
//   GET  /api/passkeys              → {passkeys: [{id, created, last_used, device_type,
//                                      backed_up, transports}]}: this account's passkeys
//   DELETE /api/passkeys/<id>       → removes one (never the last: 409) and the sessions it
//                                      signed in: {ok, signedOut} (signedOut: this one too)
//   DELETE /api/account             → deletes the account and everything synced to it, and
//                                      signs out everywhere
//   GET  /api/<collection>?since=<cursor>  → {items, cursor, more}: changes after `cursor`,
//                                            tombstones too
//   PUT  /api/<collection>  {items: [...]} → {items}: the stored rows for those keys after
//                                            last-write-wins
//        where <collection> is board, unavailable or plays (collections.ts)
//   GET  /api/dev/login?as=<email>  → (dev only) sets the dev identity cookie (302 to `next` if given)
//   GET  /api/dev/logout            → (dev only) clears it (302 to `next` if given)
//   GET  /api/admin/overview        → (admins only) usage numbers for the admin panel (admin.ts)
//
// Removing a passkey, deleting the account and the admin panel need the session confirmed by a
// passkey in the last few minutes, and so does adding a passkey (register/options while signed
// in). Otherwise they answer 403 {error, reauth: true}: the client confirms with
// /api/passkey/reauth/… and tries again.
//
// Rate limits (limits.ts) answer 429 with Retry-After, as does a write past the account's daily
// row budget (store.ts). A POST, PUT or DELETE whose Origin header isn't the site's is refused
// (403); cross-site pages can't send JSON or these methods without CORS anyway.
//
// Auth comes before routing: signed out, every path is 401, a real one or not. Signed in, the
// account's last active day moves to today (once a day, after the response: stats.ts).

import {
	authenticate,
	clearCookies,
	DEV_COOKIE,
	endAllSessions,
	endSession,
	isLoopback,
	normaliseEmail,
	type Identity
} from './auth';
import { ADMIN_PREFIX, isAdmin, overview } from './admin';
import { COLLECTIONS, type Collection, type CollectionName } from './collections';
import { authConfig, ConfigError, type AuthConfig, type Env } from './config';
import { allowed, clientKey, LIMIT_PERIOD_S, type LimiterName } from './limits';
import { MODELS_PREFIX, serveModel } from './models';
import {
	deleteAccount,
	deletePasskey,
	listPasskeys,
	loginOptions,
	loginVerify,
	NeedsConfirmation,
	PASSKEY_PREFIX,
	passkeyCount,
	PasskeyError,
	reauthOptions,
	reauthVerify,
	registerOptions,
	registerVerify,
	requireFresh
} from './passkeys';
import { markSeen } from './stats';
import { dayOf, itemsSince, OverBudget, putItems, TooManyItems } from './store';
import { LIMITS, parseBatch, parseSince, ValidationError } from './validate';

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
	cookies: string[] = []
): Response {
	const all = new Headers({ ...NO_STORE, ...headers });
	for (const cookie of cookies) all.append('Set-Cookie', cookie);
	return Response.json(body, { status, headers: all });
}

/** 429 when `key` is over `name`'s limit, else null. */
async function limited(
	env: Env,
	name: LimiterName,
	key: string,
	body: (retry: Record<string, string>) => Response
): Promise<Response | null> {
	if (await allowed(env, name, key)) return null;
	return body({ 'Retry-After': String(LIMIT_PERIOD_S) });
}

const tooMany = (retry: Record<string, string>) =>
	error(429, 'too many requests: wait a minute and try again', retry);

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
	return json({ error: message }, status, headers);
}

function failure(e: PasskeyError | HttpError): Response {
	if (e instanceof NeedsConfirmation) return json({ error: e.message, reauth: true }, e.status);
	return error(e.status, e.message);
}

/**
 * The request's JSON body, read as a stream and given up on past LIMITS.body whatever
 * Content-Length says (a chunked request has none).
 */
async function readJsonBody(request: Request): Promise<unknown> {
	const type = request.headers.get('Content-Type') ?? '';
	if (!/^application\/json\s*(;|$)/i.test(type)) {
		throw new HttpError(415, 'Content-Type must be application/json');
	}
	const tooLarge = () => new HttpError(413, 'request body too large');
	if (Number(request.headers.get('Content-Length') ?? '0') > LIMITS.body) throw tooLarge();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > LIMITS.body) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new HttpError(400, 'body is not valid JSON');
	}
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** Seconds until the next UTC midnight, when the daily budgets start again. */
function untilTomorrow(now: number): string {
	return String(Math.ceil((86_400_000 - (now % 86_400_000)) / 1000));
}

async function sync(
	request: Request,
	env: Env,
	user: Identity,
	collection: Collection
): Promise<Response> {
	const url = new URL(request.url);
	const now = Date.now();
	if (request.method === 'GET') {
		const since = parseSince(url.searchParams.get('since'));
		return json(await itemsSince(env.DB, collection, user.user, since, now));
	}
	if (request.method === 'PUT') {
		const items = parseBatch(await readJsonBody(request), (raw) => collection.parseItem(raw, now));
		try {
			return json({
				items: await putItems(env.DB, collection, user.user, items, now)
			});
		} catch (e) {
			if (e instanceof TooManyItems) return error(413, collection.fullMessage);
			if (e instanceof OverBudget) {
				return error(429, 'this account has synced a lot today: the rest waits until tomorrow', {
					'Retry-After': untilTomorrow(now)
				});
			}
			throw e;
		}
	}
	return error(405, 'method not allowed', { Allow: 'GET, PUT' });
}

function collectionFor(pathname: string): Collection | null {
	const name = pathname.slice('/api/'.length);
	return Object.hasOwn(COLLECTIONS, name) ? COLLECTIONS[name as CollectionName] : null;
}

/** Where to send the browser after signing in or out: a path on this site, else the home page. */
export function safeNext(url: URL): string {
	const next = url.searchParams.get('next') ?? '/';
	// A path on this origin only: not "//evil.example" or "/\\evil.example", which browsers
	// treat as another host.
	// eslint-disable-next-line no-control-regex
	return /^\/(?![/\\])/.test(next) && !/[\u0000-\u001f\u007f]/.test(next) ? next : '/';
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: location, ...NO_STORE, ...headers }
	});
}

/** The dev-only sign-in helper, so a browser on `make dev` can pick a fake user. */
function devRoute(request: Request, url: URL, config: AuthConfig): Response | null {
	if (config.mode !== 'dev' || !isLoopback(url)) return null;
	const cookie = `${DEV_COOKIE}=%s; Path=/api; HttpOnly; SameSite=Strict`;
	if (url.pathname === '/api/dev/login' && request.method === 'GET') {
		const email = normaliseEmail(url.searchParams.get('as'));
		if (!email) return error(400, 'use /api/dev/login?as=<email>');
		const set = { 'Set-Cookie': cookie.replace('%s', encodeURIComponent(email)) };
		if (url.searchParams.has('next')) return redirect(safeNext(url), set);
		return json({ email, via: 'dev' }, 200, set);
	}
	if (url.pathname === '/api/dev/logout' && request.method === 'GET') {
		const set = { 'Set-Cookie': cookie.replace('%s', '') + '; Max-Age=0' };
		if (url.searchParams.has('next')) return redirect(safeNext(url), set);
		return json({ ok: true }, 200, set);
	}
	return null;
}

async function passkeyRoute(
	request: Request,
	env: Env,
	url: URL,
	config: AuthConfig
): Promise<Response> {
	if (request.method !== 'POST') return error(405, 'method not allowed', { Allow: 'POST' });
	const body = await readJsonBody(request);
	const step = url.pathname.slice(PASSKEY_PREFIX.length);
	if (step === 'register/options') {
		// Signed in already: the new passkey joins that account (another device).
		const auth = await authenticate(request, config, env.DB);
		return json(await registerOptions(env.DB, config, auth.ok ? auth.identity : null));
	}
	if (step === 'register/verify') {
		const { identity, created, cookies } = await registerVerify(env.DB, config, request, body);
		return json({ user: identity.user, via: identity.via, created }, 200, {}, cookies);
	}
	if (step === 'login/options') return json(await loginOptions(env.DB, config));
	if (step === 'login/verify') {
		const { identity, cookies } = await loginVerify(env.DB, config, request, body);
		return json({ user: identity.user, via: identity.via }, 200, {}, cookies);
	}
	if (step === 'reauth/options' || step === 'reauth/verify') {
		const auth = await authenticate(request, config, env.DB);
		if (!auth.ok) return error(auth.status, auth.error);
		if (step === 'reauth/options') return json(await reauthOptions(env.DB, config, auth.identity));
		await reauthVerify(env.DB, config, auth.identity, body);
		return json({ ok: true });
	}
	return error(404, 'not found');
}

/**
 * The admin panel's routes (admin.ts). Anyone but an admin gets the 404 of an unknown path; an
 * admin needs a fresh passkey confirmation (403 {reauth: true} otherwise).
 */
async function adminRoute(
	request: Request,
	env: Env,
	url: URL,
	config: AuthConfig,
	identity: Identity
): Promise<Response> {
	if (!isAdmin(env, identity)) return error(404, 'not found');
	if (url.pathname !== `${ADMIN_PREFIX}overview`) return error(404, 'not found');
	if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
	const over = await limited(env, 'RL_ADMIN', `account:${identity.user}`, tooMany);
	if (over) return over;
	requireFresh(identity);
	return json(await overview(env.DB, config, identity));
}

/** Moves a passkey account's last_seen to today, after the response, if it isn't already. */
function noteSeen(ctx: ExecutionContext, db: D1Database, identity: Identity): void {
	const today = dayOf(Date.now());
	if (identity.via !== 'passkey' || (identity.lastSeen ?? '') >= today) return;
	ctx.waitUntil(
		markSeen(db, identity.user, today).catch((e) => console.error(`last_seen not saved: ${e}`))
	);
}

export async function handleApi(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const url = new URL(request.url);
	let config: AuthConfig;
	try {
		config = authConfig(env);
	} catch (e) {
		if (!(e instanceof ConfigError)) throw e;
		console.error(`giggle worker misconfigured: ${e.message}`);
		return error(500, 'server misconfigured');
	}

	const dev = devRoute(request, url, config);
	if (dev) return dev;

	// Every /api request, before it reaches D1: one address can't run up the reads.
	const flood = await limited(env, 'RL_API', clientKey(request), tooMany);
	if (flood) return flood;

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		const origin = request.headers.get('Origin');
		if (origin !== null && !config.origins.includes(origin)) {
			return error(403, 'cross-site request refused');
		}
	}

	try {
		if (url.pathname.startsWith(PASSKEY_PREFIX)) {
			return (
				(await limited(env, 'RL_PASSKEY', clientKey(request), tooMany)) ??
				(await passkeyRoute(request, env, url, config))
			);
		}
		if (url.pathname === '/api/logout') {
			if (request.method !== 'POST') return error(405, 'method not allowed', { Allow: 'POST' });
			// A JSON body, like every POST: a cross-site form can't send one, so can't sign you out.
			await readJsonBody(request);
			return json({ ok: true }, 200, {}, await endSession(env.DB, config, request));
		}
	} catch (e) {
		if (e instanceof PasskeyError || e instanceof HttpError) return failure(e);
		throw e;
	}

	const auth = await authenticate(request, config, env.DB);
	if (!auth.ok) return error(auth.status, auth.error);
	const { user, via } = auth.identity;
	noteSeen(ctx, env.DB, auth.identity);

	const reading = request.method === 'GET' || request.method === 'HEAD';
	const over = await limited(env, reading ? 'RL_READS' : 'RL_WRITES', `account:${user}`, tooMany);
	if (over) return over;

	try {
		if (url.pathname === '/api/me') {
			if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
			const passkeys = via === 'passkey' ? await passkeyCount(env.DB, user) : 0;
			return json({ user, via, passkeys });
		}
		if (url.pathname === '/api/logout-everywhere') {
			if (request.method !== 'POST') return error(405, 'method not allowed', { Allow: 'POST' });
			await readJsonBody(request);
			await endAllSessions(env.DB, user);
			return json({ ok: true }, 200, {}, clearCookies(config));
		}
		if (url.pathname === '/api/account') {
			if (request.method !== 'DELETE') {
				return error(405, 'method not allowed', { Allow: 'DELETE' });
			}
			requireFresh(auth.identity);
			await deleteAccount(env.DB, user);
			return json({ ok: true }, 200, {}, clearCookies(config));
		}
		if (url.pathname === '/api/passkeys') {
			if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
			return json({ passkeys: via === 'passkey' ? await listPasskeys(env.DB, user) : [] });
		}
		if (url.pathname.startsWith('/api/passkeys/')) {
			if (request.method !== 'DELETE') {
				return error(405, 'method not allowed', { Allow: 'DELETE' });
			}
			const id = url.pathname.slice('/api/passkeys/'.length);
			// Credential ids are base64url.
			if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) return error(404, 'no such passkey');
			requireFresh(auth.identity);
			await deletePasskey(env.DB, user, id);
			// The sessions that passkey signed in (or last confirmed) end, maybe this one too.
			const signedOut = auth.identity.session?.passkey === id;
			return json({ ok: true, signedOut }, 200, {}, signedOut ? clearCookies(config) : []);
		}
		const collection = collectionFor(url.pathname);
		if (collection) return await sync(request, env, auth.identity, collection);
		if (url.pathname.startsWith(ADMIN_PREFIX)) {
			return await adminRoute(request, env, url, config, auth.identity);
		}
		return error(404, 'not found');
	} catch (e) {
		if (e instanceof ValidationError) return error(400, e.message);
		if (e instanceof HttpError || e instanceof PasskeyError) return failure(e);
		throw e;
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
			return handleApi(request, env, ctx);
		}
		if (url.pathname.startsWith(MODELS_PREFIX)) {
			const over = await limited(
				env,
				'RL_MODELS',
				clientKey(request),
				(retry) =>
					new Response('too many requests: wait a minute and try again\n', {
						status: 429,
						headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE, ...retry }
					})
			);
			return over ?? serveModel(request, env.MODELS, { ctx });
		}
		return env.ASSETS.fetch(request);
	}
} satisfies ExportedHandler<Env>;
