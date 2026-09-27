import { describe, expect, it } from 'vitest';
import { artist, gig } from './fixtures';
import {
	artistPath,
	externalHref,
	artistSlug,
	findArtist,
	findGig,
	gigPath,
	gigSlug,
	parseArtistSlug,
	slugify
} from './slugs';

describe('slugify', () => {
	it('lowercases, strips accents and joins words with dashes', () => {
		expect(slugify('Sigur Rós & Friends!')).toBe('sigur-ros-friends');
		expect(slugify('  --The   Cure-- ')).toBe('the-cure');
		expect(slugify('坂本')).toBe('');
	});

	it('cuts long slugs at a word boundary', () => {
		expect(slugify('one two three four', 12)).toBe('one-two');
	});
});

describe('artist slugs', () => {
	const vague = artist({ key: 'mb:b017a7ae-1234-5678-9abc-def012345678', name: 'Nouvelle Vague' });
	const kronkel = artist({ key: 'name:kronkelfestival', name: 'KRONKEL FESTIVAL' });

	it('ends in the MBID prefix, or x for unmatched artists', () => {
		expect(artistSlug(vague)).toBe('nouvelle-vague--b017a7ae');
		expect(artistSlug(kronkel)).toBe('kronkel-festival--x');
		expect(artistPath(vague)).toBe('/artists/nouvelle-vague--b017a7ae');
		expect(artistSlug(artist({ key: 'name:', name: '坂本' }))).toBe('artist--x');
	});

	it('parses', () => {
		expect(parseArtistSlug('nouvelle-vague--b017a7ae')).toEqual({
			name: 'nouvelle-vague',
			id: 'b017a7ae'
		});
		expect(parseArtistSlug('kronkel-festival--x')).toEqual({ name: 'kronkel-festival', id: 'x' });
		expect(parseArtistSlug('nouvelle-vague')).toBeNull();
		expect(parseArtistSlug('--x')).toBeNull();
		expect(parseArtistSlug('a--zzz')).toBeNull();
	});

	it('resolves against artists.json', () => {
		const other = artist({ key: 'mb:b017a7ae-ffff-ffff-ffff-ffffffffffff', name: 'Someone Else' });
		const artists = Object.fromEntries([vague, kronkel, other].map((a) => [a.key, a]));
		expect(findArtist('nouvelle-vague--b017a7ae', artists)).toBe(vague);
		expect(findArtist('someone-else--b017a7ae', artists)).toBe(other);
		// A renamed artist still resolves by ID
		expect(findArtist('old-name--b017a7ae', artists)?.key).toMatch(/^mb:b017a7ae/);
		expect(findArtist('kronkel-festival--x', artists)).toBe(kronkel);
		expect(findArtist('nobody--x', artists)).toBeNull();
		expect(findArtist('nobody--00000000', artists)).toBeNull();
	});
});

describe('gig slugs', () => {
	it('joins the venue ID and the title', () => {
		const g = gig({ venue: 'paradiso', source_id: '2900229', title: 'Nobu' });
		expect(gigSlug(g)).toBe('2900229-nobu');
		expect(gigPath(g)).toBe('/gigs/paradiso/2900229-nobu');
	});

	it('encodes IDs with odd characters', () => {
		const g = gig({ venue: 'occii', source_id: '102229-1780394431@occii.org', title: 'KRONKEL' });
		expect(gigPath(g)).toBe('/gigs/occii/102229-1780394431%40occii.org-kronkel');
	});

	it('finds the gig, preferring the longest matching ID', () => {
		const gigs = [
			gig({ venue: 'melkweg', source_id: 'dcb76623', title: 'A' }),
			gig({ venue: 'melkweg', source_id: 'dcb76623-e79a', title: 'B' }),
			gig({ venue: 'paradiso', source_id: '2900229', title: 'Nobu' })
		];
		expect(findGig('melkweg', 'dcb76623-e79a-b', gigs)?.title).toBe('B');
		expect(findGig('melkweg', 'dcb76623-a', gigs)?.title).toBe('A');
		expect(findGig('paradiso', '2900229-renamed-title', gigs)?.title).toBe('Nobu');
		expect(findGig('paradiso', '2900229', gigs)?.title).toBe('Nobu');
		expect(findGig('melkweg', '2900229-nobu', gigs)).toBeNull();
		expect(findGig('paradiso', '29002', gigs)).toBeNull();
	});
});

describe('externalHref', () => {
	it('lets http(s) URLs through and nothing else', () => {
		expect(externalHref('https://paradiso.nl/tickets')).toBe('https://paradiso.nl/tickets');
		expect(externalHref(' HTTP://example.com ')).toBe('HTTP://example.com');
		for (const bad of [
			'javascript:alert(1)',
			' JavaScript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'//evil.example',
			'/relative',
			'',
			null,
			undefined
		]) {
			expect(externalHref(bad)).toBeUndefined();
		}
	});
});
