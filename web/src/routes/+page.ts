import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// People land on the agenda: it says what giggle is (gigs coming up), and the radio is a tap away.
export const load: PageLoad = ({ url }) => {
	redirect(307, `/agenda${url.search}`);
};
