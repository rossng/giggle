import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import type { Env } from '../src/config';

export const DEV_ENV = env as unknown as Env;

let counter = 0;
/** A fresh user per call, so tests never see each other's rows. */
export function newUser(name = 'user'): string {
	counter += 1;
	return `${name}-${counter}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

export interface CallOptions {
	method?: string;
	/** Sent as X-Giggle-Dev-User. */
	devUser?: string;
	headers?: Record<string, string>;
	/** JSON-encoded unless a string. */
	body?: unknown;
	origin?: string;
	env?: Partial<Env>;
}

/** A random address in 10.0.0.0/8. */
export function randomIp(): string {
	const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
	return `10.${a}.${b}.${c}`;
}

export async function call(path: string, options: CallOptions = {}): Promise<Response> {
	const headers = new Headers(options.headers);
	if (options.devUser) headers.set('X-Giggle-Dev-User', options.devUser);
	// A client address of its own per call, so the per-IP rate limits (limits.ts) only apply
	// where a test sets one.
	if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', randomIp());
	let body: string | undefined;
	if (options.body !== undefined) {
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
	}
	const request = new Request(`${options.origin ?? 'http://localhost:8787'}${path}`, {
		method: options.method ?? 'GET',
		headers,
		body
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request as Parameters<typeof worker.fetch>[0],
		{ ...DEV_ENV, ...options.env } as Env,
		ctx
	);
	// What the API does after answering (last_seen), done before the test looks. (Not for
	// /models: its streaming work waits for the body to be read.)
	if (path.startsWith('/api')) await waitOnExecutionContext(ctx);
	return response;
}

export async function callJson<T = Record<string, unknown>>(
	path: string,
	options: CallOptions = {}
): Promise<{ status: number; body: T }> {
	const response = await call(path, options);
	return { status: response.status, body: (await response.json()) as T };
}

export interface Item {
	key: string;
	state: 'listen' | 'go' | 'tickets' | 'nope' | null;
	name: string;
	gig?: string;
	at: string;
}

export const MBID = (n: number) => `mb:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function item(key: string, state: Item['state'], at: string, name = 'Artist'): Item {
	return { key, state, name, at };
}

export async function put(user: string, items: Item[]) {
	return callJson<{ items: Item[]; error?: string }>('/api/board', {
		method: 'PUT',
		devUser: user,
		body: { items }
	});
}

export async function pull(user: string, since?: string) {
	const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
	return callJson<{ items: Item[]; cursor: string; more: boolean; error?: string }>(
		`/api/board${query}`,
		{ devUser: user }
	);
}
