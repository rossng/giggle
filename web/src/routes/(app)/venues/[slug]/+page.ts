import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent }) => {
	const { catalog } = await parent();
	const venue = catalog.venues[params.slug];
	if (!venue) error(404, `No venue called “${params.slug}”.`);
	return { venue };
};
