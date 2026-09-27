#!/usr/bin/env node
// Checks a deployed giggle: the app's pages, the nightly data, an announcer clip, the Kokoro
// model files, and that the personal API isn't open to anyone but offers passkeys. Exits 1 on any
// failure, including gig data more than 3 days old.
//
//   node scripts/smoke-test.mjs https://giggle.<subdomain>.workers.dev
//   node scripts/smoke-test.mjs http://127.0.0.1:8787    # wrangler dev (the API check differs)

import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
	console.error('usage: smoke-test.mjs <site URL>');
	process.exit(2);
}
const manifest = JSON.parse(
	readFileSync(new URL('../web/src/lib/voice/model-files.json', import.meta.url), 'utf8')
);

let failures = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => {
	failures++;
	console.log(`FAIL  ${msg}`);
};
const warn = (msg) => console.log(`warn  ${msg}`);

async function get(path, init = {}) {
	return fetch(base + path, { redirect: 'manual', ...init });
}

async function expect(path, check, init) {
	try {
		const res = await get(path, init);
		const problem = await check(res);
		if (problem) fail(`${path}: ${problem}`);
		else ok(path);
		return res;
	} catch (e) {
		fail(`${path}: ${e.message}`);
		return null;
	}
}

// A first deploy (and a new workers.dev route) takes a moment to answer: wait for the site.
for (let i = 0; ; i++) {
	const status = await get('/').then(
		(r) => r.status,
		() => 0
	);
	if (status === 200) break;
	if (i === 24) {
		fail(`/ still answers ${status} after 2 minutes`);
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 5000));
}

const html = (res) =>
	res.status !== 200
		? `status ${res.status}`
		: !(res.headers.get('content-type') ?? '').includes('text/html')
			? `content-type ${res.headers.get('content-type')}`
			: null;

// The app, and a deep link the SPA fallback answers.
await expect('/', async (res) => {
	const problem = html(res);
	if (problem) return problem;
	// Security headers (web/static/_headers) and the page's CSP (kit.csp in web/vite.config.ts).
	if (res.headers.get('x-frame-options') !== 'DENY') return 'no X-Frame-Options: DENY';
	if (!(res.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"))
		return "no frame-ancestors 'none' CSP";
	if (res.headers.get('x-content-type-options') !== 'nosniff') return 'no nosniff';
	const body = await res.text();
	return body.includes('http-equiv="content-security-policy"') ? null : 'no CSP meta tag';
});
await expect('/radio?days=30', html);
await expect('/board', html);

// The nightly data.
let artists = null;
await expect('/data/gigs.json', async (res) => {
	if (res.status !== 200) return `status ${res.status}`;
	const data = await res.json();
	if (!(data.gigs?.length > 100)) return `only ${data.gigs?.length ?? 0} gigs`;
	const age = (Date.now() - Date.parse(data.generated)) / 86_400_000;
	// Stale data means the nightly has stopped working: fail, so someone hears about it.
	if (!(age < 3)) return `generated ${data.generated} (${age.toFixed(1)} days ago)`;
	return null;
});
await expect('/data/artists.json', async (res) => {
	if (res.status !== 200) return `status ${res.status}`;
	artists = (await res.json()).artists;
	return Object.keys(artists ?? {}).length > 100 ? null : 'too few artists';
});
await expect('/data/pronunciation.json', (res) =>
	res.status === 200 ? null : `status ${res.status}`
);
const clip = Object.values(artists ?? {}).flatMap((a) => a.announce ?? [])[0]?.clip;
if (clip) {
	await expect(`/data/${clip}`, (res) =>
		res.status !== 200
			? `status ${res.status}`
			: res.headers.get('content-type') !== 'audio/mpeg'
				? `content-type ${res.headers.get('content-type')}`
				: null
	);
} else warn('no announcer clips in artists.json');

// The Kokoro model, from R2 through the Worker.
const models = `/models/${manifest.name}/${manifest.revision}`;
await expect(`${models}/config.json`, (res) =>
	res.status !== 200
		? `status ${res.status} (is the model uploaded? worker/README.md → Model files)`
		: !(res.headers.get('cache-control') ?? '').includes('immutable')
			? `cache-control ${res.headers.get('cache-control')}`
			: null
);
// Big files: HEAD and the Content-Length. Small ones may come compressed (no length), so they're
// downloaded and measured.
const BIG = 1_000_000;
for (const [path, file] of Object.entries(manifest.files)) {
	await expect(
		`${models}/${path}`,
		async (res) => {
			if (res.status !== 200) return `status ${res.status}`;
			const size =
				file.size > BIG
					? Number(res.headers.get('content-length'))
					: (await res.arrayBuffer()).byteLength;
			return size === file.size ? null : `size ${size}, expected ${file.size}`;
		},
		{ method: file.size > BIG ? 'HEAD' : 'GET' }
	);
}

// The personal API must never answer without a signed-in user, and passkeys must be offered for
// this site's hostname (a PASSKEY_RP_ID that doesn't match can't sign anyone in).
await expect('/api/me', (res) =>
	res.status !== 401
		? `status ${res.status}, expected 401 when signed out`
		: res.headers.get('x-content-type-options') !== 'nosniff'
			? 'no nosniff on the API'
			: null
);
await expect(
	'/api/passkey/login/options',
	async (res) => {
		if (res.status !== 200) return `status ${res.status}`;
		const { ticket, options } = await res.json();
		if (typeof ticket !== 'string') return 'no ticket';
		const host = new URL(base).hostname;
		return options?.rpId === host ? null : `rpId ${options?.rpId}, expected ${host}`;
	},
	{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
