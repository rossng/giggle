import { describe, expect, it } from 'vitest';
import { viewGig } from './catalog';
import { VENUES, gig } from './fixtures';
import {
	DEFAULT_FILTERS,
	apply,
	dateWindow,
	facetCounts,
	isDefault,
	parse,
	serialise,
	summarise,
	toQuery,
	toggle,
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
				'days=30&from=3&city=utrecht,amsterdam&venue=paradiso&genre=jazz,indie&q=nobu&hide=soldout&order=mix&seed=k3x9'
			)
		).toEqual({
			days: 30,
			from: 3,
			cities: ['amsterdam', 'utrecht'],
			venues: ['paradiso'],
			genres: ['indie', 'jazz'],
			q: 'nobu',
			hide: ['soldout'],
			order: 'mix',
			seed: 'k3x9'
		});
	});

	it('ignores invalid values and unknown parameters', () => {
		expect(
			p(
				'days=0&from=-1&city=Den%20Haag&genre=polka,jazz&hide=cheap&order=loud&seed=a%20b&colour=red'
			)
		).toEqual(f({ genres: ['jazz'] }));
		expect(p('days=abc&from=1.5').days).toBe(90);
		expect(p('days=9999').days).toBe(90);
		expect(p('from=400').from).toBe(0);
	});

	it('lowercases, deduplicates and merges repeated lists', () => {
		expect(p('city=Amsterdam,amsterdam&city=Leiden').cities).toEqual(['amsterdam', 'leiden']);
	});

	it('tidies the search text', () => {
		expect(p('q=%20%20nouvelle%20%20%20vague%20').q).toBe('nouvelle vague');
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
					hide: ['soldout'],
					q: 'the  cure',
					genres: ['jazz', 'indie'],
					venues: ['paradiso'],
					cities: ['utrecht', 'amsterdam'],
					from: 7,
					days: 14
				})
			)
		).toBe(
			'?days=14&from=7&city=amsterdam,utrecht&venue=paradiso&genre=indie,jazz&q=the+cure&hide=soldout&order=shuffle&seed=x1'
		);
	});

	it('round-trips', () => {
		const filters = f({
			days: 180,
			from: 3,
			cities: ['haarlem'],
			genres: ['hiphop'],
			q: 'a&b=c',
			hide: ['soldout', 'unavailable'],
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
		expect(apply(hide, views, NOW, away).map((v) => v.gig.source_id)).toEqual(['1']);
		expect(apply(f(), views, NOW, away).map((v) => v.gig.source_id)).toEqual(['1', '2', '3']);
		// No dates known (signed out, none set): nothing to hide.
		expect(ids(hide)).toEqual(['1', '2', '3']);
		const counts = facetCounts(hide, views, NOW, away);
		expect(counts.city).toEqual(new Map([['amsterdam', 1]]));
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
	});
});
