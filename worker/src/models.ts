// Public model files for the browser's Kokoro voice, from the MODELS R2 bucket:
//
//   GET|HEAD /models/<name>/<revision>/<file>
//
// Only the files listed in web/src/lib/voice/model-files.json are served, whatever else is in
// the bucket. They are named by a pinned Hugging Face commit, so they never change: immutable
// caching, and the SHA-256 is the ETag. Files larger than `partSize` are stored as
// `<key>.part0`, `<key>.part1`, … and served as one file. Single byte ranges are supported.
// No auth: these are public files.

import manifest from '../../web/src/lib/voice/model-files.json';

export interface Manifest {
	name: string;
	revision: string;
	partSize: number;
	files: Record<string, { size: number; sha256: string }>;
}

export interface ModelFile {
	/** The R2 key (the URL path without the leading `/models/`). */
	key: string;
	size: number;
	sha256: string;
}

export const MODELS_PREFIX = '/models/';

/** URL path → file, for every file in the manifest. */
export function catalog(m: Manifest): Map<string, ModelFile> {
	const files = new Map<string, ModelFile>();
	for (const [path, { size, sha256 }] of Object.entries(m.files)) {
		const key = `${m.name}/${m.revision}/${path}`;
		files.set(MODELS_PREFIX + key, { key, size, sha256 });
	}
	return files;
}

/** The R2 objects a file is stored as, in order. worker/scripts/models.mjs splits the same way. */
export function partsOf(file: ModelFile, partSize: number): { key: string; size: number }[] {
	if (file.size <= partSize) return [{ key: file.key, size: file.size }];
	const parts = [];
	for (let i = 0, offset = 0; offset < file.size; i++, offset += partSize) {
		parts.push({ key: `${file.key}.part${i}`, size: Math.min(partSize, file.size - offset) });
	}
	return parts;
}

const MANIFEST: Manifest = manifest;
const CATALOG = catalog(MANIFEST);

const CONTENT_TYPES: Record<string, string> = {
	json: 'application/json; charset=utf-8',
	onnx: 'application/octet-stream',
	bin: 'application/octet-stream'
};

function contentType(key: string): string {
	return CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

function plain(status: number, message: string, headers: HeadersInit = {}): Response {
	return new Response(`${message}\n`, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			...headers
		}
	});
}

/** A single `bytes=` range as [start, end] (inclusive), 'unsatisfiable', or null to ignore it
 * (absent, malformed or several ranges: RFC 9110 lets a server send the whole file then). */
export function parseRange(
	header: string | null,
	size: number
): [number, number] | 'unsatisfiable' | null {
	const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
	if (!m || (m[1] === '' && m[2] === '')) return null;
	if (m[1] === '') {
		const suffix = Number(m[2]);
		if (suffix === 0) return 'unsatisfiable';
		return [Math.max(0, size - suffix), size - 1];
	}
	const start = Number(m[1]);
	const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (start >= size) return 'unsatisfiable';
	if (end < start) return null;
	return [start, end];
}

function matchesEtag(header: string | null, etag: string): boolean {
	if (!header) return false;
	return header.split(',').some((t) => {
		const tag = t.trim().replace(/^W\//, '');
		return tag === '*' || tag === etag;
	});
}

export interface ServeOptions {
	files?: Map<string, ModelFile>;
	partSize?: number;
	/** Keeps the Worker alive while a multi-part file streams. */
	ctx?: Pick<ExecutionContext, 'waitUntil'>;
}

export async function serveModel(
	request: Request,
	bucket: R2Bucket,
	{ files = CATALOG, partSize = MANIFEST.partSize, ctx }: ServeOptions = {}
): Promise<Response> {
	const file = files.get(new URL(request.url).pathname);
	if (!file) return plain(404, 'not found');
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return plain(405, 'method not allowed', { Allow: 'GET, HEAD' });
	}

	const etag = `"${file.sha256}"`;
	const headers = new Headers({
		'Content-Type': contentType(file.key),
		'Cache-Control': 'public, max-age=31536000, immutable',
		ETag: etag,
		'Accept-Ranges': 'bytes',
		'X-Content-Type-Options': 'nosniff'
	});

	// Every part must be there, at the size the manifest says, before anything is sent.
	const parts = partsOf(file, partSize);
	const heads = await Promise.all(parts.map((p) => bucket.head(p.key)));
	for (const [i, head] of heads.entries()) {
		if (!head) return plain(404, 'not found');
		if (head.size !== parts[i]!.size) {
			console.error(`models: ${parts[i]!.key} is ${head.size} bytes, expected ${parts[i]!.size}`);
			return plain(500, 'model file does not match the manifest');
		}
	}

	if (matchesEtag(request.headers.get('If-None-Match'), etag)) {
		return new Response(null, { status: 304, headers });
	}

	let start = 0;
	let end = file.size - 1;
	let status = 200;
	const ifRange = request.headers.get('If-Range');
	const range =
		ifRange && ifRange !== etag ? null : parseRange(request.headers.get('Range'), file.size);
	if (range === 'unsatisfiable') {
		return plain(416, 'range not satisfiable', { 'Content-Range': `bytes */${file.size}` });
	}
	if (range) {
		[start, end] = range;
		status = 206;
		headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
	}
	const length = end - start + 1;
	headers.set('Content-Length', String(length));
	if (request.method === 'HEAD') return new Response(null, { status, headers });

	// The pieces of [start, end] in each part.
	const pieces: { key: string; range?: R2Range }[] = [];
	let partStart = 0;
	for (const part of parts) {
		const from = Math.max(start, partStart);
		const to = Math.min(end, partStart + part.size - 1);
		if (from <= to) {
			const whole = to - from + 1 === part.size;
			pieces.push({
				key: part.key,
				range: whole ? undefined : { offset: from - partStart, length: to - from + 1 }
			});
		}
		partStart += part.size;
	}

	const { readable, writable } = new FixedLengthStream(length);
	const pump = (async () => {
		for (const piece of pieces) {
			const object = await bucket.get(piece.key, piece.range ? { range: piece.range } : {});
			if (!object) throw new Error(`models: ${piece.key} disappeared while serving`);
			await object.body.pipeTo(writable, { preventClose: true });
		}
		await writable.close();
	})().catch(async (e: unknown) => {
		// Usually the client going away mid-download.
		console.warn(`models: ${file.key}: ${String(e)}`);
		await writable.abort(e).catch(() => {});
	});
	ctx?.waitUntil(pump);
	return new Response(readable, { status, headers });
}
