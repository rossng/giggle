// Keeps the laptop's media keys (and headphone buttons, Control Centre…) pointed at giggle.
//
// Browsers send media keys to the Media Session of whatever most recently started playing
// audio. The music plays in YouTube's cross-origin iframe, so each new track made YouTube's
// session the target and our next/previous handlers (media-session.ts) never ran. So the page
// itself plays an inaudible loop while the radio plays, restarted just after each YouTube track
// starts (`claim`), which keeps the top-level page the most recent player.
//
// The loop is faint noise (about -72 dBFS), not digital silence: Firefox treats silent media as
// inaudible and doesn't hand it the keys. It lasts six seconds because Chrome ignores media
// shorter than about five for media controls.

const SAMPLE_RATE = 8000;
const SECONDS = 6;
const AMPLITUDE = 8; // of 32767

/** A mono 16-bit WAV of faint noise, as a blob URL. */
function noiseWav(): string {
	const samples = SAMPLE_RATE * SECONDS;
	const buffer = new ArrayBuffer(44 + samples * 2);
	const view = new DataView(buffer);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + samples * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	text(36, 'data');
	view.setUint32(40, samples * 2, true);
	for (let i = 0; i < samples; i++) {
		view.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * AMPLITUDE), true);
	}
	return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

export class MediaFocus {
	#audio: HTMLAudioElement | null = null;
	#wanted = false;

	/** Call from a user gesture (play), so the loop may start now and later. */
	unlock(): void {
		if (this.#audio || typeof Audio === 'undefined') return;
		try {
			const audio = new Audio(noiseWav());
			audio.loop = true;
			audio.preload = 'auto';
			this.#audio = audio;
		} catch {
			// no audio element here: media keys just stay with YouTube
		}
	}

	/** Music started (a new YouTube track, or a resume): be the latest player again. */
	claim(): void {
		this.#wanted = true;
		const audio = this.#audio;
		if (!audio) return;
		audio.pause();
		audio.currentTime = 0;
		void audio.play().catch(() => {});
	}

	/** Music paused or stopped: stop the loop too, so the OS shows giggle as paused. */
	release(): void {
		this.#wanted = false;
		this.#audio?.pause();
	}

	get active(): boolean {
		return this.#wanted && !!this.#audio && !this.#audio.paused;
	}
}
