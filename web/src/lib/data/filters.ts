// The filter model shared by the agenda and the radio, and its URL form.
//
//   ?days=30&from=3&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz&q=nobu
//    &hide=soldout&order=mix&seed=k3x9
//
// `days` is the window's length and `from` its start, both relative to today, so a saved
// link keeps showing "the next month from three days out" as the days pass. Defaults are
// left out of the URL, and anything unknown or malformed is ignored. Everything here is
// pure: `parse`, `serialise` and `apply` never read the clock or the page.

import { addDays, amsterdamDate } from './dates';
import { GENRES, isGenreId, type GenreId } from './genres';
import type { Gig, IsoDate } from './types';

export const HIDE_FLAGS = ['soldout', 'unavailable'] as const;
export type HideFlag = (typeof HIDE_FLAGS)[number];

export const ORDERS = ['date', 'mix', 'shuffle'] as const;
export type Order = (typeof ORDERS)[number];

export interface Filters {
	/** Window length in days. */
	days: number;
	/** Window start, in days from today. */
	from: number;
	/** City keys (lowercase slugs); empty means every city. */
	cities: string[];
	/** Venue slugs; empty means every venue. */
	venues: string[];
	/** Genre buckets; empty means every genre, including gigs without one. */
	genres: GenreId[];
	/** Free-text search over titles, artists and venues. */
	q: string;
	/** `unavailable` is reserved for per-user unavailable dates, which don't exist yet:
	 * it round-trips through the URL but filters nothing. */
	hide: HideFlag[];
	/** Radio play order; null means the page's own default. */
	order: Order | null;
	/** Shuffle seed, so a shared station plays in the same order. */
	seed: string | null;
}

export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 730;
export const MAX_FROM = 365;
export const MAX_QUERY = 100;

export const DEFAULT_FILTERS: Readonly<Filters> = Object.freeze({
	days: DEFAULT_DAYS,
	from: 0,
	cities: [],
	venues: [],
	genres: [],
	q: '',
	hide: [],
	order: null,
	seed: null
});

export const DAY_PRESETS = [
	{ days: 14, label: '2 wks' },
	{ days: 30, label: '1 mo' },
	{ days: 90, label: '3 mo' },
	{ days: 180, label: '6 mo' }
] as const;

export const FROM_PRESETS = [
	{ from: 0, label: 'Today' },
	{ from: 3, label: '+3 days' },
	{ from: 7, label: '+1 wk' }
] as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEED = /^[A-Za-z0-9_-]{1,32}$/;

function integer(value: string | null, min: number, max: number): number | null {
	if (value === null || !/^\d{1,4}$/.test(value.trim())) return null;
	const n = Number(value.trim());
	return n >= min && n <= max ? n : null;
}

/** A comma list, possibly repeated (`?city=a,b&city=c`), trimmed, deduplicated and sorted. */
function list(params: URLSearchParams, name: string, valid: (v: string) => boolean): string[] {
	const values = params
		.getAll(name)
		.flatMap((v) => v.split(','))
		.map((v) => v.trim().toLowerCase())
		.filter((v) => v && valid(v));
	return [...new Set(values)].sort();
}

export function parse(params: URLSearchParams): Filters {
	const order = params.get('order');
	const seed = params.get('seed');
	return {
		days: integer(params.get('days'), 1, MAX_DAYS) ?? DEFAULT_DAYS,
		from: integer(params.get('from'), 0, MAX_FROM) ?? 0,
		cities: list(params, 'city', (v) => SLUG.test(v)),
		venues: list(params, 'venue', (v) => SLUG.test(v)),
		genres: list(params, 'genre', isGenreId) as GenreId[],
		q: cleanQuery(params.get('q') ?? ''),
		hide: list(params, 'hide', (v) => (HIDE_FLAGS as readonly string[]).includes(v)) as HideFlag[],
		order: order && (ORDERS as readonly string[]).includes(order) ? (order as Order) : null,
		seed: seed && SEED.test(seed) ? seed : null
	};
}

