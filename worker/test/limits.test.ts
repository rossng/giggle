import { describe, expect, it } from 'vitest';
import manifest from '../../web/src/lib/voice/model-files.json';
import { ipv6Prefix64, clientKey } from '../src/limits';
import { call, DEV_ENV, newUser, randomIp } from './helpers';

const post = (path: string, ip: string) =>
	call(path, { method: 'POST', body: {}, headers: { 'CF-Connecting-IP': ip } });

async function statuses(n: number, request: () => Promise<Response>): Promise<number[]> {
	const out = [];
	for (let i = 0; i < n; i++) {
		const res = await request();
		await res.arrayBuffer();
		out.push(res.status);
	}
	return out;
}

describe('rate limits', () => {
	it('allows 10 passkey calls a minute per IP, then 429 with Retry-After', async () => {
		const ip = randomIp();
		const first = await statuses(10, () => post('/api/passkey/login/options', ip));
		expect(first.every((s) => s === 200)).toBe(true);
		const over = await post('/api/passkey/login/options', ip);
		expect(over.status).toBe(429);
		expect(over.headers.get('Retry-After')).toBe('60');
		expect(over.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(await over.json()).toEqual({ error: expect.stringMatching(/too many requests/) });
		// Registering is the same limit; another address isn't affected.
		expect((await post('/api/passkey/register/options', ip)).status).toBe(429);
		expect((await post('/api/passkey/login/options', randomIp())).status).toBe(200);
	});

	it('counts an IPv6 /64 as one client', async () => {
		const [a, b] = crypto.getRandomValues(new Uint16Array(2));
		const net = `2001:db8:${a!.toString(16)}:${b!.toString(16)}`;
		await statuses(10, () =>
			post('/api/passkey/login/options', `${net}::${(Math.random() * 1e4) | 0}`)
		);
		expect((await post('/api/passkey/login/options', `${net}:1:2:3:4`)).status).toBe(429);
	});

	it('allows 30 writes a minute per account; reads are not limited', async () => {
		const alice = newUser('alice');
		const put = (user: string) =>
			call('/api/board', {
				method: 'PUT',
				devUser: user,
				body: {
					items: [{ key: 'name:nobu', state: 'go', name: 'Nobu', at: new Date().toISOString() }]
				}
			});
		const first = await statuses(30, () => put(alice));
		expect(first.every((s) => s === 200)).toBe(true);
		const over = await put(alice);
		expect(over.status).toBe(429);
		expect(over.headers.get('Retry-After')).toBe('60');
		// Any write counts, valid or not, from any address.
		expect((await call('/api/board', { method: 'PUT', devUser: alice, body: 'x' })).status).toBe(
			429
		);
		expect((await call('/api/board', { devUser: alice })).status).toBe(200);
		expect((await put(newUser('bob'))).status).toBe(200);
	});

	it('allows 60 model requests a minute per IP', async () => {
		const ip = randomIp();
		const path = `/models/${manifest.name}/${manifest.revision}/nope.bin`;
		const get = () => call(path, { headers: { 'CF-Connecting-IP': ip } });
		expect((await statuses(60, get)).every((s) => s === 404)).toBe(true);
		const over = await get();
		expect(over.status).toBe(429);
		expect(over.headers.get('Retry-After')).toBe('60');
		expect(over.headers.get('Cache-Control')).toBe('no-store');
	});

	it('lets requests through without a limiter binding, or when it fails', async () => {
		const ip = randomIp();
		const missing = { RL_PASSKEY: undefined };
		const failing = {
			RL_PASSKEY: {
				limit: () => Promise.reject(new Error('limiter down'))
			} as unknown as RateLimit
		};
		for (const env of [missing, failing]) {
			const res = await statuses(12, () =>
				call('/api/passkey/login/options', {
					method: 'POST',
					body: {},
					headers: { 'CF-Connecting-IP': ip },
					env
				})
			);
			expect(res.every((s) => s === 200)).toBe(true);
		}
		expect(DEV_ENV.RL_PASSKEY).toBeDefined();
	});
});

describe('client keys', () => {
	const key = (ip?: string) =>
		clientKey(new Request('http://x/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }));

	it('is the IPv4 address, or the IPv6 /64', () => {
		expect(key('203.0.113.7')).toBe('ip:203.0.113.7');
		expect(key()).toBe('ip:unknown');
		expect(key('2001:DB8:0:1:aaaa::1')).toBe('ip6:2001:db8:0:1');
		expect(key('2001:db8::1')).toBe('ip6:2001:db8:0:0');
	});

	it('expands IPv6 addresses', () => {
		expect(ipv6Prefix64('::1')).toBe('0:0:0:0');
		expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0:0:0');
		expect(ipv6Prefix64('2001:0db8:0000:0042:1:2:3:4')).toBe('2001:db8:0:42');
		expect(ipv6Prefix64('::ffff:192.0.2.1')).toBe('0:0:0:0');
		expect(ipv6Prefix64('1:2:3:4:5:6:7')).toBeNull();
		expect(ipv6Prefix64('1::2::3')).toBeNull();
		expect(ipv6Prefix64('g::1')).toBeNull();
	});
});
