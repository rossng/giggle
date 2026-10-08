// The listener's board as reactive app state, the one copy everything reads and writes (the
// radio, the player bar, the Radio, Board, gig and artist pages): loaded from this browser, kept
// up to date with other tabs (storage events) and other devices (the sync client), and changed
// through the set/toggle methods, which save and hand the change to the sync client. Changes
// start from this copy, which the events keep current, so sorting still works where storage
// doesn't. Artists and gigs are sorted apart (board.ts).

import { browser } from '$app/environment';
import { localChanged, onSynced } from '$lib/sync/app';
import {
	artistState,
	BOARD_STORAGE_KEY,
	gigState,
	loadBoard,
	saveBoard,
	setArtist,
	setGig,
	toggleArtist,
	toggleGig,
	type ArtistTriage,
	type Board,
	type GigMeta,
	type GigTriage
} from './board';

type Artist = { key: string; name: string };

class BoardStore {
	/** Artist and gig keys → how they're sorted. */
	items: Board = $state.raw({});

	constructor() {
		if (!browser) return;
		this.items = loadBoard();
		addEventListener('storage', (e) => {
			if (e.key === BOARD_STORAGE_KEY || e.key === null) this.items = loadBoard();
		});
		onSynced('board', (items) => (this.items = items));
	}

	/** How an artist is sorted (listen more, not for me), or null. */
	artistState(artistKey: string): ArtistTriage | null {
		return artistState(this.items, artistKey);
	}

	/** How a gig is sorted (want to go, got tickets), or null. */
	gigState(gigId: string): GigTriage | null {
		return gigState(this.items, gigId);
	}

	setArtist(artist: Artist, state: ArtistTriage | null): void {
		this.#save(setArtist(this.items, artist, state, new Date()));
	}

	/** Sorts an artist into `state`; if they're there already, unsorts them. */
	toggleArtist(artist: Artist, state: ArtistTriage): void {
		this.#save(toggleArtist(this.items, artist, state, new Date()));
	}

	setGig(gigId: string, state: GigTriage | null, meta: GigMeta): void {
		this.#save(setGig(this.items, gigId, state, meta, new Date()));
	}

	/** Sorts a gig into `state`; if it's there already, unsorts it. */
	toggleGig(gigId: string, state: GigTriage, meta: GigMeta): void {
		this.#save(toggleGig(this.items, gigId, state, meta, new Date()));
	}

	#save(items: Board): void {
		this.items = items;
		saveBoard(items);
		localChanged();
	}
}

export const boardStore = new BoardStore();
