// The listener's board as reactive app state, the one copy everything reads and writes (the
// radio, the player bar, the Radio, Board, gig and artist pages): loaded from this browser, kept
// up to date with other tabs (storage events) and other devices (the sync client), and changed
// through `set`/`toggle`, which save and hand the change to the sync client. Changes start from
// this copy, which the events keep current, so sorting still works where storage doesn't.

import { browser } from '$app/environment';
import { localChanged, onSynced } from '$lib/sync/app';
import {
	BOARD_STORAGE_KEY,
	loadBoard,
	saveBoard,
	setTriage,
	toggleTriage,
	type Board,
	type Triage,
	type TriageMeta
} from './board';

class BoardStore {
	/** Artist key → how they're sorted. */
	items: Board = $state.raw({});

	constructor() {
		if (!browser) return;
		this.items = loadBoard();
		addEventListener('storage', (e) => {
			if (e.key === BOARD_STORAGE_KEY || e.key === null) this.items = loadBoard();
		});
		onSynced('board', (items) => (this.items = items));
	}

	/** How `artistKey` is sorted, or null. */
	stateOf(artistKey: string): Triage | null {
		return this.items[artistKey]?.state ?? null;
	}

	/** Sorts one artist into `state`, or takes them off the board with null. */
	set(artistKey: string, state: Triage | null, meta: TriageMeta): void {
		this.#save(setTriage(this.items, artistKey, state, meta, new Date()));
	}

	/** Sorts one artist into `state`; if they're there already, takes them off the board. */
	toggle(artistKey: string, state: Triage, meta: TriageMeta): void {
		this.#save(toggleTriage(this.items, artistKey, state, meta, new Date()));
	}

	#save(items: Board): void {
		this.items = items;
		saveBoard(items);
		localChanged();
	}
}

export const boardStore = new BoardStore();
