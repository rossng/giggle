import { describe, expect, it } from 'vitest';
import { viewGig } from './catalog';
import { VENUES, gig } from './fixtures';
import {
	DEFAULT_FILTERS,
	activeFilters,
	allOfBoard,
	apply,
	bucketState,
	dateWindow,
	facetCounts,
	genreWords,
	hasStyle,
	isDefault,
	parse,
	removeStyle,
	serialise,
	summarise,
	toQuery,
	toggle,
	toggleBucket,
	toggleStyle,
	type Filters
} from './filters';

const p = (query: string) => parse(new URLSearchParams(query));
const f = (overrides: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...overrides });

// 26 Sep 2026, 23:30 in Amsterdam (21:30 UTC): still the 26th locally.
const NOW = new Date('2026-09-26T21:30:00Z');

describe('parse', () => {
	it('gives the defaults for an empty query', () => {
		expect(p('')).toEqual(DEFAULT_FILTERS);
	});

	it('reads every parameter', () => {
		expect(
			p(
				'days=30&from=3&city=utrecht,amsterdam&venue=paradiso&genre=jazz,indie&style=shoegaze,post-punk&q=nobu&hide=soldout&board=listen&order=mix&seed=k3x9'
			)
		).toEqual({
			days: 30,
			from: 3,
			cities: ['amsterdam', 'utrecht'],
			venues: ['paradiso'],
			genres: ['indie', 'jazz'],
			styles: ['post-punk', 'shoegaze'],
			q: 'nobu',
			hide: ['soldout'],
			board: 'listen',
			order: 'mix',
			seed: 'k3x9'
		});
	});

	it('ignores invalid values and unknown parameters', () => {
		expect(
			p(
				'days=0&from=-1&city=Den%20Haag&genre=polka,jazz&hide=cheap&board=nope&order=loud&seed=a%20b&colour=red'
			)
		).toEqual(f({ genres: ['jazz'] }));
		expect(p('days=abc&from=1.5').days).toBe(90);
		expect(p('days=9999').days).toBe(90);
		expect(p('from=400').from).toBe(0);
	});

	it('reads the board filter in any case', () => {
		expect(p('board=%20Listen%20').board).toBe('listen');
		expect(p('board=listen,nope').board).toBe(null);
		expect(p('board=__proto__').board).toBe(null);
	});

	it('lowercases, deduplicates and merges repeated lists', () => {
		expect(p('city=Amsterdam,amsterdam&city=Leiden').cities).toEqual(['amsterdam', 'leiden']);
	});

	it('tidies the search text', () => {
		expect(p('q=%20%20nouvelle%20%20%20vague%20').q).toBe('nouvelle vague');
	});

	it('reads styles as slugs, one per style however spelt', () => {
		expect(p('style=Post-Punk,postpunk,r%26b,rnb,%20dream-pop').styles).toEqual([
			'dream-pop',
			'post-punk',
			'rnb'
		]);
		expect(p('style=--,a_b,' + 'x'.repeat(41)).styles).toEqual([]);
	});

	it('reads both hide flags', () => {
		expect(p('hide=unavailable,soldout').hide).toEqual(['soldout', 'unavailable']);
	});
});

describe('serialise / toQuery', () => {
	it('leaves defaults out', () => {
		expect(serialise(DEFAULT_FILTERS).toString()).toBe('');
		expect(toQuery(DEFAULT_FILTERS)).toBe('');
		expect(isDefault(f())).toBe(true);
		expect(isDefault(f({ days: 30 }))).toBe(false);
	});

	it('writes lists sorted, in a fixed parameter order, with readable commas', () => {
		expect(
			toQuery(
				f({
					seed: 'x1',
					order: 'shuffle',
					board: 'listen',
					hide: ['soldout'],
					q: 'the  cure',
					genres: ['jazz', 'indie'],
					styles: ['shoegaze', 'post-punk'],
					venues: ['paradiso'],
					cities: ['utrecht', 'amsterdam'],
					from: 7,
					days: 14
				})
			)
		).toBe(
			'?days=14&from=7&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz&style=post-punk,shoegaze&q=the+cure&hide=soldout&board=listen&order=shuffle&seed=x1'
		);
	});

	it('round-trips', () => {
		const filters = f({
			days: 180,
			from: 3,
			cities: ['haarlem'],
			genres: ['hiphop'],
			styles: ['drum-n-bass', 'rnb'],
			q: 'a&b=c',
			hide: ['soldout', 'unavailable'],
			board: 'listen',
			order: 'date'
		});
		expect(parse(serialise(filters))).toEqual(filters);
		expect(p(toQuery(filters).slice(1))).toEqual(filters);
	});
});

