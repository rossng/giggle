// giggle's Worker. Static files (the SPA and the public gig data) are served by Workers static
// assets without running this code; only /api/* and /models/* reach it (run_worker_first in
// wrangler.jsonc).
//
//   GET  /models/<name>/<revision>/<file>  → the browser's Kokoro files from R2 (models.ts)
//
//   GET  /api/me                    → {email, via}
//   GET  /api/board?since=<cursor>  → {items, cursor, more}: changes after `cursor`, tombstones too
//   PUT  /api/board  {items: [...]} → {items}: the stored rows for those keys after last-write-wins
//   GET  /api/dev/login?as=<email>  → (dev only) sets the dev identity cookie
//   GET  /api/dev/logout            → (dev only) clears it

import { authenticate, DEV_COOKIE, isLoopback, normaliseEmail, type Identity } from './auth';
import { itemsSince, putItems, TooManyItems } from './board';
import { authConfig, ConfigError, type AuthConfig, type Env } from './config';
import { MODELS_PREFIX, serveModel } from './models';
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

async function board(request: Request, env: Env, user: Identity): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'GET') {
		return json(await itemsSince(env.DB, user.email, parseSince(url.searchParams.get('since'))));
	}
	if (request.method === 'PUT') {
		const items = parseBatch(await readJsonBody(request), Date.now());
		return json({ items: await putItems(env.DB, user.email, items) });
	}
	return error(405, 'method not allowed', { Allow: 'GET, PUT' });
}

/** The dev-only sign-in helper, so a browser on `make dev` can pick a fake user. */
function devRoute(request: Request, url: URL, config: AuthConfig): Response | null {
	if (config.mode !== 'dev' || !isLoopback(url)) return null;
	const cookie = `${DEV_COOKIE}=%s; Path=/api; HttpOnly; SameSite=Strict`;
	if (url.pathname === '/api/dev/login' && request.method === 'GET') {
		const email = normaliseEmail(url.searchParams.get('as'));
		if (!email) return error(400, 'use /api/dev/login?as=<email>');
		return json({ email, via: 'dev' }, 200, {
			'Set-Cookie': cookie.replace('%s', encodeURIComponent(email))
		});
	}
	if (url.pathname === '/api/dev/logout' && request.method === 'GET') {
		return json({ ok: true }, 200, { 'Set-Cookie': cookie.replace('%s', '') + '; Max-Age=0' });
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
		switch (url.pathname) {
			case '/api/me':
				if (request.method !== 'GET') return error(405, 'method not allowed', { Allow: 'GET' });
				return json(auth.identity);
			case '/api/board':
				return await board(request, env, auth.identity);
			default:
				return error(404, 'not found');
		}
	} catch (e) {
		if (e instanceof ValidationError) return error(400, e.message);
		if (e instanceof HttpError) return error(e.status, e.message);
		if (e instanceof TooManyItems) return error(413, 'board is full');
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
