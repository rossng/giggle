import { describe, expect, it } from 'vitest';
import type { Board } from '$lib/board/board';
import {
	boardOf,
	diffBoards,
	mergeBoards,
	pick,
	recordDeletions,
	sameBoard,
	toSyncMap,
	type SyncMap
} from './merge';
import { fromWire, isSyncable, toWire } from './wire';

const T0 = '2026-09-26T20:00:00.000Z';
const T1 = '2026-09-26T21:00:00.000Z';
const T2 = '2026-09-26T22:00:00.000Z';

describe('pick / mergeBoards', () => {
	it('keeps the later change for each key', () => {
		const local: SyncMap = {
			a: { state: 'go', name: 'A', at: T1 },
			b: { state: 'go', name: 'B', at: T0 },
			onlyLocal: { state: 'listen', name: 'L', at: T0 }
		};
		const remote: SyncMap = {
			a: { state: 'nope', name: 'A', at: T0 },
			b: { state: 'tickets', name: 'B', at: T2 },
			onlyRemote: { state: 'listen', name: 'R', at: T0 }
		};
		expect(mergeBoards(local, remote)).toEqual({
			a: { state: 'go', name: 'A', at: T1 },
			b: { state: 'tickets', name: 'B', at: T2 },
			onlyLocal: { state: 'listen', name: 'L', at: T0 },
			onlyRemote: { state: 'listen', name: 'R', at: T0 }
		});
	});

	it('lets the remote copy win a tie, as the server keeps its own', () => {
		const local = { state: 'go', name: 'A', at: T1 } as const;
		const remote = { state: 'nope', name: 'A', at: T1 } as const;
		expect(pick(local, remote)).toBe(remote);
	});

	it('compares instants, not strings', () => {
		// 20:30Z is before 21:00Z, though "22:30" sorts after "21:00".
		const local = { state: 'go', name: 'A', at: '2026-09-26T22:30:00+02:00' } as const;
		const remote = { state: 'nope', name: 'A', at: T1 } as const;
		expect(pick(local, remote)).toBe(remote);
	});

	it('treats tombstones like any change: newer deletes, older is overruled', () => {
		const local: SyncMap = {
			deletedLater: { state: null, name: '', at: T2 },
			deletedEarlier: { state: null, name: '', at: T0 }
		};
		const remote: SyncMap = {
			deletedLater: { state: 'go', name: 'X', at: T1 },
			deletedEarlier: { state: 'go', name: 'Y', at: T1 },
			removedRemotely: { state: null, name: '', at: T1 }
		};
		const merged = mergeBoards(
			{ ...local, removedRemotely: { state: 'go', name: 'Z', at: T0 } },
			remote
		);
		expect(boardOf(merged)).toEqual({ deletedEarlier: { state: 'go', name: 'Y', at: T1 } });
		expect(merged.deletedLater.state).toBeNull();
		expect(merged.removedRemotely.state).toBeNull();
	});

	it('does not mutate its inputs', () => {
		const local: SyncMap = Object.freeze({ a: Object.freeze({ state: 'go', name: 'A', at: T0 }) });
		const remote: SyncMap = Object.freeze({
			a: Object.freeze({ state: 'nope', name: 'A', at: T1 })
		});
		expect(() => mergeBoards(local, remote)).not.toThrow();
		expect(local.a.state).toBe('go');
	});
});

describe('toSyncMap / boardOf', () => {
	it('round-trips a board and adds tombstones for deleted keys', () => {
		const board: Board = { a: { state: 'go', name: 'A', gig: 'paradiso:1', at: T0 } };
		const map = toSyncMap(board, { b: T1 });
		expect(map).toEqual({
			a: { state: 'go', name: 'A', gig: 'paradiso:1', at: T0 },
			b: { state: null, name: '', at: T1 }
		});
		expect(boardOf(map)).toEqual(board);
	});

	it('lets a key on the board override a stale tombstone', () => {
		expect(toSyncMap({ a: { state: 'go', name: 'A', at: T0 } }, { a: T1 }).a.state).toBe('go');
	});
});

describe('diffBoards / recordDeletions', () => {
	const base: Board = {
		same: { state: 'go', name: 'S', at: T0 },
		changed: { state: 'go', name: 'C', at: T0 },
		gone: { state: 'listen', name: 'G', at: T0 }
	};
	const current: Board = {
		same: { state: 'go', name: 'S', at: '2026-09-26T20:00:00Z' }, // same instant, other spelling
		changed: { state: 'tickets', name: 'C', at: T1 },
		added: { state: 'nope', name: 'N', at: T1 }
	};

	it('finds changed, added and deleted keys', () => {
		expect(diffBoards(base, current)).toEqual({ changed: ['changed', 'added'], deleted: ['gone'] });
		expect(diffBoards(current, current)).toEqual({ changed: [], deleted: [] });
	});

	it('stamps new deletions with the time they were noticed and keeps older stamps', () => {
		const now = new Date(T2);
		const once = recordDeletions({}, diffBoards(base, current), current, now);
		expect(once).toEqual({ gone: T2 });
		const again = recordDeletions(
			once,
			diffBoards(base, current),
			current,
			new Date('2026-09-27T00:00:00Z')
		);
		expect(again).toEqual({ gone: T2 });
	});

	it('drops a tombstone when the artist is sorted again', () => {
		const readded = { ...current, gone: { state: 'go' as const, name: 'G', at: T2 } };
		expect(recordDeletions({ gone: T1 }, diffBoards(base, readded), readded, new Date(T2))).toEqual(
			{}
		);
	});

	it('sameBoard ignores timestamp spelling', () => {
		expect(sameBoard({ a: base.same }, { a: current.same })).toBe(true);
		expect(sameBoard(base, current)).toBe(false);
	});
});

describe('wire', () => {
	it('knows what the server accepts', () => {
		const ok = { state: 'go', name: 'A', at: T0 } as const;
		expect(isSyncable('mb:0b7a6b3e-5a1c-4c4e-9b1a-2f1d3e4c5b6a', ok)).toBe(true);
		expect(isSyncable('name:mogwai', ok)).toBe(true);
		expect(isSyncable('name:', ok)).toBe(true);
		expect(isSyncable('spotify:1', ok)).toBe(false);
		expect(isSyncable('mb:nope', ok)).toBe(false);
		expect(isSyncable('name:a', { ...ok, name: ' ' })).toBe(false);
		expect(isSyncable('name:a', { ...ok, at: '1999-01-01T00:00:00Z' })).toBe(false);
		expect(isSyncable('name:a', { state: null, name: '', at: T0 })).toBe(true);
	});

	it('normalises what goes out and checks what comes in', () => {
		expect(
			toWire('name:a', { state: null, name: 'A', gig: 'x:1', at: '2026-09-26T22:00:00+02:00' })
		).toEqual({
			key: 'name:a',
			state: null,
			name: '',
			at: T0
		});
		expect(fromWire({ key: 'name:a', state: 'go', name: 'A', at: T0 })).toEqual({
			key: 'name:a',
			state: 'go',
			name: 'A',
			at: T0
		});
		expect(fromWire({ key: 'name:a', state: 'maybe', name: 'A', at: T0 })).toBeNull();
		expect(fromWire({ key: 'name:a', state: 'go', name: 'A', at: 'soon' })).toBeNull();
		expect(fromWire(null)).toBeNull();
	});
});
