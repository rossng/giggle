import { describe, expect, it } from 'vitest';
import { artist } from '$lib/data/fixtures';
import type { YoutubeArtist } from '$lib/data/types';
import {
	announcerOf,
	artistImage,
	introClips,
	songsToTracks,
	squareImage,
	trackIndex,
	videoThumbnail,
	youtubeMusicUrl
} from './tracks';

const yt = (over: Partial<YoutubeArtist> = {}): YoutubeArtist => ({
	browseId: 'UC123',
	name: 'Nobu',
	monthlyListeners: '12K',
	image: 'https://yt3.googleusercontent.com/abc=w2880-h1200-p-l90-rj',
	songs: [
		{ videoId: 'DGlKqwJuHps', title: 'Pirate Winter Song', album: 'Frosty Cannonballs' },
		{ videoId: 'gHaHwJcD2aI', title: ' the Power of Friendship ', album: null }
	],
	...over
});

describe('songsToTracks', () => {
	it('maps songs to tracks, keeping the album only when there is one', () => {
		expect(songsToTracks(yt().songs)).toEqual([
			{ videoId: 'DGlKqwJuHps', title: 'Pirate Winter Song', album: 'Frosty Cannonballs' },
			{ videoId: 'gHaHwJcD2aI', title: 'the Power of Friendship' }
		]);
	});

	it('drops repeats and unusable ids', () => {
		expect(
			songsToTracks([
				{ videoId: 'DGlKqwJuHps', title: 'A', album: null },
				{ videoId: 'DGlKqwJuHps', title: 'A again', album: null },
				{ videoId: '', title: 'empty', album: null },
				{ videoId: 'bad id!', title: 'bad', album: null },
				{ videoId: 'TXAuTZP5osY', title: '', album: '' }
			])
		).toEqual([
			{ videoId: 'DGlKqwJuHps', title: 'A' },
			{ videoId: 'TXAuTZP5osY', title: 'Untitled' }
		]);
		expect(songsToTracks(null)).toEqual([]);
	});
});

describe('trackIndex', () => {
	it('indexes artists that have tracks', () => {
		const index = trackIndex({
			a: artist({ key: 'a', youtube: yt() }),
			b: artist({ key: 'b', youtube: null }),
			c: artist({ key: 'c' }),
			d: artist({ key: 'd', youtube: yt({ songs: [] }) })
		});
		expect([...index.keys()]).toEqual(['a']);
		expect(index.get('a')).toHaveLength(2);
	});
});

describe('helpers', () => {
	it('squares YouTube banner images and leaves other URLs alone', () => {
		expect(squareImage(yt().image)).toBe(
			'https://yt3.googleusercontent.com/abc=w544-h544-p-l90-rj'
		);
		expect(squareImage('https://upload.wikimedia.org/x.jpg')).toBe(
			'https://upload.wikimedia.org/x.jpg'
		);
		expect(squareImage(null)).toBeNull();
	});

	it('prefers the YouTube Music picture, then Wikipedia', () => {
		const wiki = {
			title: null,
			lang: 'en',
			description: null,
			extract: '',
			url: null,
			thumbnail: 'https://upload.wikimedia.org/x.jpg'
		};
		expect(artistImage(artist({ youtube: yt(), wikipedia: wiki }))).toBe(yt().image);
		expect(artistImage(artist({ youtube: null, wikipedia: wiki }))).toBe(wiki.thumbnail);
		expect(artistImage(undefined)).toBeNull();
		// A picture from a host the page doesn't load images from is skipped.
		const elsewhere = { ...yt(), image: 'https://tracker.example/abc.jpg' };
		expect(artistImage(artist({ youtube: elsewhere, wikipedia: wiki }))).toBe(wiki.thumbnail);
	});

	it('links to the YouTube Music channel', () => {
		expect(youtubeMusicUrl(yt())).toBe('https://music.youtube.com/channel/UC123');
		expect(youtubeMusicUrl(null)).toBeNull();
	});
});

describe('introClips', () => {
	it('maps announce entries to clip URLs under the data directory', () => {
		const clips = introClips({
			'mb:1': {
				announce: [
					{ text: 'Djavan, a singer.', clip: 'voice/ab.mp3', seconds: 4.2, voice: 'bm_fable' }
				]
			},
			'mb:2': { announce: [] },
			'mb:3': {}
		});
		expect(clips).toEqual({
			'mb:1': [{ url: '/data/voice/ab.mp3', text: 'Djavan, a singer.', seconds: 4.2 }]
		});
	});
});

describe('announcerOf', () => {
	const clip = { text: 'Djavan, a singer.', clip: 'voice/ab.mp3', seconds: 4.2, voice: 'bm_fable' };
	it("uses the pipeline's announcer, else the first clip's voice, else Isabella", () => {
		expect(announcerOf({ announcer: 'bm_fable' })).toBe('bm_fable');
		expect(announcerOf({ announcer: 'bf_isabella', announce: [clip] })).toBe('bf_isabella');
		expect(announcerOf({ announce: [clip] })).toBe('bm_fable');
		expect(announcerOf({})).toBe('bf_isabella');
		expect(announcerOf(undefined)).toBe('bf_isabella');
	});
});

describe('videoThumbnail', () => {
	it("gives the video's thumbnail on YouTube's image host", () => {
		expect(videoThumbnail('DGlKqwJuHps')).toBe('https://i.ytimg.com/vi/DGlKqwJuHps/hqdefault.jpg');
	});

	it('gives nothing for an id that is not one', () => {
		for (const id of ['', 'abc', '../../x', 'a/b?c=d#e', 'DGlKqwJuHps/../x']) {
			expect(videoThumbnail(id)).toBeUndefined();
		}
	});
});
