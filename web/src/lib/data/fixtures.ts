// Small hand-made records for tests.

import type { Artist, Gig, Venue } from './types';

export const VENUES: Record<string, Venue> = {
	paradiso: {
		slug: 'paradiso',
		name: 'Paradiso',
		city: 'Amsterdam',
		website: 'https://www.paradiso.nl',
		country: 'NL'
	},
	tivolivredenburg: {
		slug: 'tivolivredenburg',
		name: 'TivoliVredenburg',
		city: 'Utrecht',
		website: 'https://www.tivolivredenburg.nl',
		country: 'NL'
	}
};

export function gig(overrides: Partial<Gig> = {}): Gig {
	const venue = overrides.venue ?? 'paradiso';
	const source_id = overrides.source_id ?? '2900229';
	return {
		id: `${venue}:${source_id}`,
		place: venue,
		venue,
		source_id,
		title: 'Nobu',
		subtitle: null,
		start: '2026-10-03T20:30:00+02:00',
		doors: null,
		end: null,
		room: 'Kleine Zaal',
		city: VENUES[venue]?.city ?? null,
		performers: [],
		support: [],
		genres: [],
		categories: [],
		status: 'scheduled',
		availability: 'on_sale',
		price: { min_eur: 17, max_eur: 17, text: null },
		ticket_url: null,
		url: null,
		image: null,
		description: null,
		extra: {},
		lineup: { kind: 'concert', headliners: ['Nobu'], support: [], source: 'fake' },
		artists: [{ key: 'name:nobu', name: 'Nobu', role: 'headliner' }],
		...overrides
	};
}

export function artist(overrides: Partial<Artist> = {}): Artist {
	return {
		key: 'name:nobu',
		name: 'Nobu',
		match: null,
		musicbrainz: null,
		lastfm: null,
		top_tracks: null,
		wikipedia: null,
		gigs: [],
		...overrides
	};
}
