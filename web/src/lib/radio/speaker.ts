// How the announcer's lines get said. The radio only knows the `Speaker` interface. The
// stack: ClipSpeaker plays the pipeline's pre-rendered Kokoro intros (voices bf_isabella /
// bm_fable, one per artist), and hands everything else to the live voice: KokoroSpeaker
// (the same model and voices, in the browser), which falls back to Web Speech.

import type { LineKind } from '@giggle/radio-core';
import type { KokoroStatus, Rendered, RenderOptions } from '$lib/voice/kokoro';

export interface SpokenLine {
	text: string;
	kind: LineKind;
	artistKey: string;
	/** Estimated length, for timeouts. */
	seconds: number;
	/** A pre-rendered clip to play first; then only `spoken` is said live. */
	clip?: { url: string; seconds: number; spoken: string } | undefined;
}

export interface PrepareOptions {
	/** The line is no longer wanted once this aborts: work not yet started is dropped. */
	signal?: AbortSignal | undefined;
	/** It'll be said in a moment (not just maybe, later): get it ready before the rest. */
	urgent?: boolean;
}

export interface Speaker {
	/** Says `line`; resolves when done, or straight away once `signal` aborts. Never rejects. */
	speak(line: SpokenLine, signal: AbortSignal): Promise<void>;
	/** Call from a user gesture: some browsers only allow speech after one. */
	unlock?(): void;
	/** A hint that `line` will be said soon, so it can be got ready (rendered) ahead. */
	prepare?(line: SpokenLine, options?: PrepareOptions): void;
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

	prepare(line: SpokenLine, options?: PrepareOptions): void {
		const rest = ClipSpeaker.#rest(line);
		if (rest) this.live.prepare?.(rest, options);
	}

	/** What the live voice says of `line`: all of it, or the part after the clip. */
	static #rest(line: SpokenLine): SpokenLine | null {
		const clip = line.clip;
		if (!clip) return line;
		if (!clip.spoken) return null;
		const seconds = Math.max(0.5, line.seconds - clip.seconds);
		return { ...line, text: clip.spoken, seconds, clip: undefined };
	}

	async speak(line: SpokenLine, signal: AbortSignal): Promise<void> {
		const clip = line.clip;
		if (!clip) return this.live.speak(line, signal);
		// The live part gets ready while the clip plays, before anything only prepared ahead.
		this.prepare(line, { signal, urgent: true });
		const played = await this.#play(clip.url, clip.seconds, signal);
		if (signal.aborted) return;
		if (!played) return this.live.speak({ ...line, clip: undefined }, signal);
		const rest = ClipSpeaker.#rest(line);
		if (rest) await this.live.speak(rest, signal);
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

/** What KokoroSpeaker needs of `KokoroVoice` (tests use a fake). */
export interface LiveVoice {
	readonly state: { readonly status: KokoroStatus };
	load(): Promise<void>;
	render(text: string, voice: string, options?: RenderOptions): Promise<Rendered>;
	play(rendered: Rendered, signal: AbortSignal): Promise<boolean>;
	unlock(): void;
	stop(): void;
}

/** Slower than this (render time ÷ audio length) is too slow to keep up with the radio… */
const SLOW_FACTOR = 3;
/** …when it happens this many times in a row (the first render also warms up the GPU). */
const SLOW_IN_A_ROW = 2;

/** A line's sentences, rendered and played one by one: the first starts sooner. */
export function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?…])\s+(?=\S)/u)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Says lines with Kokoro in the browser, in the voice of the artist's announcer (the one
 * their clips use). A line takes about as long to render as to say, so `prepare` renders
 * lines ahead, and a line is said sentence by sentence: the first plays while the next
 * renders. A sentence that isn't ready within `maxWaitSeconds`, a failure, a model that
 * isn't loaded yet, or one too slow on this device: the rest of the line goes to `fallback`.
 */
export class KokoroSpeaker implements Speaker {
	readonly voice: LiveVoice;
	readonly fallback: Speaker;
	/** Off: everything goes to the fallback (the listener picked the browser voice). */
	enabled = true;
	/** Rendering can't keep up on this device; the fallback speaks for the rest of the visit. */
	slow = false;
	readonly #voiceFor: (artistKey: string) => string;
	readonly #maxWaitSeconds: number;
	#slowRuns = 0;

