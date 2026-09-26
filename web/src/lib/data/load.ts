// Fetches the pipeline's output. In development Vite serves ../data/site at /data (see
// vite.config.ts); in production the deploy step copies those files into build/data.

import { buildCatalog, type Catalog } from './catalog';
import type { ArtistsFile, GigsFile } from './types';

export class DataUnavailable extends Error {}

async function getJson<T>(fetch: typeof globalThis.fetch, url: string): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url);
	} catch (cause) {
		throw new DataUnavailable(`Couldn't fetch ${url}`, { cause });
	}
	if (!response.ok) throw new DataUnavailable(`${url}: HTTP ${response.status}`);
	return (await response.json()) as T;
}

export async function loadCatalog(fetch: typeof globalThis.fetch, base = ''): Promise<Catalog> {
	const [gigs, artists] = await Promise.all([
		getJson<GigsFile>(fetch, `${base}/data/gigs.json`),
		getJson<ArtistsFile>(fetch, `${base}/data/artists.json`)
	]);
	return buildCatalog(gigs, artists);
}
