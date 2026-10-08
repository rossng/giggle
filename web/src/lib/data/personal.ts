// What the filters need that's the listener's own (filters.ts `Personal`), from the app's stores.
// Read inside a `$derived` or `$effect`, so the filters re-run when it changes.

import type { Personal } from './filters';
import { unavailableDates } from './unavailable-store.svelte';

export function personal(): Personal {
	return { unavailable: unavailableDates.test };
}