	constructor(
		voice: LiveVoice,
		fallback: Speaker,
		options: {
			/** The artist's announcer voice ("bf_isabella"; see tracks.ts `announcerOf`). */
			voiceFor: (artistKey: string) => string;
			maxWaitSeconds?: number;
		}
	) {
		this.voice = voice;
		this.fallback = fallback;
		this.#voiceFor = options.voiceFor;
		this.#maxWaitSeconds = options.maxWaitSeconds ?? 5;
	}

	/** Live lines are said with Kokoro (not handed to the fallback wholesale). */
	get active(): boolean {
		return this.enabled && !this.slow && this.voice.state.status !== 'failed';
	}

	unlock(): void {
		if (this.enabled) this.voice.unlock();
		this.fallback.unlock?.();
	}

	stop(): void {
		this.voice.stop();
		this.fallback.stop();
	}

	prepare(line: SpokenLine, { signal, urgent = false }: PrepareOptions = {}): void {
		if (!this.active || signal?.aborted) return;
		for (const r of this.#renders(line, { urgent, signal })) r.catch(() => {});
	}

	async speak(line: SpokenLine, signal: AbortSignal): Promise<void> {
		if (!this.active) return this.fallback.speak(line, signal);
		if (this.voice.state.status !== 'ready') {
			void this.voice.load().catch(() => {}); // for the next lines
			return this.#fallback(line, signal, 'model not ready');
		}
		// Wanted until the line is over, cut short or handed to the fallback: then any
		// sentence the worker hasn't started on is dropped.
		const wanted = new AbortController();
		const onAbort = () => wanted.abort();
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const parts = sentences(line.text);
			// All of them now, in order and ahead of anything only prepared.
			const renders = this.#renders(line, { urgent: true, signal: wanted.signal });
			for (const r of renders) r.catch(() => {});
			for (let i = 0; i < parts.length; i++) {
				const rendered = await this.#ready(renders[i]!, signal);
				if (signal.aborted) return;
				const played = rendered ? await this.voice.play(rendered, signal) : false;
				if (signal.aborted) return;
				if (!played) {
					wanted.abort();
					const why = rendered ? "couldn't play" : 'not ready in time';
					return await this.#fallback({ ...line, text: parts.slice(i).join(' ') }, signal, why);
				}
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			wanted.abort();
		}
	}

	#fallback(line: SpokenLine, signal: AbortSignal, why: string): Promise<void> {
		console.info(`kokoro: browser voice (${why}): ${line.text}`);
		return this.fallback.speak(line, signal);
	}

	/** The render's result, or null if it fails or isn't ready in time (or on abort). */
	#ready(render: Promise<Rendered>, signal: AbortSignal): Promise<Rendered | null> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(null), this.#maxWaitSeconds * 1000);
			const onAbort = () => finish(null);
			const finish = (r: Rendered | null) => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				resolve(r);
			};
			signal.addEventListener('abort', onAbort);
			render.then(finish, () => finish(null));
		});
	}

	/** Each sentence of `line`, rendered in its artist's voice, in order. */
	#renders(
		line: SpokenLine,
		options: { urgent: boolean; signal: AbortSignal | undefined }
	): Promise<Rendered>[] {
		const voice = this.#voiceFor(line.artistKey);
		return sentences(line.text).map((text) => this.#render(voice, text, options));
	}

	async #render(
		voice: string,
		text: string,
		options: { urgent: boolean; signal: AbortSignal | undefined }
	): Promise<Rendered> {
		const rendered = await this.voice.render(text, voice, options);
		if (rendered.ms > 0) {
			this.#slowRuns = rendered.ms / 1000 > rendered.seconds * SLOW_FACTOR ? this.#slowRuns + 1 : 0;
			if (this.#slowRuns >= SLOW_IN_A_ROW) {
				this.slow = true;
				console.warn('kokoro: too slow on this device; using the browser voice');
			}
		}
		return rendered;
	}
}
