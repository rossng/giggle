// Rate limits (Workers Rate Limiting bindings, `ratelimits` in wrangler.jsonc): enough for a
// person and their devices, not for a script. They keep one client from filling D1 or using up
// its daily write allowance for everyone:
//
//   RL_API      every /api/* request        per client IP     (before anything touches D1)
//   RL_PASSKEY  /api/passkey/*              per client IP     (a sign-in or sign-up is two calls)
//   RL_WRITES   PUT/POST/DELETE, signed in  per account       (a sync PUT writes up to 400 rows)
//   RL_READS    GET, signed in              per account       (a sync GET reads up to 1000 rows)
//   RL_MODELS   /models/*                   per client IP     (a model load is ~8 files)
//
// Writes also spend a daily row budget per account, and sign-ups a site-wide daily quota, both
// kept in D1 (store.ts, passkeys.ts): these limits only have 10 or 60 second periods.
//
// The counts and periods live in wrangler.jsonc. Cloudflare counts per location and eventually
// consistently, so a limit is approximate, and a client far over it may get a few extra through.
// A missing binding (a config that doesn't declare it) or a failing limiter lets the request
// through: the limits protect the free plan's allowances, they are not access control.

export type LimiterName = 'RL_API' | 'RL_PASSKEY' | 'RL_WRITES' | 'RL_READS' | 'RL_MODELS';

export type Limiters = Partial<Record<LimiterName, RateLimit>>;

/** Every limiter's period, in seconds (wrangler.jsonc's `simple.period`): Retry-After. */
export const LIMIT_PERIOD_S = 60;

/** Whether `key` may make another request against `name`'s limit. */
export async function allowed(env: Limiters, name: LimiterName, key: string): Promise<boolean> {
	const limiter = env[name];
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key })).success;
	} catch (e) {
		console.error(`rate limiter ${name} failed, letting the request through: ${e}`);
		return true;
	}
}

/**
 * The client's address as a limit key: Cloudflare's CF-Connecting-IP. An IPv6 client is keyed
 * by its /64, since one host usually has a whole /64 to pick addresses from.
 */
export function clientKey(request: Request): string {
	const ip = (request.headers.get('CF-Connecting-IP') ?? '').trim().toLowerCase();
	if (!ip) return 'ip:unknown';
	if (!ip.includes(':')) return `ip:${ip}`;
	return `ip6:${ipv6Prefix64(ip) ?? ip}`;
}

/** The first four groups of an IPv6 address ("2001:db8:0:1"), or null if it isn't one. */
export function ipv6Prefix64(ip: string): string | null {
	const address = ip.split('%')[0]!;
	const halves = address.split('::');
	if (halves.length > 2) return null;
	const groups = (s: string) => (s ? s.split(':') : []);
	const head = groups(halves[0]!);
	const tail = halves.length === 2 ? groups(halves[1]!) : [];
	// An embedded IPv4 tail ("::ffff:1.2.3.4") is two groups.
	const last = tail.length ? tail : head;
	if (last.length && last[last.length - 1]!.includes('.')) last.splice(-1, 1, '0', '0');
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	return all
		.slice(0, 4)
		.map((g) => g.replace(/^0+(?=.)/, ''))
		.join(':');
}
