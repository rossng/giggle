// The board as the app holds it right now: the radio's copy (`radio.board`), which lives for the
// whole visit (lib/radio/app). Pages that sort artists go through here, so the radio, the Board
// page and storage never disagree, and the radio's next 1/2/3/X doesn't undo a page's change.

import type { Catalog } from '$lib/data/catalog';
import { radioApp } from '$lib/radio/app.svelte';
import { boardChanged } from '$lib/sync/app';
import { loadBoard, saveBoard, setTriage, type Board, type Triage, type TriageMeta } from './board';

/** The current board (reactive: it's the radio's `$state`). */
export function liveBoard(catalog: Catalog): Board {
	return radioApp.radio(catalog).board;
}

/** Sorts one artist (null unsorts them), saves it, and queues it for sync. */
export function sortArtist(
	catalog: Catalog,
	artistKey: string,
	state: Triage | null,
	meta: TriageMeta
): Board {
	const radio = radioApp.radio(catalog);
	const board = setTriage(radio.board, artistKey, state, meta, new Date());
	radio.board = board;
	saveBoard(board);
	boardChanged();
	return board;
}

/** Picks up a board another tab saved. */
export function reloadBoard(catalog: Catalog): void {
	radioApp.radio(catalog).board = loadBoard();
}
