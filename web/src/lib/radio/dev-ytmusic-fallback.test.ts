// DEV FALLBACK tests: delete with dev-ytmusic-fallback.ts.
import { describe, expect, it } from 'vitest';
import { artist } from '$lib/data/fixtures';
import {
	applyYtmusicFallback,
	loadYtmusicFallback,
	normaliseName,
	parseYtmusicCache
} from './dev-ytmusic-fallback';
import { trackIndex } from './tracks';

const record = (name: string, videoId = 'DGlKqwJuHps') => ({
	name,
	browseId: `UC-${name}`,
	monthlyListeners: null,
	description: null,
	image: null,
	songs: [{ videoId, title: `${name} song`, album: null }]
});

const CACHE = {
	version: 1,
	artists: {
		sigurros: record('Sigur Rós', 'aaaaaaaaaaa'),
		beatles: record('The Beatles', 'bbbbbbbbbbb'),
		kronkelfestival: null,
		broken: { name: 'no browse id' }
	}
};

describe('normaliseName', () => {
	it('matches the pipeline normaliser', () => {
		expect(normaliseName('Sigur Rós')).toBe('sigurros');
		expect(normaliseName('The Beatles')).toBe('beatles');
		expect(normaliseName('the the')).toBe('the');
		expect(normaliseName('Captain Kelphair & the Salty Seamen')).toBe(
			'captainkelphairthesaltyseamen'
		);
		expect(normaliseName('KRONKEL FESTIVAL')).toBe('kronkelfestival');
		expect(normaliseName('Björk')).toBe('bjork');
		expect(normaliseName('坂本龍一')).toBe('');
	});
});

describe('parseYtmusicCache', () => {
	it('keeps records and nulls, turning junk into null', () => {
		const cache = parseYtmusicCache(CACHE)!;
		expect(cache.get('sigurros')?.browseId).toBe('UC-Sigur Rós');
		expect(cache.get('kronkelfestival')).toBeNull();
		expect(cache.get('broken')).toBeNull();
		expect(parseYtmusicCache({ nope: 1 })).toBeNull();
		expect(parseYtmusicCache(null)).toBeNull();
	});
});

describe('applyYtmusicFallback', () => {
	it('attaches records by normalised name, and tracks follow', () => {
		const artists = {
			'mb:1': artist({ key: 'mb:1', name: 'Sigur Ros' }),
			'mb:2': artist({ key: 'mb:2', name: 'Beatles, The' }),
			'name:kronkel': artist({ key: 'name:kronkel', name: 'Kronkel Festival' }),
			'mb:3': artist({
				key: 'mb:3',
				name: 'the beatles (tribute)',
				match: {
					mbid: '3',
					name: 'The Beatles',
					disambiguation: null,
					namesakes: 0,
					confidence: 'high'
				}
			})
		};
		const out = applyYtmusicFallback(artists, parseYtmusicCache(CACHE)!);
		expect(out['mb:1'].youtube?.name).toBe('Sigur Rós');
		expect(out['mb:2'].youtube).toBeNull(); // "beatlesthe" isn't a key
		expect(out['name:kronkel'].youtube).toBeNull();
		expect(out['mb:3'].youtube?.name).toBe('The Beatles'); // via the MusicBrainz match name
		expect(trackIndex(out).get('mb:1')).toEqual([
			{ videoId: 'aaaaaaaaaaa', title: 'Sigur Rós song' }
		]);
		expect(artists['mb:1']).not.toHaveProperty('youtube'); // input untouched
	});

	it('leaves artists that already have the field alone', () => {
		const own = { ...record('Own'), songs: [] };
		const out = applyYtmusicFallback(
			{ a: artist({ key: 'a', name: 'Sigur Rós', youtube: own }) },
			parseYtmusicCache(CACHE)!
		);
		expect(out.a.youtube).toBe(own);
	});
});

describe('loadYtmusicFallback', () => {
	const fetchJson = (body: unknown, status = 200) =>
		(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

	it('fetches the cache only when artists.json lacks the field', async () => {
		const plain = { a: artist({ key: 'a', name: 'Sigur Rós' }) };
		const loaded = await loadYtmusicFallback(fetchJson(CACHE), plain);
		expect(loaded?.a.youtube?.browseId).toBe('UC-Sigur Rós');

		const withField = { a: artist({ key: 'a', youtube: null }) };
		expect(await loadYtmusicFallback(fetchJson(CACHE), withField)).toBeNull();
	});

	it('gives up quietly when the cache is missing', async () => {
		expect(await loadYtmusicFallback(fetchJson('not found', 404), { a: artist() })).toBeNull();
		const failing = (async () => {
			throw new Error('offline');
		}) as typeof fetch;
		expect(await loadYtmusicFallback(failing, { a: artist() })).toBeNull();
	});
});