describe('toggle', () => {
	it('adds and removes, keeping lists sorted', () => {
		expect(toggle(['b'], 'a')).toEqual(['a', 'b']);
		expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
	});
});

describe('dateWindow', () => {
	it("starts from today's date in Amsterdam, offset by `from`", () => {
		expect(dateWindow({ days: 90, from: 0 }, NOW)).toEqual({
			first: '2026-09-26',
			last: '2026-12-24'
		});
		expect(dateWindow({ days: 14, from: 3 }, NOW)).toEqual({
			first: '2026-09-29',
			last: '2026-10-12'
		});
		// 22:30 UTC on the 26th is already the 27th in Amsterdam
		expect(dateWindow({ days: 1, from: 0 }, new Date('2026-09-26T22:30:00Z')).first).toBe(
			'2026-09-27'
		);
	});
});

describe('apply', () => {
	const views = [
		gig({ source_id: '1', start: '2026-09-26T20:00:00+02:00', genres: ['Jazz'] }),
		gig({
			source_id: '2',
			start: '2026-10-01T20:00:00+02:00',
			genres: ['Indie'],
			availability: 'sold_out'
		}),
		gig({
			source_id: '3',
			venue: 'tivolivredenburg',
			start: '2026-10-10T20:00:00+02:00',
			title: 'Nouvelle Vague',
			genres: ['Pop'],
			availability: 'unknown',
			artists: [{ key: 'mb:b017a7ae', name: 'Nouvelle Vague', role: 'headliner' }]
		}),
		gig({ source_id: '4', start: '2027-02-01T20:00:00+01:00', genres: [] })
	].map((g) => viewGig(g, VENUES, {}));
	const ids = (filters: Filters) => apply(filters, views, NOW).map((v) => v.gig.source_id);

	it('keeps gigs inside the window, including earlier today', () => {
		expect(ids(f())).toEqual(['1', '2', '3']);
		expect(ids(f({ from: 3 }))).toEqual(['2', '3']);
		expect(ids(f({ days: 5 }))).toEqual(['1']);
		expect(ids(f({ days: 6 }))).toEqual(['1', '2']);
		expect(ids(f({ days: 180 }))).toEqual(['1', '2', '3', '4']);
	});

	it('filters by city, venue and genre', () => {
		expect(ids(f({ cities: ['utrecht'] }))).toEqual(['3']);
		expect(ids(f({ venues: ['paradiso'] }))).toEqual(['1', '2']);
		expect(ids(f({ genres: ['jazz', 'pop'] }))).toEqual(['1', '3']);
	});

	it('hides sold-out gigs, treating unknown availability as available', () => {
		expect(ids(f({ hide: ['soldout'] }))).toEqual(['1', '3']);
	});

	it("hides gigs on the listener's unavailable dates, only when asked to", () => {
		const away = (date: string) => date === '2026-10-01' || date === '2026-10-10';
		const hide = f({ hide: ['unavailable'] });
		expect(apply(hide, views, NOW, { unavailable: away }).map((v) => v.gig.source_id)).toEqual([
			'1'
		]);
		expect(apply(f(), views, NOW, { unavailable: away }).map((v) => v.gig.source_id)).toEqual([
			'1',
			'2',
			'3'
		]);
		// No dates known (signed out, none set): nothing to hide.
		expect(ids(hide)).toEqual(['1', '2', '3']);
		const counts = facetCounts(hide, views, NOW, { unavailable: away });
		expect(counts.city).toEqual(new Map([['amsterdam', 1]]));
	});

	it("keeps gigs with the listener's listen-more artists, only when asked to", () => {
		const board = f({ board: 'listen' });
		const mine = (...keys: string[]) => ({ listenMore: new Set(keys) });
		const by = (filters: Filters, personal: ReturnType<typeof mine>) =>
			apply(filters, views, NOW, personal).map((v) => v.gig.source_id);
		expect(by(board, mine('mb:b017a7ae'))).toEqual(['3']);
		expect(by(board, mine('name:nobu', 'mb:b017a7ae'))).toEqual(['1', '2', '3']);
		expect(by(f(), mine('mb:b017a7ae'))).toEqual(['1', '2', '3']);
		// Nobody marked (or the board isn't known): nothing.
		expect(by(board, mine())).toEqual([]);
		expect(ids(board)).toEqual([]);
		// With the rest of the filters, and in the counts.
		expect(by(f({ board: 'listen', hide: ['soldout'] }), mine('name:nobu'))).toEqual(['1']);
		const counts = facetCounts(board, views, NOW, mine('name:nobu'));
		expect(counts.venue).toEqual(new Map([['paradiso', 2]]));
	});

	it('keeps the whole gig when any artist on its line-up is marked', () => {
		const shared = gig({
			source_id: '5',
			start: '2026-10-02T20:00:00+02:00',
			artists: [
				{ key: 'name:headliner', name: 'Headliner', role: 'headliner' },
				{ key: 'name:support', name: 'Support', role: 'support' }
			]
		});
		const shown = apply(f({ board: 'listen' }), [viewGig(shared, VENUES, {})], NOW, {
			listenMore: new Set(['name:support'])
		});
		expect(shown.map((v) => v.gig.artists.length)).toEqual([2]);
	});

	it("widens to all of a board's gigs, over the shortest preset window that holds them", () => {
		const mine = (...keys: string[]) => ({ listenMore: new Set(keys) });
		// Nouvelle Vague's gig is 14 days out, Nobu's last one 128.
		expect(allOfBoard('listen', views, NOW, mine('mb:b017a7ae'))).toEqual(
			f({ board: 'listen', days: 30 })
		);
		expect(allOfBoard('listen', views, NOW, mine('name:nobu'))).toEqual(
			f({ board: 'listen', days: 180 })
		);
		const later = viewGig(gig({ source_id: '9', start: '2027-06-01T20:00:00+02:00' }), VENUES, {});
		expect(allOfBoard('listen', [...views, later], NOW, mine('name:nobu'))?.days).toBe(730);
		expect(allOfBoard('listen', views, NOW, mine('name:nobody'))).toBe(null);
		expect(allOfBoard('listen', views, NOW, {})).toBe(null);
	});

	it('searches titles, artists and venues, ignoring case and accents', () => {
		expect(ids(f({ q: 'NOUVELLE' }))).toEqual(['3']);
		expect(ids(f({ q: 'vague tivoli' }))).toEqual(['3']);
		expect(ids(f({ q: 'nôbu' }))).toEqual(['1', '2']);
		expect(ids(f({ q: 'nobu utrecht' }))).toEqual([]);
	});

	it('counts each facet with the other filters applied', () => {
		const counts = facetCounts(f({ cities: ['amsterdam'], genres: ['jazz'] }), views, NOW);
		expect(counts.city).toEqual(new Map([['amsterdam', 1]]));
		expect(counts.genre).toEqual(
			new Map([
				['jazz', 1],
				['indie', 1]
			])
		);
		expect(counts.venue).toEqual(new Map([['paradiso', 1]]));
	});
});

