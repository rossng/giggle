// giggle's Worker. Static files (the SPA and the public gig data) are served by Workers static
// assets without running this code; only /api/* and /models/* reach it (run_worker_first in
// wrangler.jsonc).
//
//   GET  /models/<name>/<revision>/<file>  → the browser's Kokoro files from R2 (models.ts)
//
//   GET  /api/me                    → {email, via}
//   GET  /api/login?next=<path>     → 302 to `next` once signed in (Access signs you in on the way)
//   GET  /api/<collection>?since=<cursor>  → {items, cursor, more}: changes after `cursor`,
//                                            tombstones too
//   PUT  /api/<collection>  {items: [...]} → {items}: the stored rows for those keys after
//                                            last-write-wins
//        where <collection> is board, unavailable or plays (collections.ts)
//   GET  /api/dev/login?as=<email>  → (dev only) sets the dev identity cookie (302 to `next` if given)
//   GET  /api/dev/logout            → (dev only) clears it (302 to `next` if given)

import { authenticate, DEV_COOKIE, isLoopback, normaliseEmail, type Identity } from './auth';
import { COLLECTIONS, type Collection, type CollectionName } from './collections';
import { authConfig, ConfigError, type AuthConfig, type Env } from './config';
import { MODELS_PREFIX, serveModel } from './models';
import { itemsSince, putItems, TooManyItems } from './store';
import { LIMITS, parseBatch, parseSince, ValidationError } from './validate';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
	return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function error(status: number, message: string, headers: HeadersInit = {}): Response {
	return json({ error: message }, status, headers);
}

async function readJsonBody(request: Request): Promise<unknown> {
	const type = request.headers.get('Content-Type') ?? '';
	if (!/^application\/json\s*(;|$)/i.test(type)) {
		throw new HttpError(415, 'Content-Type must be application/json');
	}
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (declared > LIMITS.body) throw new HttpError(413, 'request body too large');
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > LIMITS.body) {
		throw new HttpError(413, 'request body too large');
	}
	try {
		return JSON.parse(text);
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
		return json(await itemsSince(env.DB, collection, user.email, since, now));
	}
	if (request.method === 'PUT') {
		const items = parseBatch(await readJsonBody(request), (raw) => collection.parseItem(raw, now));
		try {
			return json({
				items: await putItems(env.DB, collection, user.email, items, now)
			});
		} catch (e) {
			if (e instanceof TooManyItems) return error(413, collection.fullMessage);
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
	return new Response(null, { status: 302, headers: { Location: location, ...NO_STORE, ...headers } });
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

export async function handleApi(request: Request, env: Env): Promise<Response> {
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

	const auth = await authenticate(request, config);
	if (!auth.ok) return error(auth.status, auth.error);

	try {
		if (url.pathname === '/api/me') {
			if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
			return json(auth.identity);
		}
		// The app's "Sign in" link: a top-level navigation here makes Access sign the browser in
		// (its cookie then covers /api/*), and we send it back to where it was.
		if (url.pathname === '/api/login') {
			if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
			return redirect(safeNext(url));
		}
		const collection = collectionFor(url.pathname);
		if (collection) return await sync(request, env, auth.identity, collection);
		return error(404, 'not found');
	} catch (e) {
		if (e instanceof ValidationError) return error(400, e.message);
		if (e instanceof HttpError) return error(e.status, e.message);
		throw e;
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
			return handleApi(request, env);
		}
		if (url.pathname.startsWith(MODELS_PREFIX)) {
			return serveModel(request, env.MODELS, { ctx });
		}
		return env.ASSETS.fetch(request);
	}
} satisfies ExportedHandler<Env>;
