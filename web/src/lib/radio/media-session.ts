// The Media Session API: what the OS shows as "now playing" (lock screen, Control Centre,
// headphone and keyboard media keys). Everything is feature-checked and wrapped, since
// support varies and some actions throw where unsupported.

export interface NowPlayingInfo {
	title: string;
	artist: string;
	/** "Venue · Fri 3 Oct": where and when they're playing. */
	album: string;
	artwork: string | null;
}

function session(): MediaSession | null {
	return typeof navigator !== 'undefined' && 'mediaSession' in navigator
		? navigator.mediaSession
		: null;
}

export function setNowPlaying(info: NowPlayingInfo | null): void {
	const ms = session();
	if (!ms) return;
	try {
		ms.metadata =
			info && typeof MediaMetadata !== 'undefined'
				? new MediaMetadata({
						title: info.title,
						artist: info.artist,
						album: info.album,
						artwork: info.artwork ? [{ src: info.artwork, sizes: '544x544' }] : []
					})
				: null;
	} catch {
		// ignore
	}
}

export function setPlaybackState(state: MediaSessionPlaybackState): void {
	const ms = session();
	if (ms) ms.playbackState = state;
}

export function setPositionState(duration: number, position: number): void {
	const ms = session();
	if (!ms?.setPositionState || !(duration > 0)) return;
	try {
		ms.setPositionState({
			duration,
			position: Math.min(Math.max(0, position), duration),
			playbackRate: 1
		});
	} catch {
		// ignore
	}
}

export type MediaHandlers = Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;

/** Installs `handlers`; the returned function removes them. */
export function bindMediaActions(handlers: MediaHandlers): () => void {
	const ms = session();
	if (!ms) return () => {};
	const bound: MediaSessionAction[] = [];
	for (const [action, handler] of Object.entries(handlers) as [
		MediaSessionAction,
		MediaSessionActionHandler
	][]) {
		try {
			ms.setActionHandler(action, handler);
			bound.push(action);
		} catch {
			// action not supported here
		}
	}
	return () => {
		for (const action of bound) {
			try {
				ms.setActionHandler(action, null);
			} catch {
				// ignore
			}
		}
	};
}
