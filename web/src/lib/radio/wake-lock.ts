// "Keep screen on while playing": the Screen Wake Lock API stops a phone from sleeping, since
// the radio can't play with the screen off (YouTube's embed pauses once the page is hidden).
//
// Browsers drop the lock whenever the page is hidden, so it's asked for again when the page is
// visible. It's held on a little after the music stops (a track changing over, a pause for a
// line) rather than dropped and taken again at every gap.

/** How long the lock outlives the music: long enough for a gap between tracks. */
export const LINGER_MS = 30_000;

interface Sentinel {
	readonly released: boolean;
	release(): Promise<void>;
	addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockHost {
	/** `navigator.wakeLock`, or undefined where there's none. */
	wakeLock?: { request(type: 'screen'): Promise<Sentinel> };
	/** The document, for its visibility. */
	document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

function browserHost(): WakeLockHost {
	return {
		wakeLock:
			typeof navigator !== 'undefined' && 'wakeLock' in navigator
				? (navigator.wakeLock as WakeLockHost['wakeLock'])
				: undefined,
		document: typeof document !== 'undefined' ? document : undefined
	};
}

/** Whether this browser can keep the screen on (the setting is hidden where it can't). */
export function canKeepScreenOn(host: WakeLockHost = browserHost()): boolean {
	return !!host.wakeLock;
}

export class ScreenWake {
	readonly #host: WakeLockHost;
	#wanted = false;
	#sentinel: Sentinel | null = null;
	#requesting = false;
	#linger: ReturnType<typeof setTimeout> | undefined;
	readonly #onVisible = () => {
		if (this.#host.document?.visibilityState === 'visible') this.#acquire();
	};

	constructor(host: WakeLockHost = browserHost()) {
		this.#host = host;
		host.document?.addEventListener('visibilitychange', this.#onVisible);
	}

	/** Whether the lock is held now. */
	get held(): boolean {
		return !!this.#sentinel && !this.#sentinel.released;
	}

	/** Keep the screen on (the setting is on and the radio is playing), or let it sleep again. */
	set(wanted: boolean): void {
		clearTimeout(this.#linger);
		this.#linger = undefined;
		if (wanted) {
			this.#wanted = true;
			this.#acquire();
		} else if (this.#wanted) {
			this.#linger = setTimeout(() => {
				this.#linger = undefined;
				this.#wanted = false;
				this.#release();
			}, LINGER_MS);
		}
	}

	/** Lets go now, for good. */
	destroy(): void {
		clearTimeout(this.#linger);
		this.#wanted = false;
		this.#host.document?.removeEventListener('visibilitychange', this.#onVisible);
		this.#release();
	}

	#acquire(): void {
		const { wakeLock, document } = this.#host;
		if (!wakeLock || this.held || this.#requesting || !this.#wanted) return;
		// Only a visible page may hold it: the visibility listener asks again later.
		if (document && document.visibilityState !== 'visible') return;
		this.#requesting = true;
		wakeLock
			.request('screen')
			.then((sentinel) => {
				this.#requesting = false;
				if (!this.#wanted) {
					void sentinel.release().catch(() => {});
					return;
				}
				this.#sentinel = sentinel;
				sentinel.addEventListener('release', () => {
					if (this.#sentinel === sentinel) this.#sentinel = null;
				});
			})
			.catch(() => {
				// Refused (battery saver, a policy, the page hidden meanwhile): the screen sleeps
				// as usual, and the next visibility change or play asks again.
				this.#requesting = false;
			});
	}

	#release(): void {
		const sentinel = this.#sentinel;
		this.#sentinel = null;
		if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
	}
}
