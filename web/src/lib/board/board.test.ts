import { describe, expect, it } from 'vitest';
import { memoryStorage } from '$lib/storage';
import {
	BOARD_STORAGE_KEY,
	keysIn,
	loadBoard,
	namesIn,
	parseBoard,
	saveBoard,
	setTriage,
	toggleTriage,
	type Board
} from './board';

const NOW = new Date('2026-09-26T20:00:00Z');
const LATER = new Date('2026-09-27T09:00:00Z');

describe('setTriage / toggleTriage', () => {
	it('sorts, replaces and unsorts an artist without touching others', () => {
		let board: Board = {};
		board = setTriage(board, 'mb:1', 'listen', { name: 'Mogwai', gig: 'paradiso:1' }, NOW);
		board = setTriage(board, 'mb:2', 'go', { name: 'Slowdive' }, NOW);
		expect(board['mb:1']).toEqual({
			state: 'listen',
			name: 'Mogwai',
			gig: 'paradiso:1',
			at: NOW.toISOString()
		});
		expect(board['mb:2']).not.toHaveProperty('gig');

		const replaced = setTriage(board, 'mb:1', 'tickets', { name: 'Mogwai' }, LATER);
		expect(replaced['mb:1']?.state).toBe('tickets');
		expect(replaced['mb:1'].at).toBe(LATER.toISOString());
		expect(board['mb:1']?.state).toBe('listen'); // not mutated

		expect(setTriage(board, 'mb:1', null, { name: 'Mogwai' }, NOW)).toEqual({
			'mb:2': board['mb:2']
		});
	});

	it('toggles the same state off and switches to another', () => {
		const one = toggleTriage({}, 'k', 'nope', { name: 'A' }, NOW);
		expect(one['k']?.state).toBe('nope');
		expect(toggleTriage(one, 'k', 'nope', { name: 'A' }, NOW)['k']).toBeUndefined();
		expect(toggleTriage(one, 'k', 'go', { name: 'A' }, NOW)['k']?.state).toBe('go');
	});
});

describe('queries', () => {
	const board: Board = {
		a: { state: 'listen', name: 'A', at: NOW.toISOString() },
		b: { state: 'go', name: 'B', at: NOW.toISOString() },
		c: { state: 'nope', name: 'C', at: NOW.toISOString() },
		d: { state: 'listen', name: 'D', at: NOW.toISOString() }
	};

	it('selects keys and names by state', () => {
		expect([...keysIn(board, ['listen'])].sort()).toEqual(['a', 'd']);
		expect(namesIn(board, ['listen', 'go']).sort()).toEqual(['A', 'B', 'D']);
	});
});

describe('storage', () => {
	it('round-trips through storage', () => {
		const storage = memoryStorage();
		const board = setTriage({}, 'mb:1', 'go', { name: 'Mogwai', gig: 'paradiso:1' }, NOW);
		expect(saveBoard(board, storage)).toBe(true);
		expect(JSON.parse(storage.data.get(BOARD_STORAGE_KEY)!)).toMatchObject({ version: 1 });
		expect(loadBoard(storage)).toEqual(board);
	});

	it('is empty without storage or with junk in it', () => {
		expect(loadBoard(null)).toEqual({});
		const storage = memoryStorage();
		storage.setItem(BOARD_STORAGE_KEY, '{not json');
		expect(loadBoard(storage)).toEqual({});
	});

	it('drops malformed items', () => {
		expect(
			parseBoard({
				items: {
					ok: { state: 'tickets', name: 'OK', at: NOW.toISOString() },
					badState: { state: 'maybe', name: 'X', at: NOW.toISOString() },
					badDate: { state: 'go', name: 'X', at: 'yesterday' },
					noName: { state: 'go', at: NOW.toISOString() },
					nothing: null
				}
			})
		).toEqual({
			ok: { state: 'tickets', name: 'OK', at: NOW.toISOString() },
			noName: { state: 'go', name: 'noName', at: NOW.toISOString() }
		});
		expect(parseBoard([1, 2])).toEqual({});
		expect(parseBoard(null)).toEqual({});
	});

	it('survives a storage that throws', () => {
		const throwing = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
			removeItem: () => {}
		};
		expect(loadBoard(throwing)).toEqual({});
		expect(saveBoard({}, throwing)).toBe(false);
	});
});
