import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import type { KitConfig } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import { IMAGE_SOURCES } from './src/lib/data/image-hosts.ts';

/** Serves the pipeline's output (../data/site, or $GIGGLE_DATA) at /data/*.json (and its
 * announcer clips at /data/voice/*.mp3) for
 * `vite dev` and `vite preview`, so nothing is copied into the source tree. Production
 * builds get the files from the deploy step, which copies them into build/data/. */
function siteData(): Plugin {
	const dir = resolve(process.env.GIGGLE_DATA ?? resolve(import.meta.dirname, '../data/site'));
	const middleware: Connect.NextHandleFunction = (req, res, next) => {
		const path = (req.url ?? '').split('?')[0];
		// Announcer clips: /data/voice/<hash>.mp3, named by content, so cacheable forever.
		const clip = /^\/data\/voice\/([0-9a-f]+\.mp3)$/.exec(path);
		if (clip) {
			const file = resolve(dir, 'voice', clip[1]);
			if (!existsSync(file)) return next();
			res.setHeader('Content-Type', 'audio/mpeg');
			res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
			createReadStream(file).pipe(res);
			return;
		}
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

// `make dev`: the API and the model files (/models, `make models`) come from `wrangler dev`
// (dev identity, local D1 and R2) next to Vite. GIGGLE_WORKER points elsewhere.
const worker = process.env.GIGGLE_WORKER ?? 'http://127.0.0.1:8787';

// What pages may load, as a <meta> CSP on every page (SvelteKit adds the hashes of its inline
// bootstrap script, which changes each build). The directives a <meta> can't carry
// (frame-ancestors) and the other security headers are in static/_headers. A worker's CSP is its
// own response's, not this, so the Kokoro worker's WebAssembly needs nothing here.
const CSP = {
	'default-src': ['self'],
	// The YouTube IFrame API: iframe_api, which loads /s/player/<version>/…/www-widgetapi.js.
	// Just those paths: the rest of www.youtube.com serves scripts too (JSONP and the like).
	'script-src': ['self', 'https://www.youtube.com/iframe_api', 'https://www.youtube.com/s/player/'],
	// Svelte transitions insert <style> elements, and components set style attributes.
	'style-src': ['self', 'unsafe-inline'],
	// Fonts are bundled (Fontsource).
	'font-src': ['self'],
	// Pictures of artists and gigs, from the hosts in image-hosts.ts only; data: for the favicon.
	'img-src': ['self', 'data:', ...IMAGE_SOURCES],
	// Announcer clips (/data/voice) and Kokoro's audio (blob: URLs).
	'media-src': ['self', 'blob:'],
	'connect-src': ['self'],
	'worker-src': ['self', 'blob:'],
	'frame-src': ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
	'manifest-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['none'],
	'form-action': ['self']
} satisfies NonNullable<NonNullable<KitConfig['csp']>['directives']>;

export default defineConfig({
	server: { proxy: { '/api': worker, '/models': worker } },
	// Fonts stay files, never data: URLs (font-src is 'self' only).
	build: { assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) },
	// kokoro.worker.ts configures transformers.js's `env`: it must be kokoro-js's copy.
	resolve: { dedupe: ['@huggingface/transformers'] },
	// The Kokoro worker (src/lib/voice) is a module worker; kokoro-js uses import.meta.
	worker: { format: 'es' },
	plugins: [
		siteData(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// A single-page app: every route falls back to index.html and renders in the browser.
			adapter: adapter({ fallback: 'index.html' }),
			csp: { mode: 'hash', directives: CSP }
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
