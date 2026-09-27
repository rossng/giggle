// The page's side of in-browser Kokoro: one worker per page (kokoro.worker.ts), rendered
// lines cached by voice + text so a line prepared ahead plays at once, and playback through
// Web Audio. Loading is lazy: nothing downloads until something asks for the model.

import type { Device, Dtype, KokoroReply, KokoroRequest } from './protocol';

export type KokoroStatus = 'off' | 'loading' | 'ready' | 'failed';

export interface Rendered {
	samples: Float32Array;
	sampleRate: number;
	seconds: number;
	/** How long synthesis took, in ms (0 when it came from the cache). */
	ms: number;
	/** Of which: text → phonemes. */
	phonemeMs: number;
	phonemes: string;
}

export interface KokoroState {
	status: KokoroStatus;
	device: Device | null;
	dtype: Dtype | null;
	/** Download progress while loading, 0–1. */
	progress: number;
	loadMs: number | null;
	error: string | null;
	/** The last few syntheses: text length, audio seconds, time taken. */
	recent: { text: string; seconds: number; ms: number }[];
}

export interface KokoroOptions {
	device: Device | 'auto';
	dtype: Dtype | 'auto';
	lexiconUrl: string;
}

export interface RenderOptions {
	/** About to be said (not just prepared ahead): goes before everything that isn't. */
	urgent?: boolean;
	speed?: number;
	/**
	 * Wanted until this aborts. A line still waiting for the worker when everyone who
	 * asked for it has given up is dropped (its promise rejects with an AbortError) and
	 * never rendered. Once the worker has it, it's finished and cached as usual.
	 */
	signal?: AbortSignal | undefined;
}

const CACHE_SIZE = 40;

/** Someone who asked for a line: to say now (`urgent`) or ahead, until `signal` aborts. */
interface Holder {
	urgent: boolean;
	signal: AbortSignal | undefined;
	off: () => void;
}

interface Job {
	key: string;
	text: string;
	voice: string;
	speed: number;
	/** Where it sits in the queue: with the urgent ones (first), or after them. */
	urgent: boolean;
	holders: Holder[];
	promise: Promise<Rendered>;
	resolve: (r: Rendered) => void;
	reject: (e: Error) => void;
}

const live = (h: Holder) => !h.signal?.aborted;
const notWanted = () => new DOMException('No longer wanted', 'AbortError');

/** Makes the page's Kokoro worker (tests pass a fake). */
export type WorkerFactory = () => Worker;

const kokoroWorker: WorkerFactory = () =>
	new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' });

export class KokoroVoice {
	state: KokoroState = {
		status: 'off',
		device: null,
		dtype: null,
		progress: 0,
		loadMs: null,
		error: null,
		recent: []
	};
	readonly options: Readonly<KokoroOptions>;
	#worker: Worker | null = null;
	#nextId = 1;
	/** Lines waiting for the worker, urgent ones first; it gets one at a time. */
	#queue: Job[] = [];
	#inFlight = new Map<number, Job>();
	#cache = new Map<string, Promise<Rendered>>();
	#loaded: Promise<void> | null = null;
	#files = new Map<string, { loaded: number; total: number }>();
	#listeners = new Set<(state: KokoroState) => void>();
	#ctx: AudioContext | null = null;
	#source: AudioBufferSourceNode | null = null;
	readonly #createWorker: WorkerFactory;

	constructor(options: Partial<KokoroOptions> & { worker?: WorkerFactory } = {}) {
		this.options = {
			device: options.device ?? 'auto',
			dtype: options.dtype ?? 'auto',
			lexiconUrl: options.lexiconUrl ?? '/data/pronunciation.json'
		};
		this.#createWorker = options.worker ?? kokoroWorker;
	}

	subscribe(listener: (state: KokoroState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.state);
		return () => this.#listeners.delete(listener);
	}

	#set(patch: Partial<KokoroState>): void {
		this.state = { ...this.state, ...patch };
		for (const fn of this.#listeners) fn(this.state);
	}

