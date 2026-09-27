// radio-core's `Player` over the YouTube IFrame API (https://www.youtube.com/iframe_api).
//
// The embed must stay visible and at least 200×200 px (YouTube's terms), so the radio
// shows it. Its volume is tracked here, not read back from the iframe: `getVolume()` on a
// YT player lags behind `setVolume()`, which would throw ducking fades off.
//
// Never keep an instance of this class (or the YT player inside it) in Svelte `$state`.

import type { Player, PlayerError, Track, Unsubscribe } from '@giggle/radio-core';

// ---------- the parts of the IFrame API we use ----------

interface YTPlayer {
	loadVideoById(options: { videoId: string; startSeconds?: number }): void;
	cueVideoById(options: { videoId: string; startSeconds?: number }): void;
	playVideo(): void;
	pauseVideo(): void;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	setVolume(volume: number): void;
	unMute(): void;
	getCurrentTime(): number;
	getDuration(): number;
	destroy(): void;
}

interface YTEvent<T = unknown> {
	target: YTPlayer;
	data: T;
}

interface YTNamespace {
	Player: new (
		element: HTMLElement,
		options: {
			width?: string | number;
			height?: string | number;
			videoId?: string;
			playerVars?: Record<string, string | number>;
			events?: {
				onReady?: (event: YTEvent) => void;
				onStateChange?: (event: YTEvent<number>) => void;
				onError?: (event: YTEvent<number>) => void;
			};
		}
	) => YTPlayer;
}

declare global {
	interface Window {
		YT?: YTNamespace & { loaded?: number };
		onYouTubeIframeAPIReady?: () => void;
	}
}

const API_URL = 'https://www.youtube.com/iframe_api';
let api: Promise<YTNamespace> | null = null;

/** Loads the IFrame API once per page. */
export function loadYouTubeApi(): Promise<YTNamespace> {
	if (api) return api;
	api = new Promise<YTNamespace>((resolve, reject) => {
		if (window.YT?.Player && window.YT.loaded) return resolve(window.YT);
		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			if (window.YT) resolve(window.YT);
		};
		const script = document.createElement('script');
		script.src = API_URL;
		script.async = true;
		script.onerror = () => {
			api = null;
			reject(new Error("Couldn't load the YouTube player"));
		};
		document.head.append(script);
	});
	return api;
}

// ---------- the player ----------

/** YT.PlayerState, by name. */
export type PlaybackState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

const STATES: Record<number, PlaybackState> = {
	[-1]: 'unstarted',
	0: 'ended',
	1: 'playing',
	2: 'paused',
	3: 'buffering',
	5: 'cued'
};

/** YouTube's error codes, for messages. 101 and 150: the owner doesn't allow embedding. */
export const YOUTUBE_ERRORS: Readonly<Record<number, string>> = {
	2: 'bad video id',
	5: "the browser can't play it",
	100: "it's gone from YouTube, or private",
	101: 'its owner only allows it on YouTube itself',
	150: 'its owner only allows it on YouTube itself',
	153: 'no referrer sent'
};

/** The video won't play in an embed, however often it's tried: gone (100), or its owner
 * doesn't allow it outside YouTube (101, 150). Not the player's own trouble (2, 5, 153). */
