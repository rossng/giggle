import { error, redirect } from '@sveltejs/kit';
import { artistPath, artistSlug, findArtist } from '$lib/data/slugs';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent }) => {
	const { catalog } = await parent();
	const artist = findArtist(params.slug, catalog.artists);
	if (!artist) error(404, 'No artist at this address. They may have no upcoming gigs any more.');
	// A renamed artist's old link still works, and lands on the current one.
	if (artistSlug(artist) !== params.slug) redirect(308, artistPath(artist));
	return { artist };
};
