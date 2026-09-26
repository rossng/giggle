import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from '$lib/data/filters';
import {
	seedFromText,
	seedToText,
	stationFromParams,
	stationKey,
	stationQuery,
	type Station
} from './station';

const s = (query: string) => stationFromParams(new URLSearchParams(query));

describe('stationFromParams', () => {
	it('defaults to Mix with no seed', () => {
		expect(s('')).toEqual({
			filters: DEFAULT_FILTERS,
			order: 'mix',
			orderGiven: false,
			seed: null
		});
	});

	it('reads the filters, order and seed', () => {
		const station = s(
			'days=14&city=utrecht,amsterdam&genre=jazz&hide=soldout&order=shuffle&seed=k3x9'
		);
		expect(station.filters).toEqual({
			...DEFAULT_FILTERS,
			days: 14,
			cities: ['amsterdam', 'utrecht'],
			genres: ['jazz'],
			hide: ['soldout']
		});
		expect(station.order).toBe('shuffle');
		expect(station.orderGiven).toBe(true);
		expect(station.seed).toBe(parseInt('k3x9', 36));
	});

	it('ignores a bad order or seed', () => {
		expect(s('order=loud&seed=%%%')).toMatchObject({ order: 'mix', orderGiven: false, seed: null });
	});
});

describe('stationQuery', () => {
	const station = (over: Partial<Station> = {}) => ({ ...s(''), ...over });

	it('leaves out the defaults', () => {
		expect(stationQuery(station())).toBe('');
		expect(stationQuery(station({ order: 'mix', seed: null }))).toBe('');
	});

	it('writes the order and seed, but no seed for date order', () => {
		expect(stationQuery(station({ order: 'shuffle', seed: 1234567 }))).toBe(
			`?order=shuffle&seed=${(1234567).toString(36)}`
		);
		expect(stationQuery(station({ order: 'mix', seed: 42 }))).toBe('?seed=16');
		expect(stationQuery(station({ order: 'date', seed: 42 }))).toBe('?order=date');
	});

	it('round-trips through the URL', () => {
		const query =
			'?days=30&city=amsterdam,haarlem&venue=paradiso&genre=indie&order=shuffle&seed=abc12';
		const parsed = s(query.slice(1));
		expect(stationQuery(parsed)).toBe(query);
		expect(stationFromParams(new URLSearchParams(stationQuery(parsed)))).toEqual(parsed);
	});
});

describe('seeds', () => {
	it('round-trips any 32-bit seed through base 36', () => {
		for (const seed of [0, 1, 42, 0x7fffffff, 0xffffffff, 123456789]) {
			expect(seedFromText(seedToText(seed))).toBe(seed);
		}
	});

	it('hashes other seed texts stably', () => {
		const a = seedFromText('My-Station_2026');
		expect(a).toBe(seedFromText('My-Station_2026'));
		expect(a).not.toBe(seedFromText('My-Station_2027'));
		expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
		// Too big for 32 bits in base 36: hashed, not wrapped.
		expect(seedFromText('zzzzzzz')).toBeLessThanOrEqual(0xffffffff);
	});
});

describe('stationKey', () => {
	it('ignores order and seed but not the filters', () => {
		const a = s('city=amsterdam&order=date');
		const b = s('city=amsterdam&order=shuffle&seed=x');
		const c = s('city=utrecht');
		expect(stationKey(a.filters)).toBe(stationKey(b.filters));
		expect(stationKey({ ...a.filters, order: 'mix', seed: 'q' })).toBe(stationKey(a.filters));
		expect(stationKey(a.filters)).not.toBe(stationKey(c.filters));
	});
});