describe('summarise', () => {
	it('describes the filters in a line', () => {
		expect(summarise(f())).toBe('Next 3 months');
		expect(
			summarise(
				f({ days: 30, from: 3, cities: ['amsterdam'], genres: ['jazz'], hide: ['soldout'] }),
				{
					city: (c) => c[0].toUpperCase() + c.slice(1)
				}
			)
		).toBe('Next month from +3 days · Amsterdam · Jazz · no sold-out gigs');
		expect(summarise(f({ hide: ['unavailable'] }))).toBe(
			'Next 3 months · not on my unavailable dates'
		);
		expect(summarise(f({ board: 'listen', days: 180 }))).toBe(
			'My listen-more artists · Next 6 months'
		);
	});
});

describe('styles', () => {
	const views = [
		gig({ source_id: 'shoegaze', genres: ['Indie - Shoegaze/Dream Pop'] }),
		gig({ source_id: 'indie', genres: ['Indie'] }),
		gig({ source_id: 'postpunk', genres: ['Post Punk'] }),
		gig({ source_id: 'hardbop', genres: ['Jazz / Hard Bop'] }),
		gig({ source_id: 'jazz', genres: ['Jazz'] }),
		gig({ source_id: 'folk', genres: ['Indie Folk'] }),
		gig({ source_id: 'none', genres: [] })
	].map((g) => viewGig(g, VENUES, {}));
	const ids = (filters: Partial<Filters>) =>
		apply(f(filters), views, NOW).map((v) => v.gig.source_id);

	it('a bucket on its own matches all of it', () => {
		expect(ids({ genres: ['indie'] })).toEqual(['shoegaze', 'indie', 'folk']);
	});

	it('styles within a bucket narrow it', () => {
		expect(ids({ genres: ['indie'], styles: ['shoegaze'] })).toEqual(['shoegaze']);
		expect(ids({ genres: ['indie'], styles: ['shoegaze', 'indie-folk'] })).toEqual([
			'shoegaze',
			'folk'
		]);
	});

	it('other buckets stay whole, and styles OR with them', () => {
		expect(ids({ genres: ['indie', 'jazz'], styles: ['shoegaze'] })).toEqual([
			'shoegaze',
			'hardbop',
			'jazz'
		]);
	});

	it("a style whose bucket isn't selected adds its gigs", () => {
		expect(ids({ styles: ['post-punk'] })).toEqual(['postpunk']);
		expect(ids({ genres: ['jazz'], styles: ['postpunk'] })).toEqual([
			'postpunk',
			'hardbop',
			'jazz'
		]);
		expect(ids({ styles: ['hard-bop', 'shoegaze'] })).toEqual(['shoegaze', 'hardbop']);
	});

	it('matches any spelling of a style', () => {
		expect(ids({ styles: ['postpunk'] })).toEqual(ids({ styles: ['post-punk'] }));
	});

	it('counts styles with the genre facet left out', () => {
		const counts = facetCounts(f({ genres: ['jazz'], styles: ['shoegaze'] }), views, NOW);
		expect(counts.style.get('shoegaze')).toBe(1);
		expect(counts.style.get('hardbop')).toBe(1);
		expect(counts.style.get('postpunk')).toBe(1);
		expect(counts.genre.get('indie')).toBe(3);
	});

	it('tracks each bucket as all, some or off', () => {
		expect(bucketState(f({ genres: ['indie'] }), 'indie')).toBe('all');
		expect(bucketState(f({ genres: ['indie'], styles: ['shoegaze'] }), 'indie')).toBe('some');
		expect(bucketState(f({ styles: ['shoegaze'] }), 'indie')).toBe('some');
		expect(bucketState(f({ styles: ['shoegaze'] }), 'jazz')).toBe('off');
	});

	it('tapping a bucket goes off → all → off, and some → all', () => {
		expect(toggleBucket(f(), 'indie')).toEqual({ genres: ['indie'], styles: [] });
		expect(toggleBucket(f({ genres: ['indie'] }), 'indie')).toEqual({ genres: [], styles: [] });
		expect(
			toggleBucket(f({ genres: ['jazz'], styles: ['hard-bop', 'shoegaze'] }), 'indie')
		).toEqual({ genres: ['indie', 'jazz'], styles: ['hard-bop'] });
	});

	it('toggles styles by key', () => {
		expect(toggleStyle(['shoegaze'], 'post-punk')).toEqual(['post-punk', 'shoegaze']);
		expect(toggleStyle(['postpunk', 'shoegaze'], 'post-punk')).toEqual(['shoegaze']);
		expect(hasStyle(f({ styles: ['postpunk'] }), 'post-punk')).toBe(true);
		expect(hasStyle(f({ styles: ['postpunk'] }), 'punk')).toBe(false);
	});

	it("removing a style's chip drops a bucket it alone narrowed", () => {
		const both = f({ genres: ['indie', 'jazz'], styles: ['dream-pop', 'shoegaze'] });
		expect(removeStyle(both, 'shoegaze')).toEqual({
			genres: ['indie', 'jazz'],
			styles: ['dream-pop']
		});
		expect(removeStyle({ ...both, styles: ['shoegaze'] }, 'shoegaze')).toEqual({
			genres: ['jazz'],
			styles: []
		});
	});

	it('words the genre facet without the buckets styles narrow', () => {
		const filters = f({ genres: ['indie', 'jazz'], styles: ['shoegaze'] });
		expect(genreWords(filters)).toEqual(['Jazz', 'shoegaze']);
		expect(summarise(filters, { style: (s) => s.toUpperCase() })).toBe(
			'Next 3 months · Jazz, SHOEGAZE'
		);
	});
});

describe('activeFilters', () => {
	it('gives a removable chip for each filter beyond search and dates', () => {
		const filters = f({
			q: 'nobu',
			days: 14,
			genres: ['indie', 'jazz'],
			styles: ['shoegaze'],
			cities: ['utrecht'],
			venues: ['paradiso'],
			hide: ['soldout'],
			board: 'listen'
		});
		const chips = activeFilters(filters, { venue: (v) => v.toUpperCase() });
		expect(chips.map((c) => [c.id, c.label])).toEqual([
			['board:listen', 'My listen-more artists'],
			['genre:jazz', 'Jazz'],
			['style:shoegaze', 'shoegaze'],
			['city:utrecht', 'utrecht'],
			['venue:paradiso', 'PARADISO'],
			['hide:soldout', 'No sold out']
		]);
		expect(chips[0].without).toEqual({ board: null });
		expect(chips[1].without).toEqual({ genres: ['indie'] });
		expect(chips[2].without).toEqual({ genres: ['jazz'], styles: [] });
		expect(chips[2].colour).toBe('#FF9A5E');
		expect(activeFilters(f({ q: 'x', days: 30 }))).toEqual([]);
	});
});
