import { describe, expect, it } from 'vitest';
import { buildCatalog } from '$lib/data/catalog';
import { artist, gig, VENUES } from '$lib/data/fixtures';
import { boardColumns, countdownText } from './columns';
import type { Board } from './board';

const TODAY = '2026-10-01';

function catalogWith() {
	const gigs = [
		gig({ source_id: 'past', title: 'Old Band', start: '2026-09-20T20:00:00+02:00' }),
		gig({ source_id: 'soon', title: 'Nobu', start: '2026-10-03T20:30:00+02:00' }),
		gig({
			source_id: 'sold',
			title: 'Glass Harbour',
			start: '2026-10-16T20:30:00+02:00',
			availability: 'sold_out'
		}),
		gig({ source_id: 'later', title: 'Nobu', start: '2026-11-20T20:30:00+02:00' })
	];
	const artists = {
		'mb:old': artist({ key: 'mb:old', name: 'Old Band', gigs: ['paradiso:past'] }),
		'mb:nobu': artist({ key: 'mb:nobu', name: 'Nobu', gigs: ['paradiso:later', 'paradiso:soon'] }),
		'mb:gh': artist({ key: 'mb:gh', name: 'Glass Harbour', gigs: ['paradiso:sold'] })
	};
	return buildCatalog(
		{ generated: '2026-10-01T05:00:00+02:00', since: TODAY, venues: VENUES, gigs },
		{ artists }
	);
}

const at = '2026-09-25T12:00:00.000Z';
const BOARD: Board = {
	'mb:nobu': { state: 'listen', name: 'Nobu', at },
	'mb:gh': { state: 'go', name: 'Glass Harbour', gig: 'paradiso:sold', at },
	'mb:old': { state: 'tickets', name: 'Old Band', gig: 'paradiso:past', at },
	// Their gig has dropped out of the data; the stored date says it's been.
	'name:went': {
		state: 'go',
		name: 'Went Band',
		gig: 'melkweg:1',
		when: '2026-09-28T20:00:00+02:00',
		at
	},
	// Nothing known about when: not assumed to be over.
	'name:gone': { state: 'go', name: 'Gone Band', at },
	'name:meh': { state: 'nope', name: 'Meh', at }
};

describe('boardColumns', () => {
	const columns = boardColumns(BOARD, catalogWith(), TODAY);

	it('shows each artist with their next gig and a countdown', () => {
		const [nobu] = columns.listen;
		expect(nobu.next?.id).toBe('paradiso:soon');
		expect(nobu.inDays).toBe(2);
	});

	it('moves wanted artists whose gig has passed into Been', () => {
		expect(columns.been.map((c) => c.key)).toEqual(['name:went', 'mb:old']);
		expect(columns.tickets).toEqual([]);
	});

	it('warns when a gig you want to go to sells out', () => {
		expect(columns.go.map((c) => [c.key, c.warnings])).toEqual([
			['mb:gh', ['sold-out']],
			['name:gone', ['no-gig']]
		]);
	});

	it('keeps "not for me" without warnings', () => {
		expect(columns.nope.map((c) => [c.name, c.warnings])).toEqual([['Meh', []]]);
	});

	it("warns (without hiding) when the next gig is on one of the listener's unavailable dates", () => {
		const away = (date: string) => date === '2026-10-03' || date === '2026-10-16';
		const cols = boardColumns(BOARD, catalogWith(), TODAY, away);
		expect(cols.listen.map((c) => [c.key, c.next?.id, c.warnings])).toEqual([
			['mb:nobu', 'paradiso:soon', ['unavailable']]
		]);
		expect(cols.go.map((c) => [c.key, c.warnings])).toEqual([
			['mb:gh', ['sold-out', 'unavailable']],
			['name:gone', ['no-gig']]
		]);
		const nope: Board = { 'mb:nobu': { state: 'nope', name: 'Nobu', at } };
		expect(boardColumns(nope, catalogWith(), TODAY, away).nope[0].warnings).toEqual([]);
		expect(boardColumns(BOARD, catalogWith(), TODAY).listen[0].warnings).toEqual([]);
	});

	it('flags listen-more artists with nothing coming up', () => {
		const board: Board = { 'mb:old': { state: 'listen', name: 'Old Band', at } };
		expect(boardColumns(board, catalogWith(), TODAY).listen[0].warnings).toEqual(['no-gig']);
	});
});

describe('countdownText', () => {
	it('says how soon, briefly', () => {
		expect(countdownText(null)).toBeNull();
		expect(countdownText(0)).toBe('today');
		expect(countdownText(1)).toBe('tomorrow');
		expect(countdownText(13)).toBe('in 13 days');
		expect(countdownText(14)).toBe('in 2 wks');
		expect(countdownText(45)).toBe('in 6 wks');
	});
});
