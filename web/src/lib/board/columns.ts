// The Board page's columns, worked out from the stored board and tonight's data. Pure, so
// it's tested without a browser. "Been" isn't a state anyone picks: artists sorted as
// "want to go" or "got tickets" land there once their gig is past and nothing's coming up.

import type { Catalog, GigView } from '$lib/data/catalog';
import { daysBetween, localDate } from '$lib/data/dates';
import type { DateTest } from '$lib/data/filters';
import type { IsoDate } from '$lib/data/types';
import type { Board, BoardItem, Triage } from './board';

export type ColumnId = 'listen' | 'go' | 'tickets' | 'been' | 'nope';

export const COLUMNS: readonly { id: ColumnId; label: string; hint: string }[] = [
	{ id: 'listen', label: 'Listen more', hint: 'Come up more often on the radio' },
	{ id: 'go', label: 'Want to go', hint: 'Worth a ticket' },
	{ id: 'tickets', label: 'Got tickets', hint: 'See you there' },
	{ id: 'been', label: 'Been', hint: 'Their gig has passed' },
	{ id: 'nope', label: 'Not for me', hint: 'Kept off the radio' }
];

/** 'unavailable': their next gig is on one of the listener's unavailable dates. */
export type Warning = 'sold-out' | 'no-gig' | 'unavailable';

/** Sorts after any real start time. */
const NO_GIG = '\uffff';

export interface Card {
	key: string;
	name: string;
	state: Triage;
	column: ColumnId;
	/** Their next gig in tonight's data, if any. */
	next: GigView | null;
	/** Days until `next`: 0 is today. */
	inDays: number | null;
	/** The gig they were sorted from, when it's in the data (may be past). */
	sortedFrom: GigView | null;
	warnings: Warning[];
	item: BoardItem;
}

/** The artist's upcoming gigs, soonest first. */
function upcoming(key: string, catalog: Catalog, today: IsoDate): GigView[] {
	const ids = catalog.artists[key]?.gigs ?? [];
	return ids
		.map((id) => catalog.byId.get(id))
		.filter((v): v is GigView => !!v && localDate(v.gig.start) >= today)
		.sort((a, b) => a.gig.start.localeCompare(b.gig.start));
}

/** `unavailable`: the listener's unavailable dates (unavailable.ts), for the warning. */
export function boardCards(
	board: Board,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Card[] {
	return Object.entries(board).map(([key, item]) => {
		const next = upcoming(key, catalog, today)[0] ?? null;
		const sortedFrom = (item.gig && catalog.byId.get(item.gig)) || null;
		// Past gigs drop out of the data, so the date stored with the item decides.
		const when = sortedFrom?.gig.start ?? item.when ?? null;
		const sortedPast = when !== null && localDate(when) < today;
		const wanted = item.state === 'go' || item.state === 'tickets';
		// The gig they were sorted for is over and nothing's next.
		const been = wanted && !next && sortedPast;
		const warnings: Warning[] = [];
		if (item.state === 'go' && next?.soldOut) warnings.push('sold-out');
		if (!next && !been && item.state !== 'nope') warnings.push('no-gig');
		if (next && item.state !== 'nope' && unavailable?.(localDate(next.gig.start))) {
			warnings.push('unavailable');
		}
		return {
			key,
			name: catalog.artists[key]?.name ?? item.name,
			state: item.state,
			column: been ? 'been' : item.state,
			next,
			inDays: next ? daysBetween(today, localDate(next.gig.start)) : null,
			sortedFrom,
			warnings,
			item
		};
	});
}

/** Cards per column: soonest gig first, then most recently sorted. Been: latest first. */
export function boardColumns(
	board: Board,
	catalog: Catalog,
	today: IsoDate,
	unavailable?: DateTest
): Record<ColumnId, Card[]> {
	const columns: Record<ColumnId, Card[]> = { listen: [], go: [], tickets: [], been: [], nope: [] };
	for (const card of boardCards(board, catalog, today, unavailable))
		columns[card.column].push(card);
	const bySoonest = (a: Card, b: Card) =>
		(a.next?.gig.start ?? NO_GIG).localeCompare(b.next?.gig.start ?? NO_GIG) ||
		b.item.at.localeCompare(a.item.at);
	for (const id of ['listen', 'go', 'tickets', 'nope'] as const) columns[id].sort(bySoonest);
	const seen = (c: Card) => c.sortedFrom?.gig.start ?? c.item.when ?? c.item.at;
	columns.been.sort((a, b) => seen(b).localeCompare(seen(a)));
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
