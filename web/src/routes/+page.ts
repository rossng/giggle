import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The agenda is the home page until the radio exists.
export const load: PageLoad = ({ url }) => {
	redirect(307, `/agenda${url.search}`);
};