export function cleanQuery(q: string): string {
	return q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

/** The URL form of `filters`, without defaults, in a fixed order. */
export function serialise(filters: Filters): URLSearchParams {
	const params = new URLSearchParams();
	if (filters.days !== DEFAULT_DAYS) params.set('days', String(filters.days));
	if (filters.from !== 0) params.set('from', String(filters.from));
	const lists: [string, string[]][] = [
		['city', filters.cities],
		['venue', filters.venues],
		['genre', filters.genres]
	];
	for (const [name, values] of lists) {
		if (values.length) params.set(name, [...new Set(values)].sort().join(','));
	}
	const q = cleanQuery(filters.q);
	if (q) params.set('q', q);
	if (filters.hide.length) params.set('hide', [...new Set(filters.hide)].sort().join(','));
	if (filters.order) params.set('order', filters.order);
	if (filters.seed) params.set('seed', filters.seed);
	return params;
}

/** "?city=amsterdam,utrecht&hide=soldout", or "" for the defaults. Commas stay readable. */
export function toQuery(filters: Filters): string {
	const text = serialise(filters).toString().replaceAll('%2C', ',');
	return text ? `?${text}` : '';
}

export function isDefault(filters: Filters): boolean {
	return toQuery(filters) === '';
}

/** Toggle one value in a list filter. */
export function toggle<T extends string>(values: readonly T[], value: T): T[] {
	return values.includes(value) ? values.filter((v) => v !== value) : [...values, value].sort();
}

export interface DateWindow {
	/** First day shown. */
	first: IsoDate;
	/** Last day shown (inclusive). */
	last: IsoDate;
}

export function dateWindow(filters: Pick<Filters, 'days' | 'from'>, now: Date): DateWindow {
	const first = addDays(amsterdamDate(now), filters.from);
	return { first, last: addDays(first, filters.days - 1) };
}

/** What `apply` needs to know about a gig beyond its record. */
export interface Filterable {
	gig: Gig;
	/** Local date, "YYYY-MM-DD". */
	date: IsoDate;
	/** City key: the slug of the gig's (or its venue's) city. */
	city: string;
	buckets: readonly GenreId[];
	/** Lowercase, accent-free text that `q` is matched against. */
	haystack: string;
}

export type Facet = 'city' | 'venue' | 'genre';

export function isSoldOut(gig: Gig): boolean {
	return gig.availability === 'sold_out'; // "unknown" counts as available
}

/** Lowercase, accent-free, for search. */
export function searchText(text: string): string {
	return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function predicate(filters: Filters, now: Date, skip?: Facet): (item: Filterable) => boolean {
	const { first, last } = dateWindow(filters, now);
	const cities = skip === 'city' ? null : new Set(filters.cities);
	const venues = skip === 'venue' ? null : new Set(filters.venues);
	const genres = skip === 'genre' ? null : new Set(filters.genres);
	const words = searchText(cleanQuery(filters.q)).split(' ').filter(Boolean);
	const hideSoldOut = filters.hide.includes('soldout');
	return (item) =>
		item.date >= first &&
		item.date <= last &&
		(!cities?.size || cities.has(item.city)) &&
		(!venues?.size || venues.has(item.gig.venue)) &&
		(!genres?.size || item.buckets.some((b) => genres.has(b))) &&
		!(hideSoldOut && isSoldOut(item.gig)) &&
		words.every((w) => item.haystack.includes(w));
}

/** The gigs `filters` let through, in their given order. */
export function apply<T extends Filterable>(filters: Filters, gigs: readonly T[], now: Date): T[] {
	return gigs.filter(predicate(filters, now));
}

export interface FacetCounts {
	city: Map<string, number>;
	venue: Map<string, number>;
	genre: Map<GenreId, number>;
}

/** For each facet, how many gigs each value would show with every other filter applied. */
export function facetCounts(filters: Filters, gigs: readonly Filterable[], now: Date): FacetCounts {
	const counts: FacetCounts = { city: new Map(), venue: new Map(), genre: new Map() };
	const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
	const byCity = predicate(filters, now, 'city');
	const byVenue = predicate(filters, now, 'venue');
	const byGenre = predicate(filters, now, 'genre');
	for (const item of gigs) {
		if (byCity(item)) bump(counts.city, item.city);
		if (byVenue(item)) bump(counts.venue, item.gig.venue);
		if (byGenre(item)) for (const b of item.buckets) bump(counts.genre, b);
	}
	return counts;
}

function windowLabel(days: number): string {
	const preset = DAY_PRESETS.find((p) => p.days === days);
	if (preset?.days === 14) return 'Next 2 weeks';
	if (preset?.days === 30) return 'Next month';
	if (preset?.days === 90) return 'Next 3 months';
	if (preset?.days === 180) return 'Next 6 months';
	return `Next ${days} day${days === 1 ? '' : 's'}`;
}

/** A one-line, human description: "Next 3 months from +3 days · Amsterdam · Indie, Jazz". */
export function summarise(
	filters: Filters,
	names: { city?: (key: string) => string; venue?: (slug: string) => string } = {}
): string {
	const parts = [
		windowLabel(filters.days) +
			(filters.from ? ` from ${filters.from === 7 ? '+1 week' : `+${filters.from} days`}` : '')
	];
	if (filters.cities.length) parts.push(filters.cities.map(names.city ?? ((c) => c)).join(', '));
	if (filters.genres.length) parts.push(filters.genres.map((g) => GENRES[g].label).join(', '));
	if (filters.venues.length) {
		parts.push(
			filters.venues.length > 3
				? `${filters.venues.length} venues`
				: filters.venues.map(names.venue ?? ((v) => v)).join(', ')
		);
	}
	if (filters.q) parts.push(`“${filters.q}”`);
	if (filters.hide.includes('soldout')) parts.push('no sold-out gigs');
	if (filters.order) parts.push(`order: ${filters.order}`);
	return parts.join(' · ');
}
