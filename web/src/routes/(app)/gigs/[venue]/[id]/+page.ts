import { error, redirect } from '@sveltejs/kit';
import { findGig, gigPath, gigSlug } from '$lib/data/slugs';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent }) => {
	const { catalog } = await parent();
	const gig = findGig(
		params.venue,
		params.id,
		catalog.gigs.map((v) => v.gig)
	);
	const view = gig && catalog.byId.get(gig.id);
	if (!view) error(404, 'No gig at this address. It may have been and gone, or been cancelled.');
	// The title part is decoration: a retitled gig's old link lands on the current one.
	if (gigSlug(view.gig) !== params.id) redirect(308, gigPath(view.gig));
	return { view };
};
