import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// People land on the radio: it's what giggle is for (the agenda and board are a tap away).
export const load: PageLoad = ({ url }) => {
	redirect(307, `/radio${url.search}`);
};
