// A radio station is the shared filter model (filters.ts) plus a play order and a seed,
// all in the URL: /radio?days=14&city=amsterdam&genre=jazz&order=shuffle&seed=k3x9.
// Mix is the default order and is left out; the seed is only written once the listener
// asks for a (re)shuffle, so plain station links stay short.

import { filtersKey, normaliseSeed, type RadioOrder } from '@giggle/radio-core';
import { parse, toQuery, type Filters } from '$lib/data/filters';

export const DEFAULT_ORDER: RadioOrder = 'mix';

export interface Station {
	/** The gig filters, without `order` and `seed`. */
	filters: Filters;
	order: RadioOrder;
	/** Whether the URL named the order (so a saved session in another order isn't used). */
	orderGiven: boolean;
	/** The seed from the URL, or null when it names none. */
	seed: number | null;
}

/** Seeds are 32-bit unsigned integers; in the URL, base 36 ("k3x9"). */
export function seedToText(seed: number): string {
	return normaliseSeed(seed).toString(36);
}

/** A URL seed as a number: base 36 when it is one (round-tripping `seedToText`), else a hash. */
export function seedFromText(text: string): number {
	if (/^[0-9a-z]{1,7}$/.test(text)) {
		const n = parseInt(text, 36);
		if (n <= 0xffffffff) return n;
	}
	// FNV-1a, so any valid `seed` parameter (letters, digits, - and _) gives a stable order.
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function stationFromParams(params: URLSearchParams): Station {
	const parsed = parse(params);
	return {
		filters: { ...parsed, order: null, seed: null },
		order: parsed.order ?? DEFAULT_ORDER,
		orderGiven: parsed.order !== null,
		seed: parsed.seed === null ? null : seedFromText(parsed.seed)
	};
}

/** The query string for a station ("" for the default one). */
export function stationQuery(station: {
	filters: Filters;
	order: RadioOrder;
	seed: number | null;
}): string {
	return toQuery({
		...station.filters,
		order: station.order === DEFAULT_ORDER ? null : station.order,
		seed: station.seed === null || station.order === 'date' ? null : seedToText(station.seed)
	});
}

/** Identifies the station's gigs (not its order), for saving and resuming sessions. */
export function stationKey(filters: Filters): string {
	return filtersKey({ ...filters, order: null, seed: null });
}

export const ORDER_LABELS: Readonly<Record<RadioOrder, string>> = {
	date: 'Soonest',
	mix: 'Mix',
	shuffle: 'Shuffle'
};

export const ORDER_DESCRIPTIONS: Readonly<Record<RadioOrder, string>> = {
	date: 'soonest gigs first',
	mix: 'shuffled, leaning towards gigs coming up soon and artists you want to hear more of',
	shuffle: 'shuffled'
};
