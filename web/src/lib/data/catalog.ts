// The loaded data, indexed once: gigs sorted by start with everything the lists and
// filters need worked out up front.

import { localDate, localTime } from './dates';
import { GENRES, NO_GENRE_COLOUR, gigBuckets, type GenreId } from './genres';
import { isSoldOut, searchText, type Filterable } from './filters';
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
	/** A few detailed labels for the row: venue genres or artist tags, origin, start year. */
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

/** A headliner's origin and start year: "Glasgow · 2019". */
function origin(artist: Artist | undefined): string[] {
	const mb = artist?.musicbrainz;
	if (!mb) return [];
	const out: string[] = [];
	const place = mb.begin_area || mb.area;
	if (place) out.push(place);
	if (mb.begin) out.push(mb.begin.slice(0, 4));
	return out;
}

function details(gig: Gig, headliner: Artist | undefined): string[] {
	const labels =
		gig.genres.length > 0
			? gig.genres
			: [...(headliner?.musicbrainz?.genres ?? []), ...(headliner?.lastfm?.tags ?? [])];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const label of labels) {
		const tag = label.toLowerCase().trim();
		if (tag && !seen.has(tag)) {
			seen.add(tag);
			tags.push(tag);
		}
		if (tags.length === 2) break;
	}
	return [...tags, ...origin(headliner)];
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
	const buckets = gigBuckets(gig, artists);
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
		haystack,
		venue,
		venueName: venue?.name ?? gig.venue,
		headliner: headRef?.name ?? gig.title,
		support: support.length ? support : gig.support,
		primary,
		colour: primary ? GENRES[primary].colour : NO_GENRE_COLOUR,
		details: details(gig, headArtist),
		thumb,
		time: localTime(gig.start),
		price: formatPrice(gig),
		soldOut: isSoldOut(gig)
	};
}

export function buildCatalog(gigsFile: GigsFile, artistsFile: ArtistsFile): Catalog {
	const { venues } = gigsFile;
	const { artists } = artistsFile;
	const gigs = gigsFile.gigs
		.map((g) => viewGig(g, venues, artists))
		.sort((a, b) => a.gig.start.localeCompare(b.gig.start) || a.id.localeCompare(b.id));
	const cityCounts = new Map<string, City & { n: number }>();
	for (const v of gigs) {
		const c = cityCounts.get(v.city) ?? { key: v.city, name: v.cityName, n: 0 };
		c.n++;
		cityCounts.set(v.city, c);
	}
	return {
		generated: gigsFile.generated,
		venues,
		venueList: Object.values(venues).sort((a, b) => a.name.localeCompare(b.name)),
		cities: [...cityCounts.values()]
			.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
			.map(({ key, name }) => ({ key, name })),
		gigs,
		byId: new Map(gigs.map((v) => [v.id, v])),
		artists
	};
}
