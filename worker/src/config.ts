// Which way the Worker authenticates, decided from its vars on every request. There are exactly
// two valid configurations, and anything else refuses to serve /api/*:
//
//   production: ENVIRONMENT=production, ACCESS_TEAM_DOMAIN and ACCESS_AUD both set.
//               Identity comes only from a verified Cloudflare Access JWT.
//   dev:        ENVIRONMENT=dev and NO Access vars (wrangler.jsonc's env.dev, `wrangler dev`).
//               Identity comes from the dev header/cookie, and only on a loopback hostname.
//
// ENVIRONMENT=dev together with Access vars means a production config got the dev flag (or the
// other way round), so it is refused rather than guessed at.

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ENVIRONMENT?: string;
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

export type AuthConfig =
	| { mode: 'dev' }
	| {
			mode: 'access';
			/** e.g. "giggle.cloudflareaccess.com" */
			teamDomain: string;
			/** The Access application's AUD tag. */
			aud: string;
	  };

export class ConfigError extends Error {}

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD = /^[A-Za-z0-9]{16,128}$/;

export function authConfig(env: Partial<Env>): AuthConfig {
	const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? '').trim();
	const aud = (env.ACCESS_AUD ?? '').trim();
	switch (env.ENVIRONMENT) {
		case 'dev':
			if (teamDomain || aud) {
				throw new ConfigError(
					'ENVIRONMENT=dev with ACCESS_TEAM_DOMAIN/ACCESS_AUD set: refusing to mix the dev ' +
						'identity with a production Access config'
				);
			}
			return { mode: 'dev' };
		case 'production':
			if (!TEAM_DOMAIN.test(teamDomain)) {
				throw new ConfigError('ACCESS_TEAM_DOMAIN must be "<team>.cloudflareaccess.com"');
			}
			if (!AUD.test(aud)) throw new ConfigError('ACCESS_AUD must be the Access app AUD tag');
			return { mode: 'access', teamDomain, aud };
		default:
			throw new ConfigError('ENVIRONMENT must be "production" or "dev"');
	}
}
