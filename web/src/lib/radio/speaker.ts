// How the announcer's lines get said. The radio only knows the `Speaker` interface:
// today that's the browser's Web Speech API; later a clip player will play the pipeline's
// pre-rendered Kokoro clips (voices bf_isabella / bm_fable, one per artist) and fall back
// to Web Speech for lines without a clip. Both just need `speak(line, signal)`.

import type { LineKind } from '@giggle/radio-core';

export interface SpokenLine {
	text: string;
	kind: LineKind;
	artistKey: string;
	/** Estimated length, for timeouts. */
	seconds: number;
	/** A pre-rendered clip to play first; then only `spoken` is said live. */
	clip?: { url: string; seconds: number; spoken: string } | undefined;
}

export interface Speaker {
	/** Says `line`; resolves when done, or straight away once `signal` aborts. Never rejects. */
	speak(line: SpokenLine, signal: AbortSignal): Promise<void>;
	/** Call from a user gesture: some browsers only allow speech after one. */
	unlock?(): void;
	/** Stops anything being said. */
	stop(): void;
}

/** macOS and Chrome British voices, best first. */
export const PREFERRED_VOICES = [
	'Daniel',
	'Kate',
	'Serena',
	'Oliver',
	'Arthur',
	'Martha',
	'Stephanie',
	'Jamie',
	'Google UK English Male',
	'Google UK English Female'
];

export interface VoiceInfo {
	name: string;
	lang: string;
}

const isBritish = (v: VoiceInfo) => /^en[-_]GB/i.test(v.lang);

/** English voices, British first, then by name. */
export function englishVoices<V extends VoiceInfo>(voices: readonly V[]): V[] {
	return voices
		.filter((v) => /^en([-_]|$)/i.test(v.lang))
		.sort((a, b) => Number(isBritish(b)) - Number(isBritish(a)) || a.name.localeCompare(b.name));
}

/** The voice to use: `wanted` if available, else a preferred British one, else any British
 * one, else any English one. Names match on their start ("Daniel (English (United Kingdom))"). */
export function pickVoice<V extends VoiceInfo>(
	voices: readonly V[],
	wanted: string | null = null
): V | null {
	const english = englishVoices(voices);
	if (wanted) {
		const exact = english.find((v) => v.name === wanted);
		if (exact) return exact;
	}
	for (const name of PREFERRED_VOICES) {
		const found = english.find(
			(v) => isBritish(v) && (v.name === name || v.name.startsWith(`${name} (`))
		);
		if (found) return found;
	}
	return english.find(isBritish) ?? english[0] ?? null;
}

function synth(): SpeechSynthesis | null {
	try {
		return typeof speechSynthesis === 'undefined' ? null : speechSynthesis;
	} catch {
		return null;
	}
}

/** Available voices; they load asynchronously, so `onChange` fires when they arrive. */
export function watchVoices(onChange: (voices: SpeechSynthesisVoice[]) => void): () => void {
	const s = synth();
	if (!s) return () => {};
	const update = () => onChange(englishVoices(s.getVoices()));
	update();
	s.addEventListener?.('voiceschanged', update);
	return () => s.removeEventListener?.('voiceschanged', update);
}

export class WebSpeechSpeaker implements Speaker {
	/** A voice name, or null for the default British voice. */
	voiceName: string | null;
	rate: number;
	/** Kept referenced while speaking: Chrome drops `onend` for collected utterances. */
	#current: SpeechSynthesisUtterance | null = null;

	constructor(voiceName: string | null = null, rate = 1) {
		this.voiceName = voiceName;
		this.rate = rate;
	}

	get available(): boolean {
		return synth() !== null;
	}

	unlock(): void {
		// iOS Safari only speaks after a speak() inside a gesture; an empty one will do.
		const s = synth();
		if (!s || s.speaking) return;
		try {
			s.speak(new SpeechSynthesisUtterance(''));
		} catch {
			// ignore
		}
	}

	stop(): void {
		this.#current = null;
		synth()?.cancel();
	}

	speak(line: SpokenLine, signal: AbortSignal): Promise<void> {
		const s = synth();
		if (!s || signal.aborted || !line.text.trim()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const utterance = new SpeechSynthesisUtterance(line.text);
			const voice = pickVoice(s.getVoices(), this.voiceName);
			if (voice) {
				utterance.voice = voice;
				utterance.lang = voice.lang;
			} else {
				utterance.lang = 'en-GB';
			}
			utterance.rate = this.rate;
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener('abort', onAbort);
				if (this.#current === utterance) this.#current = null;
				resolve();
			};
			const onAbort = () => {
				if (this.#current === utterance) s.cancel();
				done();
			};
			utterance.onend = done;
			utterance.onerror = done;
			// Some engines never fire `end`; don't hold the music down forever.
			const timeout = setTimeout(done, (Math.max(2, line.seconds) * 2.5 + 3) * 1000);
			signal.addEventListener('abort', onAbort, { once: true });
			if (s.speaking || s.pending) s.cancel();
			this.#current = utterance;
			s.speak(utterance);
		});
	}
}

/**
 * Plays a line's pre-rendered clip (the pipeline's Kokoro intro), then has `live` say the
 * rest. Lines without a clip, and clips that fail to load, go to `live` whole.
 */
export class ClipSpeaker implements Speaker {
	readonly live: Speaker;
	readonly #makeAudio: () => HTMLAudioElement;
	#audio: HTMLAudioElement | null = null;

	constructor(live: Speaker, makeAudio: () => HTMLAudioElement = () => new Audio()) {
		this.live = live;
		this.#makeAudio = makeAudio;
	}

	unlock(): void {
		this.live.unlock?.();
		this.#audio ??= this.#makeAudio(); // created inside the gesture, so it may play later
	}

	stop(): void {
		this.#audio?.pause();
		this.live.stop();
	}

	async speak(line: SpokenLine, signal: AbortSignal): Promise<void> {
		const clip = line.clip;
		if (!clip) return this.live.speak(line, signal);
		const played = await this.#play(clip.url, clip.seconds, signal);
		if (signal.aborted) return;
		if (!played) return this.live.speak({ ...line, clip: undefined }, signal);
		if (clip.spoken) {
			const rest = Math.max(0.5, line.seconds - clip.seconds);
			await this.live.speak({ ...line, text: clip.spoken, seconds: rest, clip: undefined }, signal);
		}
	}

	/** True once the clip has played (or was cut short on purpose); false if it failed. */
	#play(url: string, seconds: number, signal: AbortSignal): Promise<boolean> {
		const audio = (this.#audio ??= this.#makeAudio());
		return new Promise((resolve) => {
			let settled = false;
			const finish = (ok: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				audio.removeEventListener('ended', onEnded);
				audio.removeEventListener('error', onError);
				signal.removeEventListener('abort', onAbort);
				resolve(ok);
			};
			const onEnded = () => finish(true);
			const onError = () => finish(false);
			const onAbort = () => {
				audio.pause();
				finish(true);
			};
			// A stalled clip mustn't hold the radio up: give up a little after its length.
			const timer = setTimeout(() => finish(true), (seconds + 3) * 1000);
			if (signal.aborted) return finish(true);
			audio.addEventListener('ended', onEnded);
			audio.addEventListener('error', onError);
			signal.addEventListener('abort', onAbort);
			audio.src = url;
			audio.play().catch(() => finish(false));
		});
	}
}
