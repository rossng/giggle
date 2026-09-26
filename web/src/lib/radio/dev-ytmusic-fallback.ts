// ┌──────────────────────────────────────────────────────────────────────────────────┐
// │ DEV FALLBACK — delete this file once artists.json carries `artist.youtube`.       │
// │ Also remove: its use in src/routes/(app)/radio/+page.ts, the ytmusic.json line in │
// │ vite.config.ts, and dev-ytmusic-fallback.test.ts.                                 │
// └──────────────────────────────────────────────────────────────────────────────────┘
//
// Until the pipeline adds YouTube Music data to artists.json, the dev server serves the
// lookup cache (data/cache/ytmusic.json, `{version, artists: {normalisedName: record|null}}`)
// at /data/ytmusic.json, and this module attaches its records to artists by name.

import type { Artist, YoutubeArtist } from '$lib/data/types';
import { hasYoutubeField } from './tracks';

/** Port of `normalise` in pipeline/src/giggle_pipeline/ytmusic.py: NFKD, ASCII only,
 * lowercase, no leading "the ", letters and digits only. */
export function normaliseName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/[^\x00-\x7f]/g, '')
		.toLowerCase()
		.replace(/^the\s+/, '')
		.replace(/[^a-z0-9]+/g, '');
}

export type YtmusicCache = Map<string, YoutubeArtist | null>;

/** Reads the cache file; null when it isn't one. */
export function parseYtmusicCache(value: unknown): YtmusicCache | null {
	const artists = (value as { artists?: unknown } | null)?.artists;
	if (!artists || typeof artists !== 'object' || Array.isArray(artists)) return null;
	const out: YtmusicCache = new Map();
	for (const [key, record] of Object.entries(artists as Record<string, unknown>)) {
		const r = record as Partial<YoutubeArtist> | null;
		if (r && typeof r.browseId === 'string' && Array.isArray(r.songs)) {
			out.set(key, {
				browseId: r.browseId,
				name: typeof r.name === 'string' ? r.name : key,
				monthlyListeners: r.monthlyListeners ?? null,
				image: typeof r.image === 'string' ? r.image : null,
				songs: r.songs,
				description: typeof r.description === 'string' ? r.description : null
			});
		} else {
			out.set(key, null);
		}
	}
	return out;
}

/** `artists` with `youtube` filled in from the cache wherever it's missing. */
export function applyYtmusicFallback(
	artists: Readonly<Record<string, Artist>>,
	cache: YtmusicCache
): Record<string, Artist> {
	const out: Record<string, Artist> = {};
	for (const [key, artist] of Object.entries(artists)) {
		if (artist.youtube !== undefined) {
			out[key] = artist;
			continue;
		}
		const names = [artist.name, artist.match?.name, artist.musicbrainz?.name];
		let youtube: YoutubeArtist | null = null;
		for (const name of names) {
			const found = name ? cache.get(normaliseName(name)) : undefined;
			if (found) {
				youtube = found;
				break;
			}
		}
		out[key] = { ...artist, youtube };
	}
	return out;
}

/** Fetches the cache when artists.json has no YouTube data; null if not needed or absent. */
export async function loadYtmusicFallback(
	fetch: typeof globalThis.fetch,
	artists: Readonly<Record<string, Artist>>
): Promise<Record<string, Artist> | null> {
	if (hasYoutubeField(artists)) return null;
	try {
		const response = await fetch('/data/ytmusic.json');
		if (!response.ok) return null;
		const cache = parseYtmusicCache(await response.json());
		return cache ? applyYtmusicFallback(artists, cache) : null;
	} catch {
		return null;
	}
}
