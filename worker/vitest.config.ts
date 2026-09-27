import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (Miniflare) with the `dev` environment's bindings and a local D1;
// test/setup.ts applies migrations/ first. Production-mode tests pass their own vars.
const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
			remoteBindings: false,
			miniflare: {
				bindings: { TEST_MIGRATIONS: migrations },
				// Starts empty so migration tests can seed accounts under the previous schema.
				d1Databases: ['MIGRATION_DB']
			}
		})
	],
	test: {
		setupFiles: ['./test/setup.ts']
	}
});