export function isUnplayable(error: PlayerError): boolean {
	return error.code === 100 || error.code === 101 || error.code === 150;
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
	#listeners = new Set<Listener<T>>();
	on(listener: Listener<T>): Unsubscribe {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}
	emit(value: T): void {
		for (const listener of [...this.#listeners]) listener(value);
	}
}

export class YouTubePlayer implements Player {
	#yt: YTPlayer | null = null;
	#ready: Promise<YTPlayer>;
	#destroyed = false;
	#volume = 100;
	#videoId: string | null = null;
	#state: PlaybackState = 'unstarted';
	readonly #ended = new Emitter<void>();
	readonly #errors = new Emitter<PlayerError>();
	readonly #playing = new Emitter<void>();
	readonly #states = new Emitter<PlaybackState>();

	/** Replaces nothing: the iframe goes into a new element inside `container`. */
	constructor(container: HTMLElement, volume = 100) {
		this.#volume = volume;
		const host = document.createElement('div');
		container.append(host);
		this.#ready = loadYouTubeApi().then(
			(YT) =>
				new Promise<YTPlayer>((resolve) => {
					const player = new YT.Player(host, {
						width: '100%',
						height: '100%',
						playerVars: {
							playsinline: 1,
							rel: 0,
							origin: location.origin
						},
						events: {
							onReady: () => {
								if (this.#destroyed) return;
								this.#yt = player;
								player.setVolume(this.#volume);
								resolve(player);
							},
							onStateChange: (event) => this.#onState(event.data),
							onError: (event) => {
								const code = event.data;
								this.#errors.emit({ code, message: YOUTUBE_ERRORS[code] ?? `error ${code}` });
							}
						}
					});
				})
		);
	}

	/** Resolves once the embed can take commands. */
	get ready(): Promise<unknown> {
		return this.#ready;
	}

	get videoId(): string | null {
		return this.#videoId;
	}

	get state(): PlaybackState {
		return this.#state;
	}

	#onState(code: number): void {
		const state = STATES[code] ?? this.#state;
		this.#state = state;
		this.#states.emit(state);
		if (state === 'playing') this.#playing.emit();
		if (state === 'ended') this.#ended.emit();
	}

	#run(command: (yt: YTPlayer) => void): void {
		if (this.#yt) command(this.#yt);
		else void this.#ready.then((yt) => !this.#destroyed && command(yt));
	}

	/** Loads and plays `track`, optionally from `startSeconds`. */
	load(track: Track, startSeconds = 0): void {
		this.#videoId = track.videoId;
		this.#run((yt) => {
			yt.setVolume(this.#volume);
			yt.loadVideoById({ videoId: track.videoId, startSeconds: Math.max(0, startSeconds) });
		});
	}

	/** Loads `track` paused at `startSeconds` (for resuming after a reload). */
	cue(track: Track, startSeconds = 0): void {
		this.#videoId = track.videoId;
		this.#run((yt) =>
			yt.cueVideoById({ videoId: track.videoId, startSeconds: Math.max(0, startSeconds) })
		);
	}

	play(): void {
		this.#run((yt) => yt.playVideo());
	}

	pause(): void {
		this.#run((yt) => yt.pauseVideo());
	}

	seek(seconds: number): void {
		this.#run((yt) => yt.seekTo(Math.max(0, seconds), true));
	}

	setVolume(volume: number): void {
		this.#volume = Math.min(100, Math.max(0, Math.round(volume)));
		this.#yt?.setVolume(this.#volume);
	}

	getVolume(): number {
		return this.#volume;
	}

	/** Seconds into the current video (0 before it's ready). */
	currentTime(): number {
		try {
			return this.#yt?.getCurrentTime() ?? 0;
		} catch {
			return 0;
		}
	}

	/** The current video's length in seconds, or 0 while unknown. */
	duration(): number {
		try {
			return this.#yt?.getDuration() ?? 0;
		} catch {
			return 0;
		}
	}

	onEnded(callback: () => void): Unsubscribe {
		return this.#ended.on(callback);
	}

	onError(callback: (error: PlayerError) => void): Unsubscribe {
		return this.#errors.on(callback);
	}

	onPlaying(callback: () => void): Unsubscribe {
		return this.#playing.on(callback);
	}

	onStateChange(callback: (state: PlaybackState) => void): Unsubscribe {
		return this.#states.on(callback);
	}

	destroy(): void {
		this.#destroyed = true;
		try {
			this.#yt?.destroy();
		} catch {
			// already gone
		}
		this.#yt = null;
	}
}
