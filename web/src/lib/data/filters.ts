// The filter model shared by the agenda and the radio, and its URL form.
//
//   ?days=30&from=3&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz
//    &style=post-punk,shoegaze&q=nobu&hide=soldout&board=listen&order=mix&seed=k3x9
//
// `days` is the window's length and `from` its start, both relative to today, so a saved
// link keeps showing "the next month from three days out" as the days pass. Defaults are
// left out of the URL, and anything unknown or malformed is ignored. Everything here is
// pure: `parse`, `serialise` and `apply` never read the clock or the page.
//
// `hide=unavailable` leaves out gigs on the listener's own unavailable dates (unavailable.ts).
// Those aren't in the URL: a shared link hides the *viewer's* dates. `apply` and `facetCounts`
// take them, with the rest of what's the listener's own, as `Personal`. Likewise `board=listen`
// keeps only gigs with an artist the *viewer* marked listen more on their board (board.ts): the
// whole gig passes, line-up and all (the radio then plays just those artists: station.ts).
//
// Genres come at two levels: the coarse buckets (`genre`, genres.ts) and specific styles
// (`style`, styles.ts), each style belonging to one or more buckets. Together they are one
// facet, and a gig passes it when
//
//   - nothing is selected at either level, or
//   - it has any selected style (styles OR together), or
//   - it is in a selected bucket none of whose styles are selected.
//
// So a bucket on its own means all of it; picking styles within a bucket narrows that bucket
// to them (Indie + shoegaze = just shoegaze, Indie + Jazz + shoegaze = shoegaze or any jazz);
// and a style whose bucket isn't selected simply adds its gigs. Styles are matched by their
// spelling-free key (`styleKey`), so `style=postpunk` and `style=post-punk` are the same.

import { addDays, amsterdamDate } from './dates';
import { GENRES, isGenreId, type GenreId } from './genres';
import { bucketsForStyle, styleKey } from './styles';
import type { Gig, IsoDate } from './types';

export const HIDE_FLAGS = ['soldout', 'unavailable'] as const;
export type HideFlag = (typeof HIDE_FLAGS)[number];

/** Gigs by the listener's board: `listen`, those with an artist they marked listen more. */
export const BOARD_FILTERS = ['listen'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];

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
	/** Genre buckets; empty (with no styles) means every genre, including gigs without one. */
	genres: GenreId[];
	/** Specific styles, as slugs ("post-punk"); they narrow their buckets (see above). */
	styles: string[];
	/** Free-text search over titles, artists and venues. */
	q: string;
	/** `soldout`; `unavailable`: gigs on the listener's unavailable dates (see `apply`). */
	hide: HideFlag[];
	/** Only gigs by the listener's board (see `apply`); null for any gig. */
	board: BoardFilter | null;
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
	styles: [],
	q: '',
	hide: [],
	board: null,
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
	const board = params.get('board')?.trim().toLowerCase();
	const order = params.get('order');
	const seed = params.get('seed');
	return {
		days: integer(params.get('days'), 1, MAX_DAYS) ?? DEFAULT_DAYS,
		from: integer(params.get('from'), 0, MAX_FROM) ?? 0,
		cities: list(params, 'city', (v) => SLUG.test(v)),
		venues: list(params, 'venue', (v) => SLUG.test(v)),
		genres: list(params, 'genre', isGenreId) as GenreId[],
		styles: uniqueStyles(list(params, 'style', (v) => SLUG.test(v) && v.length <= 40)),
		q: cleanQuery(params.get('q') ?? ''),
		hide: list(params, 'hide', (v) => (HIDE_FLAGS as readonly string[]).includes(v)) as HideFlag[],
		board:
			board && (BOARD_FILTERS as readonly string[]).includes(board) ? (board as BoardFilter) : null,
		order: order && (ORDERS as readonly string[]).includes(order) ? (order as Order) : null,
		seed: seed && SEED.test(seed) ? seed : null
	};
}

