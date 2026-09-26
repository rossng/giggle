import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

/** Serves the pipeline's output (../data/site, or $GIGGLE_DATA) at /data/*.json for
 * `vite dev` and `vite preview`, so nothing is copied into the source tree. Production
 * builds get the files from the deploy step, which copies them into build/data/. */
function siteData(): Plugin {
	const dir = resolve(process.env.GIGGLE_DATA ?? resolve(import.meta.dirname, '../data/site'));
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const path = (req.url ?? '').split('?')[0];
		const match = /^\/data\/([a-z0-9_-]+\.json)$/.exec(path);
		if (!match) return next();
		const file = resolve(dir, match[1]);
		if (!existsSync(file)) {
			res.statusCode = 404;
			res.setHeader('Content-Type', 'text/plain');
			res.end(`${file} not found: run \`make data-offline\` (or \`make data\`) first.\n`);
			return;
		}
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		res.setHeader('Cache-Control', 'no-cache');
		createReadStream(file).pipe(res);
	};
	return {
		name: 'giggle-site-data',
		configureServer: (server) => void server.middlewares.use(middleware),
		configurePreviewServer: (server) => void server.middlewares.use(middleware)
	};
}

export default defineConfig({
	plugins: [
		siteData(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// A single-page app: every route falls back to index.html and renders in the browser.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
