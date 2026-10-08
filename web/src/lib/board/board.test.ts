import { describe, expect, it } from 'vitest';
import { memoryStorage } from '$lib/storage';
import {
	artistState,
	artistsIn,
	BOARD_STORAGE_KEY,
	gigState,
	loadBoard,
	namesIn,
	parseBoard,
	saveBoard,
	setArtist,
	setGig,
	toggleArtist,
	toggleGig,
	type Board
} from './board';

const NOW = new Date('2026-09-26T20:00:00Z');
const LATER = new Date('2026-09-27T09:00:00Z');
const MOGWAI = { key: 'mb:1', name: 'Mogwai' };
const START = '2026-10-10T20:00:00+02:00';

describe('artists', () => {
	it('sorts, replaces and unsorts an artist without touching others', () => {
		let board: Board = {};
		board = setArtist(board, MOGWAI, 'listen', NOW);
		board = setArtist(board, { key: 'mb:2', name: 'Slowdive' }, 'nope', NOW);
		expect(board['mb:1']).toEqual({ state: 'listen', name: 'Mogwai', at: NOW.toISOString() });
		expect(artistState(board, 'mb:2')).toBe('nope');

		const replaced = setArtist(board, MOGWAI, 'nope', LATER);
		expect(replaced['mb:1']).toEqual({ state: 'nope', name: 'Mogwai', at: LATER.toISOString() });
		expect(board['mb:1']?.state).toBe('listen'); // not mutated

		expect(setArtist(board, MOGWAI, null, NOW)).toEqual({ 'mb:2': board['mb:2'] });
	});

	it('toggles the same state off and switches to the other', () => {
		const one = toggleArtist({}, MOGWAI, 'nope', NOW);
		expect(artistState(one, 'mb:1')).toBe('nope');
		expect(toggleArtist(one, MOGWAI, 'nope', NOW)).toEqual({});
		expect(artistState(toggleArtist(one, MOGWAI, 'listen', NOW), 'mb:1')).toBe('listen');
	});
});

describe('gigs', () => {
	it('sorts a gig for an artist, keyed by the gig', () => {
		const board = setGig({}, 'paradiso:1', 'go', { artist: MOGWAI, when: START }, NOW);
		expect(board).toEqual({
			'gig:paradiso:1': {
				state: 'go',
				name: 'Mogwai',
				artist: 'mb:1',
				when: START,
				at: NOW.toISOString()
			}
		});
		expect(gigState(board, 'paradiso:1')).toBe('go');
		expect(artistState(board, 'mb:1')).toBeNull();
		const noKey = setGig({}, 'x:1', 'tickets', { artist: { key: null, name: 'A' } }, NOW);
		expect(noKey['gig:x:1']).toEqual({ state: 'tickets', name: 'A', at: NOW.toISOString() });
	});

	it("keeps an artist's mark and their gigs' apart", () => {
		let board = setArtist({}, MOGWAI, 'listen', NOW);
		board = setGig(board, 'paradiso:1', 'tickets', { artist: MOGWAI }, NOW);
		board = setGig(board, 'melkweg:7', 'go', { artist: MOGWAI }, NOW);
		expect(artistState(board, 'mb:1')).toBe('listen');
		expect(gigState(board, 'paradiso:1')).toBe('tickets');
		expect(gigState(board, 'melkweg:7')).toBe('go');
		board = toggleGig(board, 'paradiso:1', 'tickets', { artist: MOGWAI }, NOW);
		expect(gigState(board, 'paradiso:1')).toBeNull();
		expect(artistState(board, 'mb:1')).toBe('listen');
	});

	it("doesn't read one kind's state as the other's", () => {
		const board: Board = {
			'mb:1': { state: 'go', name: 'Odd', at: NOW.toISOString() },
			'gig:x:1': { state: 'nope', name: 'Odd', at: NOW.toISOString() }
		};
		expect(artistState(board, 'mb:1')).toBeNull();
		expect(gigState(board, 'x:1')).toBeNull();
	});
});

