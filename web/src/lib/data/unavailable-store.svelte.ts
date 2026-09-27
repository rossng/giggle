// The listener's unavailable dates as reactive app state: loaded from this browser, kept up to
// date with other tabs (storage events) and other devices (the sync client), and edited through
// `add`/`remove`, which save and hand the change to the sync client.

import { browser } from '$app/environment';
import { localChanged, onSynced } from '$lib/sync/app';
import {
	addRule,
	loadUnavailable,
	removeRule,
	saveUnavailable,
	UNAVAILABLE_STORAGE_KEY,
	unavailableTest,
	type Rule,
	type Unavailable
} from './unavailable';

class UnavailableDates {
	/** Rule key → item. */
	items: Unavailable = $state.raw({});
	/** Is the listener unavailable on this date? For filters.apply and the Board. */
	readonly test = $derived(unavailableTest(this.items));

	constructor() {
		if (!browser) return;
		this.items = loadUnavailable();
		addEventListener('storage', (e) => {
			if (e.key === UNAVAILABLE_STORAGE_KEY || e.key === null) this.items = loadUnavailable();
		});
		onSynced('unavailable', (items) => (this.items = items));
	}

	/** Adds (or relabels) a rule. */
	add(rule: Rule, label = ''): void {
		// From storage, not memory: another tab may have changed it since.
		this.#set(addRule(loadUnavailable(), rule, label, new Date()));
	}

	remove(key: string): void {
		this.#set(removeRule(loadUnavailable(), key));
	}

	#set(items: Unavailable): void {
		this.items = items;
		saveUnavailable(items);
		localChanged();
	}
}

export const unavailableDates = new UnavailableDates();
