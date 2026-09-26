import { describe, expect, it } from 'vitest';
import { artist, gig } from './fixtures';
import { GENRES, GENRE_IDS, bucketsFor, bucketsForLabel, gigBuckets } from './genres';

describe('bucketsForLabel', () => {
	it.each([
		// Venue labels, as they appear in the data
		['Pop / Rock', ['pop', 'rock']],
		['Alternative / Indie / Rock', ['indie', 'rock']],
		['Hiphop - Nederlandstalige Hiphop', ['hiphop', 'dutch']],
		['Nederlands', ['dutch']],
		['Pop - Nederlandstalige act', ['pop', 'dutch']],
		['Metal/Punk/Heavy', ['rock']],
		['LOUD', ['rock']],
		['Singer-Songwriter', ['folk']],
		['Roots/Blues/Americana', ['folk']],
		['Soul / Jazz / Funk', ['soul', 'jazz']],
		['Hiphop / r&b', ['hiphop']],
		['Afro / Reggae / Dancehall / Latin', ['global']],
		['Latijns-Amerikaans/Caribbean', ['global']],
		['Midden Oosten/Noord Afrika', ['global']],
		['Elektronisch', ['electronic']],
		['Electropop', ['electronic', 'pop']],
		["Classic Pop (60's-90's)", ['pop']],
		['Impro Focus', ['jazz', 'experimental']],
		['Neoklassiek', ['experimental']],
		['Indie - Shoegaze/Postpunk/Dark Indie', ['indie', 'rock']],
		['Wave', ['rock']],
		['Poppunk', ['rock']],
		['Linedance', ['folk']],
		['UK Garage', ['electronic']],
		['Garagerock', ['rock']],
		['Italodisco', ['electronic']],
		['Alt-RnB', ['hiphop']],
		['Trip-hop', ['electronic']],
		// MusicBrainz / Last.fm tags
		['post-punk', ['rock']],
		['hip hop', ['hiphop']],
		['dream pop', ['indie', 'pop']],
		['pop punk', ['rock']],
		['synthwave', ['electronic']],
		['world music', ['global']],
		// Nothing to go on
		['Headliners', []],
		['Live after Lowlands', []],
		['seen live', []],
		['Concert', []]
	])('%s → %j', (label, expected) => {
		expect(bucketsForLabel(label)).toEqual(expected);
	});

	it('ignores case and accents', () => {
		expect(bucketsForLabel('FORRÓ')).toEqual(['global']);
		expect(bucketsForLabel('ÉLECTRONIQUE')).toEqual(['electronic']);
	});
});

describe('bucketsFor', () => {
	it('keeps first-seen order without repeats', () => {
		expect(bucketsFor(['Jazz', 'Soul / Jazz / Funk', 'Pop'])).toEqual(['jazz', 'soul', 'pop']);
	});
});

describe('gigBuckets', () => {
	it("uses the venue's labels first, then its headliners' tags", () => {
		const g = gig({
			genres: ['Indie'],
			categories: ['Concert'],
			artists: [
				{ key: 'mb:1', name: 'A', role: 'headliner' },
				{ key: 'mb:2', name: 'B', role: 'support' }
			]
		});
		const artists = {
			'mb:1': artist({
				key: 'mb:1',
				lastfm: {
					name: 'A',
					mbid: null,
					url: null,
					listeners: 1,
					playcount: 1,
					tags: ['jazz', 'seen live'],
					similar: [],
					bio: null
				}
			}),
			'mb:2': artist({ key: 'mb:2', lastfm: null, musicbrainz: null })
		};
		expect(gigBuckets(g, artists)).toEqual(['indie', 'jazz']);
	});

	it('falls back on categories only when the venue gives no genres', () => {
		expect(gigBuckets(gig({ genres: ['Indie'], categories: ['Pop'] }), {})).toEqual(['indie']);
		expect(gigBuckets(gig({ genres: [], categories: ['Jazz'] }), {})).toEqual(['jazz']);
	});

	it('leaves gigs with nothing to go on without a bucket', () => {
		expect(gigBuckets(gig(), {})).toEqual([]);
	});
});

describe('GENRES', () => {
	it('describes every bucket with a colour', () => {
		for (const id of GENRE_IDS) expect(GENRES[id].colour).toMatch(/^#[0-9A-F]{6}$/i);
	});
});
