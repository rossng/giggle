// Where the browser's Kokoro files come from: our own origin, at /models/<name>/<revision>/,
// served by the Worker from R2 (worker/src/models.ts). The files, their pinned Hugging Face
// commit and checksums are in model-files.json.
//
// transformers.js is pointed there with env.remoteHost / remotePathTemplate (see
// kokoro.worker.ts). kokoro-js 1.2.1 fetches voices from a hardcoded Hugging Face URL, so the
// worker's `fetch` is wrapped to send that one prefix to our origin as well; the same wrapper
// refuses any other request to huggingface.co, so production never talks to it. In `vite dev`
// only, a model file our origin can't serve (no `make models`, or no `wrangler dev`) comes from
// Hugging Face at the pinned commit instead.

import files from './model-files.json';

export const MODEL_FILES = files;
const byPath: Record<string, { size: number; sha256: string } | undefined> = files.files;
/** Size in bytes of a mirrored file (0 if it isn't one). */
export const fileSize = (path: string): number => byPath[path]?.size ?? 0;
export const MODEL_ID = files.repo;
/** URL path of the model directory on our origin. */
export const MODEL_PATH = `/models/${files.name}/${files.revision}/`;
/** kokoro-js 1.2.1 loads `${KOKORO_VOICES}${voice}.bin` (always `main`). */
export const KOKORO_VOICES = `https://huggingface.co/${files.repo}/resolve/main/voices/`;
/** The same files on Hugging Face, at the pinned commit (the dev fallback). */
export const HF_PINNED = `https://huggingface.co/${files.repo}/resolve/${files.revision}/`;

export interface ModelFetchOptions {
	/** The model directory on our origin, absolute: `${origin}${MODEL_PATH}`. */
	base: string;
	/** Fall back to Hugging Face (pinned) when our origin can't serve a file. */
	devFallback: boolean;
	warn?: (message: string) => void;
}

function urlOf(input: RequestInfo | URL): string {
	return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** `fetch` for the Kokoro worker: see the comment at the top. */
export function modelFetch(
	upstream: typeof fetch,
	{ base, devFallback, warn = console.warn }: ModelFetchOptions
): typeof fetch {
	let warned = false;
	return async (input, init) => {
		let url = urlOf(input);
		if (url.startsWith(KOKORO_VOICES)) url = `${base}voices/${url.slice(KOKORO_VOICES.length)}`;
		if (!url.startsWith(base)) {
			const host = new URL(url, 'http://relative.invalid/').hostname;
			if (host === 'hf.co' || host === 'huggingface.co' || host.endsWith('.huggingface.co')) {
				throw new Error(`not fetching ${url}: model files come from ${base}`);
			}
			return upstream(input, init);
		}
		const file = url.slice(base.length);
		let response: Response | null = null;
		try {
			response = await upstream(url, init);
		} catch (e) {
			if (!devFallback) throw e;
		}
		if (devFallback && !response?.ok) {
			if (!warned) {
				warned = true;
				warn(
					`Kokoro: ${base} can't serve ${file} (${response ? `HTTP ${response.status}` : 'no answer'}); ` +
						'using Hugging Face (dev only). Run `make models` and `make worker-dev` to serve them locally.'
				);
			}
			response = await upstream(HF_PINNED + file, init);
		}
		// kokoro-js doesn't check the status of a voice download (it would cache an error page
		// as the voice), so fail it here.
		if (!response!.ok && file.startsWith('voices/')) {
			throw new Error(`${url}: HTTP ${response!.status}`);
		}
		return response!;
	};
}

/** Cache Storage entries of Kokoro files that aren't the current ones: downloads from Hugging
 * Face before we served them, or an older pinned revision. */
export function isStaleModelUrl(url: string, base: string): boolean {
	if (url.startsWith(`https://huggingface.co/${files.repo}/`)) return true;
	const { pathname } = new URL(url);
	return pathname.startsWith(`/models/${files.name}/`) && !url.startsWith(base);
}

/** Drops stale model files from transformers.js's cache (~100–330 MB each). Best effort. */
export async function pruneStaleModelFiles(base: string): Promise<number> {
	let removed = 0;
	try {
		const cache = await caches.open('transformers-cache');
		for (const request of await cache.keys()) {
			if (isStaleModelUrl(request.url, base) && (await cache.delete(request))) removed++;
		}
	} catch {
		// No Cache Storage here (private window, some iframes): nothing to prune.
	}
	return removed;
}
