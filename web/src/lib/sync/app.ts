// The app's one sync client. Pages that change the board call `boardChanged()` after
// saving it; pages that show the board listen for `BOARD_SYNCED` (a window event carrying
// the merged board) to pick up changes made on other devices.

import { browser } from '$app/environment';
import type { Board } from '$lib/board/board';
import { SyncClient } from './client';

export const BOARD_SYNCED = 'giggle:board-synced';

export const boardSync: SyncClient | null = browser
	? new SyncClient({
			onBoard: (board: Board) =>
				window.dispatchEvent(new CustomEvent<Board>(BOARD_SYNCED, { detail: board }))
		})
	: null;

/** Call after `saveBoard`: pushes the change when the sync client next runs. */
export function boardChanged(): void {
	boardSync?.notifyLocalChange();
}

/** Calls `apply` with each board merged in from the server; returns an unsubscribe. */
export function onBoardSynced(apply: (board: Board) => void): () => void {
	if (!browser) return () => {};
	const listener = (e: Event) => apply((e as CustomEvent<Board>).detail);
	window.addEventListener(BOARD_SYNCED, listener);
	return () => window.removeEventListener(BOARD_SYNCED, listener);
}