describe('queries', () => {
	const at = NOW.toISOString();
	const board: Board = {
		a: { state: 'listen', name: 'A', at },
		c: { state: 'nope', name: 'C', at },
		d: { state: 'listen', name: 'D', at },
		'gig:x:1': { state: 'go', name: 'B', artist: 'b', at },
		'gig:x:2': { state: 'tickets', name: 'B', artist: 'b', at },
		'gig:x:3': { state: 'go', name: 'E', at }
	};

	it('selects artists and names by state', () => {
		expect([...artistsIn(board, ['listen'])].sort()).toEqual(['a', 'd']);
		expect([...artistsIn(board, ['go', 'tickets'])]).toEqual(['b']);
		expect([...artistsIn(board, ['nope'])]).toEqual(['c']);
		expect(namesIn(board, ['listen', 'go', 'tickets']).sort()).toEqual(['A', 'B', 'D', 'E']);
	});
});

// LEGACY-BOARD
describe('older versions', () => {
	const at = '2026-09-01T10:00:00.000Z';

	it('moves want to go and got tickets from an artist onto the gig they were sorted from', () => {
		expect(
			parseBoard({
				items: {
					'mb:1': { state: 'go', name: 'Mogwai', gig: 'paradiso:1', when: START, at },
					'name:slowdive': { state: 'tickets', name: 'Slowdive', gig: 'melkweg:7', at }
				}
			})
		).toEqual({
			'gig:paradiso:1': { state: 'go', name: 'Mogwai', artist: 'mb:1', when: START, at },
			'gig:melkweg:7': { state: 'tickets', name: 'Slowdive', artist: 'name:slowdive', at }
		});
	});

	it('keeps listen more and not for me on the artist, without the gig', () => {
		expect(
			parseBoard({
				items: {
					'mb:1': { state: 'listen', name: 'Mogwai', gig: 'paradiso:1', when: START, at },
					'mb:2': { state: 'nope', name: 'Slowdive', at }
				}
			})
		).toEqual({
			'mb:1': { state: 'listen', name: 'Mogwai', at },
			'mb:2': { state: 'nope', name: 'Slowdive', at }
		});
	});

	it('makes want to go without a gig listen more, a millisecond later', () => {
		const board = parseBoard({ items: { 'mb:1': { state: 'go', name: 'Mogwai', at } } });
		expect(board).toEqual({
			'mb:1': { state: 'listen', name: 'Mogwai', at: '2026-09-01T10:00:00.001Z' }
		});
		// Reading it again (as the sync does) changes nothing.
		expect(parseBoard({ items: board })).toEqual(board);
	});

	it('keeps the later of an old item and a new one for the same gig', () => {
		const newer = { state: 'tickets', name: 'Mogwai', artist: 'mb:1', at: LATER.toISOString() };
		const items = {
			'mb:1': { state: 'go', name: 'Mogwai', gig: 'paradiso:1', at },
			'gig:paradiso:1': newer
		};
		expect(parseBoard({ items })).toEqual({ 'gig:paradiso:1': newer });
	});
});

describe('storage', () => {
	it('round-trips through storage', () => {
		const storage = memoryStorage();
		let board = setGig({}, 'paradiso:1', 'go', { artist: MOGWAI, when: START }, NOW);
		board = setArtist(board, { key: 'mb:2', name: 'Slowdive' }, 'nope', NOW);
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
		const at = NOW.toISOString();
		expect(
			parseBoard({
				items: {
					ok: { state: 'nope', name: 'OK', at },
					badState: { state: 'maybe', name: 'X', at },
					badDate: { state: 'listen', name: 'X', at: 'yesterday' },
					noName: { state: 'listen', at },
					'gig:x:1': { state: 'listen', name: 'Not a gig state', at },
					'gig:x:2': { state: 'go', name: 'G', when: 'soon', at },
					nothing: null
				}
			})
		).toEqual({
			ok: { state: 'nope', name: 'OK', at },
			noName: { state: 'listen', name: 'noName', at },
			'gig:x:2': { state: 'go', name: 'G', at }
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