	/** Starts the download and model load (once); resolves when ready, rejects on failure. */
	load(): Promise<void> {
		this.#loaded ??= new Promise<void>((resolve, reject) => {
			this.#set({ status: 'loading', progress: 0, error: null });
			const worker = this.#createWorker();
			this.#worker = worker;
			worker.onmessage = (event: MessageEvent<KokoroReply>) => {
				const msg = event.data;
				if (msg.type === 'progress') {
					this.#files.set(msg.file, { loaded: msg.loaded, total: msg.total });
					let loaded = 0;
					let total = 0;
					for (const f of this.#files.values()) {
						loaded += f.loaded;
						total += f.total;
					}
					this.#set({ progress: total ? loaded / total : 0 });
				} else if (msg.type === 'ready') {
					this.#set({
						status: 'ready',
						device: msg.device,
						dtype: msg.dtype,
						progress: 1,
						loadMs: msg.ms
					});
					console.info(
						`kokoro: ${msg.device} ${msg.dtype} ready in ${(msg.ms / 1000).toFixed(1)} s`
					);
					resolve();
					this.#pump();
				} else if (msg.type === 'failed') {
					this.#set({ status: 'failed', error: msg.message });
					console.error('kokoro: failed to load', msg.message);
					reject(new Error(msg.message));
					for (const job of this.#queue.splice(0)) this.#settle(job, new Error(msg.message));
				} else if (msg.type === 'audio') {
					const job = this.#inFlight.get(msg.id);
					this.#inFlight.delete(msg.id);
					if (job)
						this.#settle(job, {
							samples: msg.samples,
							sampleRate: msg.sampleRate,
							seconds: msg.samples.length / msg.sampleRate,
							ms: msg.ms,
							phonemeMs: msg.phonemeMs,
							phonemes: msg.phonemes
						});
					this.#pump();
				} else if (msg.type === 'error') {
					const job = this.#inFlight.get(msg.id);
					this.#inFlight.delete(msg.id);
					if (job) this.#settle(job, new Error(msg.message));
					this.#pump();
				}
			};
			worker.onerror = (event) => {
				this.#set({ status: 'failed', error: event.message || 'worker error' });
				reject(new Error(event.message));
			};
			void fetch(this.options.lexiconUrl)
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null)
				.then((data) => this.#send({ type: 'lexicon', data }));
			this.#send({ type: 'load', device: this.options.device, dtype: this.options.dtype });
		});
		return this.#loaded;
	}

	#send(msg: KokoroRequest): void {
		this.#worker?.postMessage(msg);
	}

	/**
	 * Renders `text` in `voice` (cached; a repeat returns the same audio with ms 0).
	 * `urgent`: it's about to be said, so it goes before lines only prepared ahead.
	 * `signal`: see `RenderOptions`; asking again for a waiting line adds to who wants it.
	 */
	render(
		text: string,
		voice: string,
		{ urgent = false, speed = 1, signal }: RenderOptions = {}
	): Promise<Rendered> {
		const key = `${voice}|${speed}|${text}`;
		const hit = this.#cache.get(key);
		if (hit) {
			this.#cache.delete(key); // most recent last
			this.#cache.set(key, hit);
			const waiting = this.#queue.find((j) => j.promise === hit);
			if (waiting && !signal?.aborted) {
				this.#hold(waiting, urgent, signal);
				this.#place(waiting);
			}
			return hit.then((r) => ({ ...r, ms: 0 }));
		}
		if (signal?.aborted) return Promise.reject(notWanted());
		void this.load().catch(() => {});
		let resolve!: (r: Rendered) => void;
		let reject!: (e: Error) => void;
		const promise = new Promise<Rendered>((res, rej) => ((resolve = res), (reject = rej)));
		const job: Job = { key, text, voice, speed, urgent, holders: [], promise, resolve, reject };
		this.#cache.set(key, promise);
		while (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
		promise.then(
			(r) => {
				const recent = [{ text, seconds: r.seconds, ms: r.ms }, ...this.state.recent].slice(0, 20);
				this.#set({ recent });
				console.info(
					`kokoro: ${(r.ms / 1000).toFixed(2)} s for ${r.seconds.toFixed(1)} s of audio ` +
						`(${(r.ms / 1000 / r.seconds).toFixed(2)}× real time; phonemes ${r.phonemeMs.toFixed(0)} ms): ${text}`
				);
			},
			() => this.#forget(job)
		);
		if (this.state.status === 'failed') {
			this.#settle(job, new Error('Kokoro failed to load'));
			return promise;
		}
		this.#hold(job, urgent, signal);
		this.#place(job);
		this.#pump();
		return promise;
	}

	/** Lines waiting for the worker, first to go first. */
	get waiting(): readonly string[] {
		return this.#queue.map((j) => j.text);
	}

	#hold(job: Job, urgent: boolean, signal: AbortSignal | undefined): void {
		if (job.holders.some((h) => h.urgent === urgent && h.signal === signal)) return;
		const onAbort = () => this.#release(job);
		signal?.addEventListener('abort', onAbort, { once: true });
		job.holders.push({ urgent, signal, off: () => signal?.removeEventListener('abort', onAbort) });
	}

	/** Puts a new or waiting job with the urgent ones (first) if anyone wants it now. */
	#place(job: Job): void {
		const urgent = job.holders.some((h) => h.urgent && live(h));
		const i = this.#queue.indexOf(job);
		if (i >= 0) {
			if (job.urgent === urgent) return;
			this.#queue.splice(i, 1);
		}
		job.urgent = urgent;
		const at = urgent ? this.#queue.findIndex((j) => !j.urgent) : -1;
		this.#queue.splice(at < 0 ? this.#queue.length : at, 0, job);
	}

	/** Someone gave up on `job`: drop it if it's still waiting and nobody wants it. */
	#release(job: Job): void {
		const i = this.#queue.indexOf(job);
		if (i < 0) return; // with the worker already: it'll be cached
		if (job.holders.some(live)) return this.#place(job); // maybe no longer urgent
		this.#queue.splice(i, 1);
		this.#settle(job, notWanted());
	}

	#settle(job: Job, result: Rendered | Error): void {
		for (const h of job.holders) h.off();
		if (result instanceof Error) {
			this.#forget(job); // at once, so asking again renders it afresh
			job.reject(result);
		} else job.resolve(result);
	}

	#forget(job: Job): void {
		if (this.#cache.get(job.key) === job.promise) this.#cache.delete(job.key);
	}

	#pump(): void {
		if (this.state.status !== 'ready' || this.#inFlight.size) return;
		const job = this.#queue.shift();
		if (!job) return;
		const id = this.#nextId++;
		this.#inFlight.set(id, job);
		this.#send({ type: 'say', id, text: job.text, voice: job.voice, speed: job.speed });
	}

	/** Call from a user gesture, so audio may play later. */
	unlock(): void {
		this.#ctx ??= new AudioContext();
		void this.#ctx.resume().catch(() => {});
	}

	/** Plays `r`; true once it has played (or was cut short), false if it couldn't play. */
	play(r: Rendered, signal: AbortSignal): Promise<boolean> {
		const ctx = (this.#ctx ??= new AudioContext());
		if (signal.aborted) return Promise.resolve(true);
		let source: AudioBufferSourceNode;
		try {
			const buffer = ctx.createBuffer(1, r.samples.length, r.sampleRate);
			buffer.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
			source = ctx.createBufferSource();
			source.buffer = buffer;
			source.connect(ctx.destination);
		} catch {
			return Promise.resolve(false);
		}
		this.#source = source;
		return new Promise((resolve) => {
			const onAbort = () => this.#stop(source);
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				if (this.#source === source) this.#source = null;
				resolve(true);
			};
			// A suspended context never ends the line: don't hold the radio up for it.
			const timer = setTimeout(done, (r.seconds + 3) * 1000);
			source.onended = done;
			signal.addEventListener('abort', onAbort);
			void ctx.resume().catch(() => {});
			source.start();
		});
	}

	stop(): void {
		if (this.#source) this.#stop(this.#source);
	}

	#stop(source: AudioBufferSourceNode): void {
		try {
			source.stop();
		} catch {
			// not started, or already stopped
		}
	}
}

let shared: KokoroVoice | null = null;

/** The page's one Kokoro (model loaded once, whichever part of the app asks first). */
export function sharedKokoro(): KokoroVoice {
	return (shared ??= new KokoroVoice());
}
