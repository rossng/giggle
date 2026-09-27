// The app's one radio. It lives for the whole visit, above the pages, so moving between Radio,
// Agenda and Board never stops the music: the (app) layout creates it, keeps its station in step
// and hosts its video (VideoDock) and controls (PlayerBar). The station is app state: the Radio
// page's URL mirrors it (so a station is still a shareable link), and it stays as you browse.

import type { Artist as CoreArtist, Gig as CoreGig, RadioOrder } from '@giggle/radio-core';
import type { Catalog } from '$lib/data/catalog';
import { apply } from '$lib/data/filters';
import { Radio } from './radio.svelte';
import { stationFromParams, stationKey, type Station } from './station';
import { artistImage, introClips, trackIndex } from './tracks';

class RadioApp {
	/** The current station; the Radio page's URL mirrors it. */
	station = $state<Station>(stationFromParams(new URLSearchParams()));
	/** Where the Radio page wants the video; null elsewhere, and it floats as a tile. */
	videoSlot = $state.raw<HTMLElement | null>(null);
	/** The station & settings drawer. */
	settingsOpen = $state(false);
	/** The floating video tile tucked away (phones): playback pauses, as YouTube requires. */
	videoTucked = $state(false);
	#radio: Radio | null = null;
	#catalog: Catalog | null = null;
	#indexes: { tracks: ReturnType<typeof trackIndex>; clips: ReturnType<typeof introClips> } | null =
		null;
	/** An artist to play once the station that has them is tuned in (see playArtist). */
	#pending: string | null = null;

	/** The radio if it exists yet (for tests and debugging). */
	get current(): Radio | null {
		return this.#radio;
	}

	/** The radio, made on first use with the visit's catalog. */
	radio(catalog: Catalog): Radio {
		if (this.#catalog !== catalog) {
			this.#catalog = catalog;
			this.#indexes = { tracks: trackIndex(catalog.artists), clips: introClips(catalog.artists) };
		}
		if (!this.#radio) {
			// Its own root, so its derived state never belongs to (and dies with) whichever
			// component or derivation happened to ask for it first.
			$effect.root(() => {
				this.#radio = new Radio({
					venues: catalog.venues,
					image: (entry) => artistImage(this.#catalog?.artists[entry.artistKey]),
					onOrderChange: (order: RadioOrder, seed: number) => {
						this.station = { ...this.station, order, orderGiven: true, seed };
					}
				});
			});
		}
		return this.#radio!;
	}

	/** Feeds the station's gigs to the radio (the layout calls this whenever they change). */
	tune(catalog: Catalog, isUnavailable: (date: string) => boolean, now: Date): void {
		const radio = this.radio(catalog);
		const station = this.station;
		const shown = apply(station.filters, catalog.gigs, now, isUnavailable);
		radio.setStation({
			key: stationKey(station.filters),
			gigs: shown.map((v) => v.gig) as unknown as CoreGig[],
			tracks: this.#indexes!.tracks,
			artists: catalog.artists as unknown as Record<string, CoreArtist>,
			clips: this.#indexes!.clips,
			order: station.order,
			orderGiven: station.orderGiven,
			seed: station.seed
		});
		const pending = this.#pending;
		this.#pending = null;
		if (pending) {
			const index = radio.queue.findIndex((e) => e.artistKey === pending);
			if (index >= 0) radio.jump(index);
		}
	}

	/**
	 * Plays one artist now: from the current station when they're on it, else from a station
	 * searching for them (so their gig is what comes up).
	 */
	playArtist(catalog: Catalog, artistKey: string, name: string): void {
		const radio = this.radio(catalog);
		const index = radio.queue.findIndex((e) => e.artistKey === artistKey);
		if (index >= 0) {
			radio.jump(index);
			return;
		}
		this.#pending = artistKey;
		this.station = stationFromParams(new URLSearchParams({ q: name }));
	}
}

// One per page load. Kept on globalThis so a dev hot reload that re-runs this module reuses it,
// rather than making a second radio while the first one's video keeps playing.
const global = globalThis as typeof globalThis & { __giggleRadio?: RadioApp };
export const radioApp: RadioApp = (global.__giggleRadio ??= new RadioApp());
