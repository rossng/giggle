// The app's one sync client, for the board, the unavailable dates and the radio's play history.
// Code that changes one of them calls `localChanged()` (or `boardChanged()`) after saving it;
// code that shows one listens with `onSynced(name, …)` (a window event carrying the merged
// data, already saved) to pick up changes made on other devices.

import { browser } from '$app/environment';
import type { PlayHistory } from '@giggle/radio-core';
import type { Board } from '$lib/board/board';
import type { Unavailable } from '$lib/data/unavailable';
import { SyncClient } from './client';
import { ALL_COLLECTIONS } from './collections';

/** What each synced collection's data looks like when it arrives. */
export interface SyncedData {
	board: Board;
	unavailable: Unavailable;
	plays: PlayHistory;
}

export type SyncedName = keyof SyncedData;

/** The window event for a collection: `giggle:board-synced` and so on. */
export function syncedEvent(name: SyncedName): string {
	return `giggle:${name}-synced`;
}

export const BOARD_SYNCED = syncedEvent('board');

export const sync: SyncClient | null = browser
	? new SyncClient({
			collections: ALL_COLLECTIONS,
			onChange: (name, data) =>
				window.dispatchEvent(new CustomEvent(syncedEvent(name as SyncedName), { detail: data }))
		})
	: null;

/** Call after saving any synced data: pushes the change when the sync client next runs. */
export function localChanged(): void {
	sync?.notifyLocalChange();
}

/** Call after `saveBoard`. */
export function boardChanged(): void {
	localChanged();
}

/** Calls `apply` with each version of `name` merged in from the server; returns an unsubscribe. */
export function onSynced<K extends SyncedName>(
	name: K,
	apply: (data: SyncedData[K]) => void
): () => void {
	if (!browser) return () => {};
	const listener = (e: Event) => apply((e as CustomEvent<SyncedData[K]>).detail);
	window.addEventListener(syncedEvent(name), listener);
	return () => window.removeEventListener(syncedEvent(name), listener);
}

/** Calls `apply` with each board merged in from the server; returns an unsubscribe. */
export function onBoardSynced(apply: (board: Board) => void): () => void {
	return onSynced('board', apply);
}
