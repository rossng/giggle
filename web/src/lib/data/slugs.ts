// URL slugs for artists, gigs and venues.
//
//   /artists/nouvelle-vague--b017a7ae   name slug + first 8 characters of the MusicBrainz ID
//   /artists/kronkel-festival--x        an artist without a MusicBrainz match
//   /gigs/paradiso/2900229-nobu         the venue's own event ID + title slug
//   /venues/paradiso
//
// The readable part is decoration where an ID follows: links keep working when a name or
// title changes.

import type { Artist, Gig } from './types';

/**
 * A scraped or third-party URL, fit for an `href` or `src`: only http(s) URLs pass (a
 * `javascript:` or `data:` URL would run or smuggle content); anything else is undefined.
 */
export function externalHref(url: string | null | undefined): string | undefined {
	return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

/** "Sigur Rós & Friends!" → "sigur-ros-friends". */
export function slugify(text: string, max = 60): string {
	const slug = text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, ' ')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (slug.length <= max) return slug;
	return slug.slice(0, max).replace(/-[^-]*$/, '') || slug.slice(0, max);
}

const UNMATCHED = 'x';

export function artistSlug(artist: Pick<Artist, 'key' | 'name'>): string {
	const name = slugify(artist.name) || 'artist';
	const id = artist.key.startsWith('mb:') ? artist.key.slice(3, 11) : UNMATCHED;
	return `${name}--${id}`;
}

export function artistPath(artist: Pick<Artist, 'key' | 'name'>): string {
	return `/artists/${artistSlug(artist)}`;
}

/** Splits "nouvelle-vague--b017a7ae" into its name slug and ID part, or null. */
export function parseArtistSlug(slug: string): { name: string; id: string } | null {
	const at = slug.lastIndexOf('--');
	if (at <= 0) return null;
	const name = slug.slice(0, at);
	const id = slug.slice(at + 2).toLowerCase();
	if (!name || !(id === UNMATCHED || /^[0-9a-f]{8}$/.test(id))) return null;
	return { name, id };
}

export function findArtist(slug: string, artists: Record<string, Artist>): Artist | null {
	const parsed = parseArtistSlug(slug);
	if (!parsed) return null;
	const candidates = Object.values(artists).filter((a) =>
		parsed.id === UNMATCHED
			? a.key.startsWith('name:') && (slugify(a.name) || 'artist') === parsed.name
			: a.key.startsWith(`mb:${parsed.id}`)
	);
	// Two MBIDs can share 8 characters; prefer the one whose name matches too.
	return (
		candidates.find((a) => (slugify(a.name) || 'artist') === parsed.name) ?? candidates[0] ?? null
	);
}

export function gigSlug(gig: Pick<Gig, 'source_id' | 'title'>): string {
	const title = slugify(gig.title, 50);
	return title ? `${gig.source_id}-${title}` : gig.source_id;
}

export function gigPath(gig: Pick<Gig, 'venue' | 'source_id' | 'title'>): string {
	return `/gigs/${encodeURIComponent(gig.venue)}/${encodeURIComponent(gigSlug(gig))}`;
}

/** The gig at `venue` whose slug is `param`. Venue IDs can contain dashes themselves
 * ("dcb76623-e79a-…"), so the longest ID that prefixes `param` wins. */
export function findGig<T extends Pick<Gig, 'venue' | 'source_id'>>(
	venue: string,
	param: string,
	gigs: Iterable<T>
): T | null {
	let best: T | null = null;
	for (const gig of gigs) {
		if (gig.venue !== venue) continue;
		const id = gig.source_id;
		if (
			(param === id || param.startsWith(`${id}-`)) &&
			id.length > (best?.source_id.length ?? -1)
		) {
			best = gig;
		}
	}
	return best;
}

export function venuePath(slug: string): string {
	return `/venues/${encodeURIComponent(slug)}`;
}
