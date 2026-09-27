#!/usr/bin/env node
// The browser's Kokoro files (web/src/lib/voice/model-files.json): download them from Hugging
// Face at the pinned commit, check size and SHA-256, and load them into R2.
//
//   node scripts/models.mjs fetch          download into data/cache/web-models/ (skips good files)
//   node scripts/models.mjs put --local    fetch, then load into the local R2 (wrangler dev --env dev)
//   node scripts/models.mjs put --remote   fetch, then upload to the production bucket (you run this)
//
// Run from worker/ (the Makefile and README do). Files bigger than the manifest's partSize are
// split into <key>.part0, .part1, … for R2 (wrangler uploads at most 300 MiB per object);
// src/models.ts serves them joined up again. The pipeline's own Kokoro files (kokoro-onnx, in
// data/cache/models/) are a different format and are not touched.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST_PATH = join(ROOT, 'web/src/lib/voice/model-files.json');
const CACHE = join(ROOT, 'data/cache/web-models');
// Bucket names from wrangler.jsonc: the top level (production) and env.dev (local only).
const BUCKETS = { remote: 'giggle-models', local: 'giggle-models-dev' };

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const prefix = `${manifest.name}/${manifest.revision}/`;
const MiB = (n) => `${(n / 2 ** 20).toFixed(1)} MiB`;

async function sha256(file) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(file), hash);
	return hash.digest('hex');
}

/** Why `file` isn't the manifest's `path`, or null if it is. */
async function problem(file, { size, sha256: want }) {
	if (!existsSync(file)) return 'missing';
	const { size: actual } = await stat(file);
	if (actual !== size) return `${actual} bytes, expected ${size}`;
	const got = await sha256(file);
	return got === want ? null : `SHA-256 ${got}, expected ${want}`;
}

async function download(path, spec) {
	const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${path}`;
	const file = join(CACHE, prefix, path);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.download`;
	process.stdout.write(`  ${path} (${MiB(spec.size)}) ← ${url}\n`);
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
	await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
	const bad = await problem(tmp, spec);
	if (bad) {
		await rm(tmp, { force: true });
		throw new Error(`${path} from Hugging Face: ${bad}`);
	}
	await rename(tmp, file);
}

async function fetchAll() {
	console.log(`Kokoro browser files → ${join(CACHE, prefix)}`);
	for (const [path, spec] of Object.entries(manifest.files)) {
		const bad = await problem(join(CACHE, prefix, path), spec);
		if (bad === null) continue;
		if (bad !== 'missing') console.log(`  ${path}: ${bad}; downloading again`);
		await download(path, spec);
	}
	console.log('  all files present, sizes and SHA-256 match the manifest');
}

/** [{key, file}] to upload, splitting big files into parts in `tmp`. */
async function objects(tmp) {
	const entries = [];
	for (const [path, { size }] of Object.entries(manifest.files)) {
		const key = prefix + path;
		const file = join(CACHE, key);
		if (size <= manifest.partSize) {
			entries.push({ key, file });
			continue;
		}
		for (let i = 0, start = 0; start < size; i++, start += manifest.partSize) {
			const part = join(tmp, `${path.replaceAll('/', '_')}.part${i}`);
			const end = Math.min(start + manifest.partSize, size) - 1;
			await pipeline(createReadStream(file, { start, end }), createWriteStream(part));
			entries.push({ key: `${key}.part${i}`, file: part });
		}
	}
	return entries;
}

async function put(where) {
	await fetchAll();
	const bucket = BUCKETS[where];
	const tmp = await mkdtemp(join(tmpdir(), 'giggle-models-'));
	try {
		const entries = await objects(tmp);
		console.log(`Putting ${entries.length} objects into the ${where} R2 bucket ${bucket}`);
		for (const { key, file } of entries) {
			// One `wrangler r2 object put` per object (`r2 bulk put` is experimental). The Worker
			// sets the response headers itself, so no metadata is stored with the objects.
			const args = ['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, `--${where}`];
			if (where === 'local') args.push('--env', 'dev');
			const run = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
				cwd: join(ROOT, 'worker'),
				stdio: ['ignore', 'ignore', 'inherit']
			});
			if (run.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed`);
			console.log(`  ${key}`);
		}
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

const [command, flag] = process.argv.slice(2);
try {
	if (command === 'fetch' && flag === undefined) await fetchAll();
	else if (command === 'put' && (flag === '--local' || flag === '--remote'))
		await put(flag.slice(2));
	else {
		console.error('usage: node scripts/models.mjs fetch | put --local | put --remote');
		process.exit(2);
	}
} catch (e) {
	console.error(`models: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}
