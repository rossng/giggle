import { describe, expect, it } from 'vitest';
import { buildCatalog, filterNames, formatPrice, viewGig } from './catalog';
import { VENUES, artist, gig } from './fixtures';

describe('formatPrice', () => {
	it('formats what the venue gives', () => {
		expect(formatPrice(gig())).toBe('€17');
		expect(formatPrice(gig({ price: { min_eur: 21.5, max_eur: 21.5, text: null } }))).toBe(
			'€21.50'
		);
		expect(formatPrice(gig({ price: { min_eur: 18, max_eur: 20, text: null } }))).toBe('€18–20');
		expect(formatPrice(gig({ price: { min_eur: 0, max_eur: 0, text: null } }))).toBe('Free');
		expect(formatPrice(gig({ availability: 'free', price: null }))).toBe('Free');
		expect(formatPrice(gig({ price: { min_eur: null, max_eur: null, text: 'Gratis' } }))).toBe(
			'Free'
		);
		expect(formatPrice(gig({ price: null }))).toBeNull();
		expect(
			formatPrice(
				gig({ price: { min_eur: null, max_eur: null, text: 'TICKET: €18.00; DOORSALE: €20.00' } })
			)
		).toBeNull();
	});
});

describe('viewGig', () => {
	it('works out what the agenda row shows', () => {
		const artists = {
			'mb:1': artist({
				key: 'mb:1',
				name: 'Glass Harbour',
				musicbrainz: {
					mbid: '1',
					name: 'Glass Harbour',
					type: 'Group',
					country: 'GB',
					area: 'United Kingdom',
					begin_area: 'Glasgow',
					begin: '2019-03',
					genres: ['post-punk'],
					tags: [],
					links: {}
				},
				wikipedia: {
					title: 'Glass Harbour',
					lang: 'en',
					description: null,
					extract: '…',
					url: null,
					thumbnail: 'https://upload.wikimedia.org/x.jpg'
				}
			})
		};
		const v = viewGig(
			gig({
				title: 'Glass Harbour + Velvet Tram',
				availability: 'sold_out',
				artists: [
					{ key: 'mb:1', name: 'Glass Harbour', role: 'headliner' },
					{ key: 'name:velvettram', name: 'Velvet Tram', role: 'support' }
				]
			}),
			VENUES,
			artists
		);
		expect(v).toMatchObject({
			href: '/gigs/paradiso/2900229-glass-harbour-velvet-tram',
			date: '2026-10-03',
			time: '20:30',
			city: 'amsterdam',
			venueName: 'Paradiso',
			headliner: 'Glass Harbour',
			support: ['Velvet Tram'],
			buckets: ['rock'],
			primary: 'rock',
			styles: ['postpunk'],
			details: ['post-punk', 'Glasgow'],
			thumb: 'https://upload.wikimedia.org/x.jpg',
			soldOut: true
		});
	});
});

describe('buildCatalog', () => {
	it('sorts gigs by start and lists cities by size', () => {
		const catalog = buildCatalog(
			{
				generated: '2026-09-26T05:00:00+02:00',
				since: '2026-09-26',
				venues: VENUES,
				gigs: [
					gig({ source_id: '2', start: '2026-10-05T20:00:00+02:00' }),
					gig({ source_id: '1', venue: 'tivolivredenburg', start: '2026-10-04T20:00:00+02:00' }),
					gig({ source_id: '3', start: '2026-10-06T20:00:00+02:00' })
				]
			},
			{ artists: {} }
		);
		expect(catalog.gigs.map((v) => v.gig.source_id)).toEqual(['1', '2', '3']);
		expect(catalog.cities).toEqual([
			{ key: 'amsterdam', name: 'Amsterdam' },
			{ key: 'utrecht', name: 'Utrecht' }
		]);
		expect(catalog.venueList.map((v) => v.slug)).toEqual(['paradiso', 'tivolivredenburg']);
		expect(catalog.byId.get('paradiso:3')?.gig.source_id).toBe('3');
	});

	it('offers the styles on enough gigs, with names for chips', () => {
		const labelled = (id: string, genres: string[]) => gig({ source_id: id, genres });
		const catalog = buildCatalog(
			{
				generated: '2026-09-26T05:00:00+02:00',
				since: '2026-09-26',
				venues: VENUES,
				gigs: [
					labelled('1', ['Indie - Shoegaze/Postpunk']),
					labelled('2', ['Post Punk', 'post-punk']),
					labelled('3', ['Postpunk / Shoegaze']),
					labelled('4', ['Rock'])
				]
			},
			{ artists: {} }
		);
		// Shoegaze is on two gigs only; "rock" names a whole bucket.
		expect(catalog.styles.map((s) => [s.slug, s.n])).toEqual([['post-punk', 3]]);
		expect(catalog.byId.get('paradiso:1')?.details).toEqual(['shoegaze', 'post-punk']);
		const names = filterNames(catalog);
		expect(names.style?.('postpunk')).toBe('post-punk');
		expect(names.style?.('nope')).toBe('nope');
		expect(names.venue?.('paradiso')).toBe('Paradiso');
	});

	it('lists specific styles before a bucket name on the row', () => {
		const v = viewGig(gig({ genres: ['Pop / Rock', 'Dream pop'] }), VENUES, {});
		expect(v.details).toEqual(['dream pop', 'pop']);
	});
});
