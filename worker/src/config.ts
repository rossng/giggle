// How the Worker signs people in, decided from its vars on every request. There are exactly two
// valid configurations, and anything else refuses to serve /api/*:
//
//   production: ENVIRONMENT=production, PASSKEY_RP_ID a real hostname and SITE_ORIGINS its https
//               origin(s). Identity comes only from a passkey session (passkeys.ts).
//   dev:        ENVIRONMENT=dev with PASSKEY_RP_ID=localhost (wrangler.jsonc's env.dev, `wrangler
//               dev`). Passkeys work on localhost too, and so does a fake identity from the dev
//               header/cookie, only on a loopback hostname.
//
// A dev flag with a real hostname (or the other way round) means a config got mixed up, so it is
// refused rather than guessed at.

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	/** The browser's Kokoro model files (see models.ts). */
	MODELS: R2Bucket;
	/** Rate limits (limits.ts); a missing one doesn't limit. */
	RL_PASSKEY?: RateLimit;
	RL_WRITES?: RateLimit;
	RL_READS?: RateLimit;
	RL_API?: RateLimit;
	RL_MODELS?: RateLimit;
	RL_ADMIN?: RateLimit;
	ENVIRONMENT?: string;
	/** The passkeys' relying party: the site's hostname. Passkeys only work on it. */
	PASSKEY_RP_ID?: string;
	/** Where sign-in may come from: origins, space-separated ("https://giggle.example"). */
	SITE_ORIGINS?: string;
	/** New accounts the whole site takes a day (default NEW_ACCOUNTS_PER_DAY). */
	NEW_ACCOUNTS_PER_DAY?: string;
	/** Account ids that may use the admin panel, comma-separated (admin.ts); empty: nobody. */
	ADMIN_ACCOUNTS?: string;
}

export interface Relying {
	/** The hostname passkeys are bound to. */
	rpID: string;
	/** Origins a passkey ceremony may come from. */
	origins: string[];
}

export type AuthConfig = ({ mode: 'dev' } | { mode: 'passkey' }) &
	Relying & {
		/** New accounts a day, site-wide: sign-up is open, so this caps what a script can make. */
		newAccountsPerDay: number;
	};

export const NEW_ACCOUNTS_PER_DAY = 50;

function newAccountsPerDay(env: Partial<Env>): number {
	const raw = env.NEW_ACCOUNTS_PER_DAY;
	if (raw === undefined || raw === '') return NEW_ACCOUNTS_PER_DAY;
	if (!/^\d{1,6}$/.test(raw)) throw new ConfigError('NEW_ACCOUNTS_PER_DAY must be a whole number');
	return Number(raw);
}

export class ConfigError extends Error {}

const HOSTNAME =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function origins(env: Partial<Env>, rpID: string, secure: boolean): string[] {
	const list = (env.SITE_ORIGINS ?? '').split(/\s+/).filter(Boolean);
	if (!list.length) throw new ConfigError('SITE_ORIGINS must list the site origin(s)');
	for (const origin of list) {
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			throw new ConfigError(`SITE_ORIGINS: not a URL: ${origin}`);
		}
		if (url.origin !== origin) throw new ConfigError(`SITE_ORIGINS: not an origin: ${origin}`);
		if (secure && url.protocol !== 'https:') {
			throw new ConfigError(`SITE_ORIGINS: must be https in production: ${origin}`);
		}
		// A passkey bound to rpID only works on that host or its subdomains.
		if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) {
			throw new ConfigError(`SITE_ORIGINS: ${origin} is not on ${rpID}`);
		}
	}
	return list;
}

export function authConfig(env: Partial<Env>): AuthConfig {
	const rpID = (env.PASSKEY_RP_ID ?? '').trim().toLowerCase();
	switch (env.ENVIRONMENT) {
		case 'dev':
			if (rpID !== 'localhost') {
				throw new ConfigError(
					'ENVIRONMENT=dev needs PASSKEY_RP_ID=localhost: refusing to offer the dev identity ' +
						'on a real hostname'
				);
			}
			return {
				mode: 'dev',
				rpID,
				origins: origins(env, rpID, false),
				newAccountsPerDay: newAccountsPerDay(env)
			};
		case 'production':
			if (!HOSTNAME.test(rpID)) {
				throw new ConfigError('PASSKEY_RP_ID must be the site hostname (not localhost)');
			}
			return {
				mode: 'passkey',
				rpID,
				origins: origins(env, rpID, true),
				newAccountsPerDay: newAccountsPerDay(env)
			};
		default:
			throw new ConfigError('ENVIRONMENT must be "production" or "dev"');
	}
}
