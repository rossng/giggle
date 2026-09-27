import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import manifest from '../../web/src/lib/voice/model-files.json';
import { catalog, parseRange, partsOf, serveModel, type Manifest } from '../src/models';
import { call, DEV_ENV } from './helpers';

const BASE = `/models/${manifest.name}/${manifest.revision}`;
const bucket = DEV_ENV.MODELS;
const bytes = (n: number, seed = 0) =>
	Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

describe('/models/* (the real manifest)', () => {
	const config = new Uint8Array(manifest.files['config.json'].size).fill(0x20);
	const voice = bytes(manifest.files['voices/bm_fable.bin'].size);

	beforeAll(async () => {
		await bucket.put(`${manifest.name}/${manifest.revision}/config.json`, config);
		await bucket.put(`${manifest.name}/${manifest.revision}/voices/bm_fable.bin`, voice);
		// In the bucket but not in the manifest: never served.
		await bucket.put(`${manifest.name}/${manifest.revision}/voices/af_bella.bin`, voice);
		await bucket.put('secret.txt', 'not a model file');
		await bucket.put(`${manifest.name}/${manifest.revision}/tokenizer.json`, 'too short');
	});

	it('serves a manifest file with immutable caching, its type and its SHA-256 as ETag', async () => {
		const res = await call(`${BASE}/config.json`);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(res.headers.get('ETag')).toBe(`"${manifest.files['config.json'].sha256}"`);
		expect(res.headers.get('Content-Length')).toBe(String(config.length));
		expect(res.headers.get('Accept-Ranges')).toBe('bytes');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(config);

		const bin = await call(`${BASE}/voices/bm_fable.bin`);
		expect(bin.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(new Uint8Array(await bin.arrayBuffer())).toEqual(voice);
	});

	it('needs no identity, also on a public hostname', async () => {
		const res = await call(`${BASE}/config.json`, { origin: 'https://giggle.example' });
		expect(res.status).toBe(200);
		await res.arrayBuffer();
	});

	it('is 404 for anything not in the manifest, even if it is in the bucket', async () => {
		for (const path of [
			`${BASE}/voices/af_bella.bin`,
			'/models/secret.txt',
			`/models/${manifest.name}/main/config.json`,
			`${BASE}/../../secret.txt`,
			`${BASE}/config.json/`,
			`${BASE}/onnx/model.onnx.part0`,
			'/models/'
		]) {
			const res = await call(path);
			expect(res.status, path).toBe(404);
			expect(res.headers.get('Cache-Control'), path).toBe('no-store');
		}
	});

	it('is 404 for a manifest file that is not uploaded yet', async () => {
		const res = await call(`${BASE}/onnx/model_quantized.onnx`);
		expect(res.status).toBe(404);
	});

	it('refuses to serve a stored file whose size is not the manifest size', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await call(`${BASE}/tokenizer.json`);
		expect(res.status).toBe(500);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('answers HEAD, 304 on a matching If-None-Match, and 405 for other methods', async () => {
		const head = await call(`${BASE}/config.json`, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('Content-Length')).toBe(String(config.length));
		expect(await head.text()).toBe('');

		const etag = `"${manifest.files['config.json'].sha256}"`;
		const cached = await call(`${BASE}/config.json`, { headers: { 'If-None-Match': etag } });
		expect(cached.status).toBe(304);
		expect(cached.headers.get('ETag')).toBe(etag);

		const put = await call(`${BASE}/config.json`, { method: 'PUT', body: 'x' });
		expect(put.status).toBe(405);
		expect(put.headers.get('Allow')).toBe('GET, HEAD');
	});

	it('lists every dtype file and voice the browser can ask for', () => {
		for (const path of Object.values(manifest.dtypes))
			expect(manifest.files).toHaveProperty([path]);
		for (const v of manifest.voices) expect(manifest.files).toHaveProperty([`voices/${v}.bin`]);
	});
});

describe('serveModel: parts and ranges', () => {
	// A 10-byte file stored in parts of 4: part0 [0..3], part1 [4..7], part2 [8..9].
	const m: Manifest = {
		name: 'test-model',
		revision: 'r1',
		partSize: 4,
		files: { 'big.bin': { size: 10, sha256: 'ab'.repeat(32) } }
	};
	const files = catalog(m);
	const file = files.get('/models/test-model/r1/big.bin')!;
	const content = bytes(10, 3);
	const url = 'http://localhost/models/test-model/r1/big.bin';

	async function get(headers: Record<string, string> = {}, method = 'GET') {
		const ctx = createExecutionContext();
		const res = await serveModel(new Request(url, { method, headers }), bucket, {
			files,
			partSize: m.partSize,
			ctx
		});
		const body = method === 'HEAD' ? null : new Uint8Array(await res.arrayBuffer());
		await waitOnExecutionContext(ctx);
		return { res, body };
	}

	beforeAll(async () => {
		for (const [i, part] of partsOf(file, m.partSize).entries()) {
			await bucket.put(part.key, content.slice(i * 4, i * 4 + part.size));
		}
	});

	it('splits big files into numbered parts', () => {
		expect(partsOf(file, 4)).toEqual([
			{ key: 'test-model/r1/big.bin.part0', size: 4 },
			{ key: 'test-model/r1/big.bin.part1', size: 4 },
			{ key: 'test-model/r1/big.bin.part2', size: 2 }
		]);
		expect(partsOf(file, 10)).toEqual([{ key: 'test-model/r1/big.bin', size: 10 }]);
	});

	it('joins the parts into one file', async () => {
		const { res, body } = await get();
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe('10');
		expect(body).toEqual(content);
	});

	it.each([
		['bytes=3-8', 3, 8],
		['bytes=0-0', 0, 0],
		['bytes=4-7', 4, 7],
		['bytes=6-', 6, 9],
		['bytes=-3', 7, 9],
		['bytes=2-100', 2, 9],
		['bytes=-100', 0, 9]
	])('serves %s across parts', async (range, start, end) => {
		const { res, body } = await get({ Range: range });
		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/10`);
		expect(res.headers.get('Content-Length')).toBe(String(end - start + 1));
		expect(body).toEqual(content.slice(start, end + 1));
	});

	it('is 416 for a range past the end, and ignores malformed or multiple ranges', async () => {
		const past = await get({ Range: 'bytes=10-' });
		expect(past.res.status).toBe(416);
		expect(past.res.headers.get('Content-Range')).toBe('bytes */10');
		for (const range of ['bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-']) {
			const { res, body } = await get({ Range: range });
			expect(res.status, range).toBe(200);
			expect(body, range).toEqual(content);
		}
	});

	it('honours If-Range only when it matches the ETag', async () => {
		const etag = `"${'ab'.repeat(32)}"`;
		expect((await get({ Range: 'bytes=0-1', 'If-Range': etag })).res.status).toBe(206);
		expect((await get({ Range: 'bytes=0-1', 'If-Range': '"stale"' })).res.status).toBe(200);
	});

	it('is 404 when a part is missing', async () => {
		const other = catalog({ ...m, revision: 'r2' });
		await bucket.put('test-model/r2/big.bin.part0', content.slice(0, 4));
		await bucket.put('test-model/r2/big.bin.part2', content.slice(8));
		const res = await serveModel(
			new Request('http://localhost/models/test-model/r2/big.bin'),
			bucket,
			{ files: other, partSize: 4 }
		);
		expect(res.status).toBe(404);
	});
});

describe('parseRange', () => {
	it('reads single byte ranges', () => {
		expect(parseRange(null, 10)).toBeNull();
		expect(parseRange('bytes=0-', 10)).toEqual([0, 9]);
		expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
		expect(parseRange('bytes=12-20', 10)).toBe('unsatisfiable');
		expect(parseRange(' bytes=1-2 ', 10)).toEqual([1, 2]);
	});
});
