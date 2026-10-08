// The Board page's columns, worked out from the stored board and tonight's data. Pure, so
// it's tested without a browser. Two kinds of card, as on the board (board.ts): gigs (want to
// go, got tickets, and "been", which nobody picks: those gigs land there once they're past),
// and artists (listen more, not for me), each shown with their next gig.

import type { Catalog, GigView } from '$lib/data/catalog';
import { daysBetween, localDate } from '$lib/data/dates';
import type { DateTest } from '$lib/data/filters';
import { own } from '$lib/data/own';
import type { IsoDate } from '$lib/data/types';
import { gigIdOf, isGigKey, type Board, type BoardItem, type Triage } from './board';

export type ColumnId = 'go' | 'tickets' | 'been' | 'listen' | 'nope';
export type CardKind = 'gig' | 'artist';

export const COLUMNS: readonly { id: ColumnId; kind: CardKind; label: string; hint: string }[] = [
	{ id: 'go', kind: 'gig', label: 'Want to go', hint: 'Worth a ticket' },
	{ id: 'tickets', kind: 'gig', label: 'Got tickets', hint: 'See you there' },
	{ id: 'been', kind: 'gig', label: 'Been', hint: 'Gigs that have passed' },
	{ id: 'listen', kind: 'artist', label: 'Listen more', hint: 'Come up more often on the radio' },
	{ id: 'nope', kind: 'artist', label: 'Not for me', hint: 'Kept off the radio' }
];

/** 'unlisted': gone from the listings before it happened (cancelled, or moved to another page).
 * 'no-gig': an artist with nothing coming up. 'unavailable': on one of the listener's
 * unavailable dates. */
export type Warning = 'sold-out' | 'unlisted' | 'no-gig' | 'unavailable';

/** Sorts after any real start time. */
const NO_GIG = '￿';

export interface Card {
	/** Its key on the board. */
	key: string;
	kind: CardKind;
	/** The artist's (a gig's: the artist it was sorted for). */
	name: string;
	artistKey: string | null;
	state: Triage;
	column: ColumnId;
	/** A gig card's gig while it's in tonight's data; an artist card's next gig. */
	gig: GigView | null;
	/** When `gig` starts (a gig card's, as stored once it's left the data), ISO 8601. */
	start: string | null;
	/** Days until `start`: 0 is today, negative once past. */
	inDays: number | null;
	past: boolean;
	/** The venue, by name if it's in the data. */
	venueName: string | null;
	warnings: Warning[];
	item: BoardItem;
}

/** The artist's upcoming gigs, soonest first. */
export function upcomingGigs(artistKey: string, catalog: Catalog, today: IsoDate): GigView[] {
	return (own(catalog.artists, artistKey)?.gigs ?? [])
		.map((id) => catalog.byId.get(id))
		.filter((v): v is GigView => !!v && v.date >= today)
		.sort((a, b) => a.gig.start.localeCompare(b.gig.start));
}

function gigCard(
	key: string,
	item: BoardItem,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Card {
	const gigId = gigIdOf(key);
	const view = catalog.byId.get(gigId) ?? null;
	// Past gigs drop out of the data, so the date stored with the item decides.
	const start = view?.gig.start ?? item.when ?? null;
	const date = start ? localDate(start) : null;
	const past = date !== null && date < today;
	const warnings: Warning[] = [];
	if (!past) {
		if (!view) warnings.push('unlisted');
		if (item.state === 'go' && view?.soldOut) warnings.push('sold-out');
		if (date && unavailable?.(date)) warnings.push('unavailable');
	}
	const artist = item.artist ? own(catalog.artists, item.artist) : undefined;
	return {
		key,
		kind: 'gig',
		name: artist?.name ?? item.name,
		artistKey: item.artist ?? null,
		state: item.state,
		column: past ? 'been' : item.state,
		gig: view,
		start,
		inDays: date ? daysBetween(today, date) : null,
		past,
		venueName:
			view?.venueName ?? own(catalog.venues, gigId.slice(0, gigId.indexOf(':')))?.name ?? null,
		warnings,
		item
	};
}

function artistCard(
	key: string,
	item: BoardItem,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Card {
	const next = upcomingGigs(key, catalog, today)[0] ?? null;
	const date = next ? next.date : null;
	const warnings: Warning[] = [];
	if (item.state === 'listen') {
		if (!next) warnings.push('no-gig');
		if (date && unavailable?.(date)) warnings.push('unavailable');
	}
	return {
		key,
		kind: 'artist',
		name: own(catalog.artists, key)?.name ?? item.name,
		artistKey: key,
		state: item.state,
		column: item.state,
		gig: next,
		start: next?.gig.start ?? null,
		inDays: date ? daysBetween(today, date) : null,
		past: false,
		venueName: next?.venueName ?? null,
		warnings,
		item
	};
}

/** `unavailable`: the listener's unavailable dates (unavailable.ts), for the warning. */
export function boardCards(
	board: Board,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Card[] {
	return Object.entries(board).map(([key, item]) =>
		(isGigKey(key) ? gigCard : artistCard)(key, item, catalog, today, unavailable)
	);
}

/** Cards per column: soonest gig first, then most recently sorted. Been: latest first. */
export function boardColumns(
	board: Board,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Record<ColumnId, Card[]> {
	const columns: Record<ColumnId, Card[]> = { go: [], tickets: [], been: [], listen: [], nope: [] };
	for (const c of boardCards(board, catalog, today, unavailable)) columns[c.column].push(c);
	const bySoonest = (a: Card, b: Card) =>
		(a.start ?? NO_GIG).localeCompare(b.start ?? NO_GIG) || b.item.at.localeCompare(a.item.at);
	for (const id of ['go', 'tickets', 'listen', 'nope'] as const) columns[id].sort(bySoonest);
	columns.been.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''));
	return columns;
}

/** How soon a card's gig is, briefly: "today", "tomorrow", "in 5 days", "in 3 wks". */
export function countdownText(inDays: number | null): string | null {
	if (inDays === null || inDays < 0) return null;
	if (inDays === 0) return 'today';
	if (inDays === 1) return 'tomorrow';
	if (inDays < 14) return `in ${inDays} days`;
	return `in ${Math.round(inDays / 7)} wks`;
}
