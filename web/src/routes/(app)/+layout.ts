import { error } from '@sveltejs/kit';
import { DataUnavailable, loadCatalog } from '$lib/data/load';
import type { LayoutLoad } from './$types';

// Loaded once per visit: nothing here depends on the URL, so filter changes don't refetch.
export const load: LayoutLoad = async ({ fetch }) => {
	try {
		return { catalog: await loadCatalog(fetch) };
	} catch (e) {
		if (e instanceof DataUnavailable) error(503, `No gig data yet (${e.message}).`);
		throw e;
	}
};
