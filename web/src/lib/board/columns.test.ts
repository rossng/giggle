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
	'gig:paradiso:sold': { state: 'go', name: 'Glass Harbour', artist: 'mb:gh', at },
	'gig:paradiso:past': { state: 'tickets', name: 'Old Band', artist: 'mb:old', at },
	// Dropped out of the data; the stored date says it's been.
	'gig:tivolivredenburg:1': {
		state: 'go',
		name: 'Went Band',
		artist: 'name:went',
		when: '2026-09-28T20:00:00+02:00',
		at
	},
	// Gone from the listings before it happened.
	'gig:melkweg:2': {
		state: 'tickets',
		name: 'Gone Band',
		when: '2026-10-20T20:00:00+02:00',
		at
	},
	'mb:meh': { state: 'nope', name: 'Meh', at }
};

describe('boardColumns', () => {
	const columns = boardColumns(BOARD, catalogWith(), TODAY);

	it('shows an artist with their next gig and a countdown', () => {
		const [nobu] = columns.listen;
		expect(nobu).toMatchObject({ kind: 'artist', artistKey: 'mb:nobu' });
		expect(nobu.gig?.id).toBe('paradiso:soon');
		expect(nobu.inDays).toBe(2);
	});

	it('shows a gig with the artist it was sorted for', () => {
		const [gh] = columns.go;
		expect(gh).toMatchObject({ kind: 'gig', name: 'Glass Harbour', artistKey: 'mb:gh' });
		expect(gh.gig?.id).toBe('paradiso:sold');
		expect(gh.venueName).toBe('Paradiso');
	});

	it('moves gigs that have passed into Been, latest first', () => {
		expect(columns.been.map((c) => c.key)).toEqual(['gig:tivolivredenburg:1', 'gig:paradiso:past']);
		expect(columns.been[0].venueName).toBe('TivoliVredenburg');
	});

	it('warns when a gig you want to go to sells out, or leaves the listings', () => {
		expect(columns.go.map((c) => [c.key, c.warnings])).toEqual([
			['gig:paradiso:sold', ['sold-out']]
		]);
		expect(columns.tickets.map((c) => [c.key, c.warnings, c.inDays])).toEqual([
			['gig:melkweg:2', ['unlisted'], 19]
		]);
	});

	it('keeps "not for me" without warnings', () => {
		expect(columns.nope.map((c) => [c.name, c.warnings])).toEqual([['Meh', []]]);
	});

	it("warns (without hiding) when a gig is on one of the listener's unavailable dates", () => {
		const away = (date: string) => date === '2026-10-03' || date === '2026-10-16';
		const cols = boardColumns(BOARD, catalogWith(), TODAY, away);
		expect(cols.listen.map((c) => [c.key, c.gig?.id, c.warnings])).toEqual([
			['mb:nobu', 'paradiso:soon', ['unavailable']]
		]);
		expect(cols.go.map((c) => [c.key, c.warnings])).toEqual([
			['gig:paradiso:sold', ['sold-out', 'unavailable']]
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
