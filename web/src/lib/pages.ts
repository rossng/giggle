// Every page's code, fetched in the background once the app is up (the root layout). A deploy
// replaces the hashed files, so a tab opened before it can't fetch a page it hasn't visited:
// SvelteKit then loads that page afresh, and the reload stops the radio. With every page's
// code in hand, moving around never needs the old files.

/** A path for each page (any slug will do: only the route matters). pages.test.ts checks this
 * against src/routes. */
export const PAGE_PATHS: readonly string[] = [
	'/',
	'/agenda',
	'/radio',
	'/board',
	'/account',
	'/admin',
	'/artists/_',
	'/gigs/_/_',
	'/venues/_'
];

/** Runs `preload` when the browser is idle (the first page comes first). Returns a cancel. */
export function whenIdle(preload: () => void): () => void {
	if (typeof requestIdleCallback === 'function') {
		const id = requestIdleCallback(preload, { timeout: 5_000 });
		return () => cancelIdleCallback(id);
	}
	const id = setTimeout(preload, 2_000);
	return () => clearTimeout(id);
}
