import { describe, expect, it, vi } from 'vitest';
import {
	fileSize,
	HF_PINNED,
	isStaleModelUrl,
	KOKORO_VOICES,
	MODEL_FILES,
	MODEL_PATH,
	modelFetch,
	verified
} from './model-source';
import { DTYPES } from './protocol';

const BASE = `http://localhost:5173${MODEL_PATH}`;

function fakeFetch(answers: Record<string, number | 'down'>) {
	const calls: string[] = [];
	const upstream = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const answer = answers[url] ?? 404;
		if (answer === 'down') throw new TypeError('NetworkError');
		return new Response(url, { status: answer });
	}) as unknown as typeof fetch;
	return { upstream, calls };
}

describe('model-files.json', () => {
	it('has a file for every dtype the app can pick and every announcer voice', () => {
		expect(DTYPES).toEqual(['fp32', 'q8']);
		for (const d of DTYPES) expect(fileSize(MODEL_FILES.dtypes[d])).toBeGreaterThan(1e6);
		for (const v of ['bf_isabella', 'bm_fable']) expect(fileSize(`voices/${v}.bin`)).toBe(522240);
		for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
			expect(fileSize(f)).toBeGreaterThan(0);
		}
	});

	it('pins a full commit hash and a SHA-256 per file', () => {
		expect(MODEL_FILES.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(MODEL_PATH).toBe(`/models/kokoro-82m-v1.0/${MODEL_FILES.revision}/`);
		for (const spec of Object.values(MODEL_FILES.files))
			expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('modelFetch', () => {
	it("sends kokoro-js's hardcoded voice URL to our origin", async () => {
		const { upstream, calls } = fakeFetch({ [`${BASE}voices/bm_fable.bin`]: 200 });
		const f = modelFetch(upstream, { base: BASE, devFallback: false });
		const res = await f(`${KOKORO_VOICES}bm_fable.bin`);
		expect(res.status).toBe(200);
		expect(calls).toEqual([`${BASE}voices/bm_fable.bin`]);
	});

	it('refuses any other Hugging Face request, and leaves other URLs alone', async () => {
		const { upstream, calls } = fakeFetch({ 'http://localhost:5173/data/x.json': 200 });
		const f = modelFetch(upstream, { base: BASE, devFallback: false });
		await expect(f(`${HF_PINNED}onnx/model.onnx`)).rejects.toThrow(/not fetching/);
		await expect(f(new URL('https://cdn-lfs.huggingface.co/x'))).rejects.toThrow(/not fetching/);
		expect((await f('http://localhost:5173/data/x.json')).status).toBe(200);
		expect((await f('/data/y.json')).status).toBe(404);
		expect(calls).toEqual(['http://localhost:5173/data/x.json', '/data/y.json']);
	});

	it('in production, passes our errors through (transformers.js reports them)', async () => {
		const { upstream, calls } = fakeFetch({});
		const f = modelFetch(upstream, { base: BASE, devFallback: false });
		expect((await f(`${BASE}onnx/model.onnx`)).status).toBe(404);
		expect(calls).toEqual([`${BASE}onnx/model.onnx`]);
	});

	it('fails a voice that our origin cannot serve, so kokoro-js never caches an error page', async () => {
		const { upstream } = fakeFetch({});
		const f = modelFetch(upstream, { base: BASE, devFallback: false });
		await expect(f(`${KOKORO_VOICES}bf_isabella.bin`)).rejects.toThrow(/HTTP 404/);
	});

	it('in dev, falls back to Hugging Face at the pinned commit, warning once', async () => {
		const { upstream, calls } = fakeFetch({
			[`${BASE}config.json`]: 'down',
			[`${HF_PINNED}config.json`]: 200,
			[`${HF_PINNED}voices/bm_fable.bin`]: 200
		});
		const warn = vi.fn();
		const f = modelFetch(upstream, { base: BASE, devFallback: true, warn });
		expect((await f(`${BASE}config.json`)).status).toBe(200);
		expect((await f(`${KOKORO_VOICES}bm_fable.bin`)).status).toBe(200);
		expect(calls).toEqual([
			`${BASE}config.json`,
			`${HF_PINNED}config.json`,
			`${BASE}voices/bm_fable.bin`,
			`${HF_PINNED}voices/bm_fable.bin`
		]);
		expect(warn).toHaveBeenCalledOnce();
	});
});

describe('verification', () => {
	// config.json at the pinned commit (44 bytes).
	const CONFIG = '{\n  "model_type": "style_text_to_speech_2"\n}';
	const serve = (body: string) =>
		vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

	it('passes a file that matches its pinned size and SHA-256', async () => {
		const f = modelFetch(serve(CONFIG), { base: BASE, devFallback: false });
		expect(await (await f(`${BASE}config.json`)).text()).toBe(CONFIG);
	});

	it('fails the read of a file that differs, so it is never cached', async () => {
		const f = modelFetch(serve(CONFIG.replace('2', '3')), { base: BASE, devFallback: false });
		const res = await f(`${BASE}config.json`);
		expect(res.status).toBe(200);
		await expect(res.arrayBuffer()).rejects.toThrow(/SHA-256/);
	});

	it('fails a file of the wrong size, and stops reading one that runs over', async () => {
		const f = modelFetch(serve(`${CONFIG} `), { base: BASE, devFallback: false });
		await expect((await f(`${BASE}config.json`)).text()).rejects.toThrow(/over its 44 bytes/);
		const g = modelFetch(serve(CONFIG.slice(1)), { base: BASE, devFallback: false });
		await expect((await g(`${BASE}config.json`)).text()).rejects.toThrow(/43 bytes, not 44/);
	});

	it('checks a voice too, and leaves files that are not pinned alone', async () => {
		const f = modelFetch(serve('not a voice'), { base: BASE, devFallback: false });
		await expect((await f(`${KOKORO_VOICES}bm_fable.bin`)).arrayBuffer()).rejects.toThrow();
		expect(await (await f(`${BASE}other.json`)).text()).toBe('not a voice');
	});

	it('hands every chunk on as it arrives', async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
		const body = new ReadableStream({
			start(c) {
				for (const chunk of chunks) c.enqueue(chunk);
				c.close();
			}
		});
		const spec = {
			size: 3,
			sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
		};
		const reader = verified(new Response(body), 'x', spec).body!.getReader();
		expect((await reader.read()).value).toEqual(chunks[0]);
		expect((await reader.read()).value).toEqual(chunks[1]);
		expect((await reader.read()).done).toBe(true);
	});
});

describe('isStaleModelUrl', () => {
	it('is true for Hugging Face downloads and other revisions of ours only', () => {
		expect(isStaleModelUrl(`${BASE}onnx/model.onnx`, BASE)).toBe(false);
		expect(isStaleModelUrl(`${HF_PINNED}onnx/model.onnx`, BASE)).toBe(true);
		expect(isStaleModelUrl(`${KOKORO_VOICES}bm_fable.bin`, BASE)).toBe(true);
		expect(
			isStaleModelUrl('http://localhost:5173/models/kokoro-82m-v1.0/abc/config.json', BASE)
		).toBe(true);
		expect(isStaleModelUrl('https://huggingface.co/other/model/resolve/main/x', BASE)).toBe(false);
		expect(isStaleModelUrl('http://localhost:5173/models/other/x', BASE)).toBe(false);
	});
});
