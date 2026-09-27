// The loaded data, indexed once: gigs sorted by start with everything the lists and
// filters need worked out up front.

import { localDate, localTime } from './dates';
import { GENRES, NO_GENRE_COLOUR, bucketsFor, gigLabels, type GenreId } from './genres';
import { isSoldOut, searchText, type Filterable, type FilterNames } from './filters';
import { isGeneric, styleKey, styleList, stylesFor, type Style, type StyleName } from './styles';
import { dict } from './own';
import { gigPath, slugify } from './slugs';
import type { Artist, ArtistsFile, Gig, GigsFile, Venue } from './types';

export interface GigView extends Filterable {
	id: string;
	href: string;
	venue: Venue | null;
	venueName: string;
	cityName: string;
	/** The name to put on the poster: the first headliner, else the title. */
	headliner: string;
	/** Support acts, by name. */
	support: string[];
	primary: GenreId | null;
	colour: string;
	/** Its styles by name, specific ones first (the catalogue's style list is made of these). */
	styleNames: StyleName[];
	/** A little detail for the row: up to two styles and the headliner's home town. */
	details: string[];
	/** A headliner's Wikipedia thumbnail, if any. */
	thumb: string | null;
	time: string;
	price: string | null;
	soldOut: boolean;
}

export interface City {
	key: string;
	name: string;
}

export interface Catalog {
	generated: string;
	venues: Record<string, Venue>;
	/** Venues by name. */
	venueList: Venue[];
	/** Cities by number of gigs, most first. */
	cities: City[];
	/** Sorted by start. */
	gigs: GigView[];
	byId: Map<string, GigView>;
	artists: Record<string, Artist>;
	/** The styles on offer (styles.ts), most gigs first. */
	styles: Style[];
	/** Styles by key. */
	styleByKey: Map<string, Style>;
}

const euro = (n: number) => (Number.isInteger(n) ? `€${n}` : `€${n.toFixed(2)}`);

export function formatPrice(gig: Gig): string | null {
	const { price } = gig;
	if (gig.availability === 'free') return 'Free';
	if (price?.min_eur != null) {
		const { min_eur: min, max_eur: max } = price;
		if (min === 0 && (max == null || max === 0)) return 'Free';
		return max != null && max > min ? `${euro(min)}–${euro(max).slice(1)}` : euro(min);
	}
	if (price?.text && /^(gratis|free|vrij(e toegang)?)$/i.test(price.text.trim())) return 'Free';
	if (price?.text && price.text.length <= 14) return price.text;
	return null;
}

/** Where a headliner comes from: "Glasgow". */
function origin(artist: Artist | undefined): string[] {
	const mb = artist?.musicbrainz;
	const place = mb?.begin_area || mb?.area;
	return place ? [place] : [];
}

/** Specific styles before a bucket's own name ("shoegaze" before "indie"), else in order. */
function specificFirst(names: StyleName[]): StyleName[] {
	return [...names.filter((n) => !isGeneric(n.key)), ...names.filter((n) => isGeneric(n.key))];
}

export function viewGig(
	gig: Gig,
	venues: Record<string, Venue>,
	artists: Record<string, Artist>
): GigView {
	const venue = venues[gig.venue] ?? null;
	const cityName = gig.city ?? venue?.city ?? '';
	const headRef = gig.artists.find((a) => a.role === 'headliner');
	const headArtist = headRef ? artists[headRef.key] : undefined;
	const support = gig.artists.filter((a) => a.role === 'support').map((a) => a.name);
	const labels = gigLabels(gig, artists);
	const buckets = bucketsFor(labels);
	const styleNames = specificFirst(stylesFor(labels));
	const primary = buckets[0] ?? null;
	const thumb =
		gig.artists
			.filter((a) => a.role === 'headliner')
			.map((a) => artists[a.key]?.wikipedia?.thumbnail)
			.find(Boolean) ?? null;
	const names = gig.artists.map((a) => a.name);
	const haystack = searchText(
		[
			gig.title,
			gig.subtitle,
			...names,
			...gig.performers,
			...gig.support,
			venue?.name ?? gig.venue,
			gig.room,
			cityName,
			...gig.genres
		]
			.filter(Boolean)
			.join(' \u0000 ')
	);
	return {
		gig,
		id: gig.id,
		href: gigPath(gig),
		date: localDate(gig.start),
		city: slugify(cityName),
		cityName,
		buckets,
		styles: styleNames.map((s) => s.key),
		styleNames,
		haystack,
		venue,
		venueName: venue?.name ?? gig.venue,
		headliner: headRef?.name ?? gig.title,
		support: support.length ? support : gig.support,
		primary,
		colour: primary ? GENRES[primary].colour : NO_GENRE_COLOUR,
		details: [...styleNames.slice(0, 2).map((s) => s.name), ...origin(headArtist)],
		thumb,
		time: localTime(gig.start),
		price: formatPrice(gig),
		soldOut: isSoldOut(gig)
	};
}

export function buildCatalog(gigsFile: GigsFile, artistsFile: ArtistsFile): Catalog {
	// Indexed by slugs and keys from the URL and the data: no prototype to answer "constructor".
	const venues = dict(gigsFile.venues);
	const artists = dict(artistsFile.artists);
	// Each ID once: lists key their rows by it (a repeat would stop the page rendering).
	const ids = new Set<string>();
	const gigs = gigsFile.gigs
		.filter((g) => !ids.has(g.id) && !!ids.add(g.id))
		.map((g) => viewGig(g, venues, artists))
		.sort((a, b) => a.gig.start.localeCompare(b.gig.start) || a.id.localeCompare(b.id));
	const cityCounts = new Map<string, City & { n: number }>();
	for (const v of gigs) {
		const c = cityCounts.get(v.city) ?? { key: v.city, name: v.cityName, n: 0 };
		c.n++;
		cityCounts.set(v.city, c);
	}
	const styles = styleList(gigs.map((v) => v.styleNames));
	return {
		generated: gigsFile.generated,
		venues,
		venueList: Object.values(venues).sort((a, b) => a.name.localeCompare(b.name)),
		cities: [...cityCounts.values()]
			.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
			.map(({ key, name }) => ({ key, name })),
		gigs,
		byId: new Map(gigs.map((v) => [v.id, v])),
		artists,
		styles,
		styleByKey: new Map(styles.map((s) => [s.key, s]))
	};
}

/** How to name a catalogue's cities, venues and styles in summaries and chips. */
export function filterNames(catalog: Catalog): FilterNames {
	return {
		city: (key) => catalog.cities.find((c) => c.key === key)?.name ?? key,
		venue: (slug) => catalog.venues[slug]?.name ?? slug,
		style: (slug) => catalog.styleByKey.get(styleKey(slug))?.name ?? slug
	};
}
