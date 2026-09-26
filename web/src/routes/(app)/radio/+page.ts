import { loadYtmusicFallback } from '$lib/radio/dev-ytmusic-fallback';
import type { PageLoad } from './$types';

// Doesn't read the URL, so filter changes on the page don't rerun it.
export const load: PageLoad = async ({ parent, fetch }) => {
	const { catalog } = await parent();
	// DEV FALLBACK: YouTube Music songs from the lookup cache until artists.json has them.
	const artists = (await loadYtmusicFallback(fetch, catalog.artists)) ?? catalog.artists;
	return { artists };
};