/** Style slugs without two spellings of one style (the first, in sorted order, stays). */
function uniqueStyles(slugs: string[]): string[] {
	const seen = new Set<string>();
	return slugs.filter((slug) => {
		const key = styleKey(slug);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
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
		['genre', filters.genres],
		['style', filters.styles]
	];
	for (const [name, values] of lists) {
		if (values.length) params.set(name, [...new Set(values)].sort().join(','));
	}
	const q = cleanQuery(filters.q);
	if (q) params.set('q', q);
	if (filters.hide.length) params.set('hide', [...new Set(filters.hide)].sort().join(','));
	if (filters.board) params.set('board', filters.board);
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

/** Is this style (by any spelling) selected? */
export function hasStyle(filters: Pick<Filters, 'styles'>, slug: string): boolean {
	const key = styleKey(slug);
	return filters.styles.some((s) => styleKey(s) === key);
}

/** Toggle a style, matching by key so another spelling of it is removed too. */
export function toggleStyle(styles: readonly string[], slug: string): string[] {
	const key = styleKey(slug);
	const rest = styles.filter((s) => styleKey(s) !== key);
	return rest.length < styles.length ? rest : [...styles, slug].sort();
}

/** Selected styles that belong to `bucket` (they narrow it). */
export function stylesIn(filters: Pick<Filters, 'styles'>, bucket: GenreId): string[] {
	return filters.styles.filter((s) => bucketsForStyle(s).includes(bucket));
}

/**
 * The genre facet's state for one bucket: 'all' when selected on its own, 'some' when styles
 * within it are selected (it matches just those), or 'off'.
 */
export function bucketState(
	filters: Pick<Filters, 'genres' | 'styles'>,
	bucket: GenreId
): 'all' | 'some' | 'off' {
	if (stylesIn(filters, bucket).length) return 'some';
	return filters.genres.includes(bucket) ? 'all' : 'off';
}

/**
 * Tapping a bucket: off → all of it; all → off; some (narrowed to styles) → all of it again,
 * dropping the styles that narrowed it.
 */
export function toggleBucket(
	filters: Pick<Filters, 'genres' | 'styles'>,
	bucket: GenreId
): Pick<Filters, 'genres' | 'styles'> {
	const state = bucketState(filters, bucket);
	if (state === 'some') {
		const narrowing = new Set(stylesIn(filters, bucket));
		return {
			genres: filters.genres.includes(bucket) ? filters.genres : [...filters.genres, bucket].sort(),
			styles: filters.styles.filter((s) => !narrowing.has(s))
		};
	}
	return { genres: toggle(filters.genres, bucket), styles: filters.styles };
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
	/** Style keys (styles.ts `styleKey`), any that its labels name. */
	styles: readonly string[];
	/** Lowercase, accent-free text that `q` is matched against. */
	haystack: string;
}

/** Facets counted by `facetCounts`; 'genre' is buckets and styles together. */
export type Facet = 'city' | 'venue' | 'genre';

export function isSoldOut(gig: Gig): boolean {
	return gig.availability === 'sold_out'; // "unknown" counts as available
}

/** Lowercase, accent-free, for search. */
export function searchText(text: string): string {
	return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Is the listener unavailable on this (Amsterdam) date? From unavailable.ts. */
export type DateTest = (date: IsoDate) => boolean;

/** What the filters need that's the listener's own rather than the URL's. */
export interface Personal {
	/** Their unavailable dates, for `hide=unavailable`; without it, nothing is hidden. */
	unavailable?: DateTest;
	/** Artist keys they marked listen more, for `board=listen`; without it, nobody is. */
	listenMore?: ReadonlySet<string>;
}

function predicate(
	filters: Filters,
	now: Date,
	{ unavailable, listenMore }: Personal,
	skip?: Facet
): (item: Filterable) => boolean {
	const { first, last } = dateWindow(filters, now);
	const cities = skip === 'city' ? null : new Set(filters.cities);
	const venues = skip === 'venue' ? null : new Set(filters.venues);
	const genre = skip === 'genre' ? null : genreTest(filters);
	const words = searchText(cleanQuery(filters.q)).split(' ').filter(Boolean);
	const hideSoldOut = filters.hide.includes('soldout');
	const away = filters.hide.includes('unavailable') ? unavailable : undefined;
	const mine = filters.board === 'listen' ? (listenMore ?? new Set<string>()) : null;
	return (item) =>
		item.date >= first &&
		item.date <= last &&
		(!cities?.size || cities.has(item.city)) &&
		(!venues?.size || venues.has(item.gig.venue)) &&
		(!genre || genre(item)) &&
		!(hideSoldOut && isSoldOut(item.gig)) &&
		!away?.(item.date) &&
		(!mine || item.gig.artists.some((a) => mine.has(a.key))) &&
		words.every((w) => item.haystack.includes(w));
}

/** The genre facet's test (see the top of this file), or null when it lets everything through. */
function genreTest(
	filters: Pick<Filters, 'genres' | 'styles'>
): ((item: Pick<Filterable, 'buckets' | 'styles'>) => boolean) | null {
	if (!filters.genres.length && !filters.styles.length) return null;
	const styles = new Set(filters.styles.map(styleKey));
	const narrowed = new Set(filters.styles.flatMap(bucketsForStyle));
	const whole = new Set(filters.genres.filter((g) => !narrowed.has(g)));
	return (item) => item.styles.some((s) => styles.has(s)) || item.buckets.some((b) => whole.has(b));
}

/** The gigs `filters` let through, in their given order. */
export function apply<T extends Filterable>(
	filters: Filters,
	gigs: readonly T[],
	now: Date,
	personal: Personal = {}
): T[] {
	return gigs.filter(predicate(filters, now, personal));
}

export interface FacetCounts {
	city: Map<string, number>;
	venue: Map<string, number>;
	genre: Map<GenreId, number>;
	/** By style key. */
	style: Map<string, number>;
}

/** For each facet, how many gigs each value would show with every other filter applied. */
export function facetCounts(
	filters: Filters,
	gigs: readonly Filterable[],
	now: Date,
	personal: Personal = {}
): FacetCounts {
	const counts: FacetCounts = {
		city: new Map(),
		venue: new Map(),
		genre: new Map(),
		style: new Map()
	};
	const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);
	const byCity = predicate(filters, now, personal, 'city');
	const byVenue = predicate(filters, now, personal, 'venue');
	const byGenre = predicate(filters, now, personal, 'genre');
	for (const item of gigs) {
		if (byCity(item)) bump(counts.city, item.city);
		if (byVenue(item)) bump(counts.venue, item.gig.venue);
		if (byGenre(item)) {
			for (const b of item.buckets) bump(counts.genre, b);
			for (const s of item.styles) bump(counts.style, s);
		}
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

/** How `summarise` and the active-filter chips name things (keys and slugs by default). */
export interface FilterNames {
	city?: (key: string) => string;
	venue?: (slug: string) => string;
	style?: (slug: string) => string;
}

/** The genre facet in words: whole buckets by label, then styles ("Jazz, post-punk"). */
export function genreWords(filters: Pick<Filters, 'genres' | 'styles'>, names: FilterNames = {}) {
	const narrowed = new Set(filters.styles.flatMap(bucketsForStyle));
	return [
		...filters.genres.filter((g) => !narrowed.has(g)).map((g) => GENRES[g].label),
		...filters.styles.map(names.style ?? ((s) => s))
	];
}

/** Drops a style; a bucket it narrowed goes too once none of its styles is left (so removing
 * the "shoegaze" chip doesn't widen the list to all of Indie). */
export function removeStyle(
	filters: Pick<Filters, 'genres' | 'styles'>,
	slug: string
): Pick<Filters, 'genres' | 'styles'> {
	const key = styleKey(slug);
	const styles = filters.styles.filter((s) => styleKey(s) !== key);
	const left = new Set(styles.flatMap(bucketsForStyle));
	const drop = new Set(bucketsForStyle(slug).filter((b) => !left.has(b)));
	return { genres: filters.genres.filter((g) => !drop.has(g)), styles };
}

export const BOARD_LABELS: Readonly<Record<BoardFilter, string>> = {
	listen: 'My listen-more artists'
};

/** One active filter, as a removable chip. */
export interface ActiveFilter {
	/** Unique among the chips ("city:utrecht"). */
	id: string;
	label: string;
	/** A genre colour, for buckets and styles. */
	colour: string | null;
	/** The change that removes it. */
	without: Partial<Filters>;
}

/**
 * The filters beyond the search and the time window, one chip each: the board's, whole buckets,
 * styles, cities, venues and the hide flags.
 */
export function activeFilters(filters: Filters, names: FilterNames = {}): ActiveFilter[] {
	const narrowed = new Set(filters.styles.flatMap(bucketsForStyle));
	const out: ActiveFilter[] = [];
	if (filters.board) {
		out.push({
			id: `board:${filters.board}`,
			label: BOARD_LABELS[filters.board],
			colour: null,
			without: { board: null }
		});
	}
	for (const g of filters.genres) {
		if (narrowed.has(g)) continue;
		out.push({
			id: `genre:${g}`,
			label: GENRES[g].label,
			colour: GENRES[g].colour,
			without: { genres: filters.genres.filter((x) => x !== g) }
		});
	}
	for (const s of filters.styles) {
		const bucket = bucketsForStyle(s)[0];
		out.push({
			id: `style:${s}`,
			label: (names.style ?? ((x) => x))(s),
			colour: bucket ? GENRES[bucket].colour : null,
			without: removeStyle(filters, s)
		});
	}
	for (const c of filters.cities) {
		out.push({
			id: `city:${c}`,
			label: (names.city ?? ((x) => x))(c),
			colour: null,
			without: { cities: filters.cities.filter((x) => x !== c) }
		});
	}
	for (const v of filters.venues) {
		out.push({
			id: `venue:${v}`,
			label: (names.venue ?? ((x) => x))(v),
			colour: null,
			without: { venues: filters.venues.filter((x) => x !== v) }
		});
	}
	const hides: Record<HideFlag, string> = {
		soldout: 'No sold out',
		unavailable: 'Not on my unavailable dates'
	};
	for (const h of filters.hide) {
		out.push({
			id: `hide:${h}`,
			label: hides[h],
			colour: null,
			without: { hide: filters.hide.filter((x) => x !== h) }
		});
	}
	return out;
}

/** A one-line, human description: "Next 3 months from +3 days · Amsterdam · Indie, Jazz"
 * ("My listen-more artists · Next 3 months" with `board`). */
export function summarise(filters: Filters, names: FilterNames = {}): string {
	const parts = filters.board ? [BOARD_LABELS[filters.board]] : [];
	parts.push(
		windowLabel(filters.days) +
			(filters.from ? ` from ${filters.from === 7 ? '+1 week' : `+${filters.from} days`}` : '')
	);
	if (filters.cities.length) parts.push(filters.cities.map(names.city ?? ((c) => c)).join(', '));
	const genres = genreWords(filters, names);
	if (genres.length) parts.push(genres.join(', '));
	if (filters.venues.length) {
		parts.push(
			filters.venues.length > 3
				? `${filters.venues.length} venues`
				: filters.venues.map(names.venue ?? ((v) => v)).join(', ')
		);
	}
	if (filters.q) parts.push(`“${filters.q}”`);
	if (filters.hide.includes('soldout')) parts.push('no sold-out gigs');
	if (filters.hide.includes('unavailable')) parts.push('not on my unavailable dates');
	if (filters.order) parts.push(`order: ${filters.order}`);
	return parts.join(' · ');
}
